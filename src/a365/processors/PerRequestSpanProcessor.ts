// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, trace, type Context, type Span } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor, SpanExporter } from "@opentelemetry/sdk-trace-base";

import { getA365Logger } from "../logging.js";

type TraceBuffer = {
  spans: ReadableSpan[];
  openCount: number;
  rootEnded: boolean;
  rootCtx?: Context;
  startedAtMs: number;
  rootEndedAtMs?: number;
  droppedSpans: number;
};

type FlushReason = "trace_completed" | "root_ended_grace" | "max_trace_age" | "force_flush";

export interface PerRequestSpanProcessorOptions {
  maxBufferedTraces?: number;
  maxSpansPerTrace?: number;
  maxConcurrentExports?: number;
  flushGraceMs?: number;
  maxTraceAgeMs?: number;
}

const DEFAULT_MAX_BUFFERED_TRACES = 1000;
const DEFAULT_MAX_SPANS_PER_TRACE = 5000;
const DEFAULT_MAX_CONCURRENT_EXPORTS = 20;
const DEFAULT_FLUSH_GRACE_MS = 250;
const DEFAULT_MAX_TRACE_AGE_MS = 30 * 60 * 1000;

function isRootSpan(span: ReadableSpan): boolean {
  return !span.parentSpanContext;
}

function isRootSpanFromContext(ctx: Context): boolean {
  const parentSpan = trace.getSpan(ctx);
  return !parentSpan;
}

/**
 * Buffers spans per trace and exports once the request completes.
 */
export class PerRequestSpanProcessor implements SpanProcessor {
  private traces = new Map<string, TraceBuffer>();
  private sweepTimer?: NodeJS.Timeout;
  private isSweeping = false;

  private readonly maxBufferedTraces: number;
  private readonly maxSpansPerTrace: number;
  private readonly maxConcurrentExports: number;
  private readonly flushGraceMs: number;
  private readonly maxTraceAgeMs: number;

  private inFlightExports = 0;
  private exportWaiters: Array<() => void> = [];
  private readonly logger = getA365Logger();

  constructor(
    private readonly exporter: SpanExporter,
    options?: PerRequestSpanProcessorOptions,
  ) {
    this.maxBufferedTraces = options?.maxBufferedTraces ?? DEFAULT_MAX_BUFFERED_TRACES;
    this.maxSpansPerTrace = options?.maxSpansPerTrace ?? DEFAULT_MAX_SPANS_PER_TRACE;
    this.maxConcurrentExports = options?.maxConcurrentExports ?? DEFAULT_MAX_CONCURRENT_EXPORTS;
    this.flushGraceMs = options?.flushGraceMs ?? DEFAULT_FLUSH_GRACE_MS;
    this.maxTraceAgeMs = options?.maxTraceAgeMs ?? DEFAULT_MAX_TRACE_AGE_MS;
  }

  onStart(span: Span, ctx: Context): void {
    const traceId = span.spanContext().traceId;
    let buf = this.traces.get(traceId);
    if (!buf) {
      if (this.traces.size >= this.maxBufferedTraces) {
        this.logger.warn(
          `[PerRequestSpanProcessor] Dropping new trace due to maxBufferedTraces=${this.maxBufferedTraces} traceId=${traceId}`,
        );
        return;
      }

      buf = {
        spans: [],
        openCount: 0,
        rootEnded: false,
        rootCtx: undefined,
        startedAtMs: Date.now(),
        droppedSpans: 0,
      };
      this.traces.set(traceId, buf);
      this.ensureSweepTimer();
    }

    buf.openCount += 1;

    if (isRootSpanFromContext(ctx)) {
      buf.rootCtx = ctx;
    } else {
      buf.rootCtx ??= ctx;
    }
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    const buf = this.traces.get(traceId);
    if (!buf) return;

    if (buf.spans.length >= this.maxSpansPerTrace) {
      buf.droppedSpans += 1;
    } else {
      buf.spans.push(span);
    }

    buf.openCount -= 1;
    if (buf.openCount < 0) {
      buf.openCount = 0;
    }

    if (isRootSpan(span)) {
      buf.rootEnded = true;
      buf.rootEndedAtMs = Date.now();
      if (buf.openCount === 0) {
        void this.flushTrace(traceId, "trace_completed");
      }
    } else if (buf.rootEnded && buf.openCount === 0) {
      void this.flushTrace(traceId, "trace_completed");
    }
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.traces.keys()].map((id) => this.flushTrace(id, "force_flush")));
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.stopSweepTimerIfIdle();
    await this.exporter.shutdown?.();
  }

  private ensureSweepTimer(): void {
    if (this.sweepTimer) return;

    const intervalMs = Math.max(10, Math.min(this.flushGraceMs, 250));
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  private stopSweepTimerIfIdle(): void {
    if (this.traces.size !== 0 || !this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private async sweep(): Promise<void> {
    if (this.isSweeping) return;
    this.isSweeping = true;
    try {
      if (this.traces.size === 0) {
        this.stopSweepTimerIfIdle();
        return;
      }

      const now = Date.now();
      const toFlush: Array<{ traceId: string; reason: FlushReason }> = [];

      for (const [traceId, traceBuffer] of this.traces.entries()) {
        if (now - traceBuffer.startedAtMs >= this.maxTraceAgeMs) {
          toFlush.push({ traceId, reason: "max_trace_age" });
          continue;
        }

        if (
          traceBuffer.rootEnded &&
          traceBuffer.openCount > 0 &&
          traceBuffer.rootEndedAtMs &&
          now - traceBuffer.rootEndedAtMs >= this.flushGraceMs
        ) {
          toFlush.push({ traceId, reason: "root_ended_grace" });
        }
      }

      await Promise.all(toFlush.map((item) => this.flushTrace(item.traceId, item.reason)));
      this.stopSweepTimerIfIdle();
    } finally {
      this.isSweeping = false;
    }
  }

  private async flushTrace(traceId: string, reason: FlushReason): Promise<void> {
    const traceBuffer = this.traces.get(traceId);
    if (!traceBuffer) return;

    this.traces.delete(traceId);
    this.stopSweepTimerIfIdle();

    const spans = traceBuffer.spans;
    if (spans.length === 0 || !traceBuffer.rootCtx) {
      return;
    }

    await this.acquireExportSlot();
    try {
      await new Promise<void>((resolve) => {
        context.with(traceBuffer.rootCtx as Context, () => {
          try {
            this.exporter.export(spans, (result) => {
              if (result.code !== 0) {
                this.logger.error(
                  `[PerRequestSpanProcessor] Export failed traceId=${traceId} reason=${reason} code=${result.code}`,
                  result.error,
                );
              }
              resolve();
            });
          } catch (err) {
            this.logger.error(
              `[PerRequestSpanProcessor] Export threw traceId=${traceId} reason=${reason}`,
              err,
            );
            resolve();
          }
        });
      });
    } finally {
      this.releaseExportSlot();
    }
  }

  private async acquireExportSlot(): Promise<void> {
    if (this.maxConcurrentExports <= 0) return;
    if (this.inFlightExports < this.maxConcurrentExports) {
      this.inFlightExports += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.exportWaiters.push(() => {
        this.inFlightExports += 1;
        resolve();
      });
    });
  }

  private releaseExportSlot(): void {
    if (this.maxConcurrentExports <= 0) return;
    this.inFlightExports = Math.max(0, this.inFlightExports - 1);
    const next = this.exportWaiters.shift();
    if (next) next();
  }
}
