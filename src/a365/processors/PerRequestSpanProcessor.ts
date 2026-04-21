// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Buffers spans per trace and exports once the request completes.
 * Token is not stored; we export under the saved request Context so that
 * getExportToken() can read the token from the active OpenTelemetry Context at export time.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability/src/tracing/PerRequestSpanProcessor.ts
 */

import { context, trace } from "@opentelemetry/api";
import type { Context, Span } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { Logger } from "../../shared/logging/index.js";

const logger = Logger.getInstance();

function isRootSpan(span: ReadableSpan): boolean {
  return !span.parentSpanContext;
}

/**
 * Check whether this span is a root span by examining the parent context.
 * In onStart, the SDK passes a live Span (not ReadableSpan), so we check
 * whether the parent context already contains a span.
 */
function isRootSpanFromContext(ctx: Context): boolean {
  const parentSpan = trace.getSpan(ctx);
  return !parentSpan;
}

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

/**
 * Configuration options for the PerRequestSpanProcessor.
 */
export interface PerRequestSpanProcessorOptions {
  maxBufferedTraces?: number;
  maxSpansPerTrace?: number;
  maxConcurrentExports?: number;
  flushGraceMs?: number;
  maxTraceAgeMs?: number;
}

// Default values
const DEFAULT_MAX_BUFFERED_TRACES = 1000;
const DEFAULT_MAX_SPANS_PER_TRACE = 5000;
const DEFAULT_MAX_CONCURRENT_EXPORTS = 20;
const DEFAULT_FLUSH_GRACE_MS = 250;
const DEFAULT_MAX_TRACE_AGE_MS = 1800000; // 30 minutes

function parseEnvInt(envVar: string | undefined, defaultValue: number): number {
  if (envVar === undefined || envVar === "") return defaultValue;
  const parsed = parseInt(envVar, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Buffers spans per trace and exports them together once the trace completes.
 *
 * This processor supports per-request token resolution by exporting under
 * the original request Context so that getExportToken() can read the token
 * from the active OpenTelemetry Context at export time.
 */
export class PerRequestSpanProcessor implements SpanProcessor {
  private traces = new Map<string, TraceBuffer>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private isSweeping = false;

  private readonly maxBufferedTraces: number;
  private readonly maxSpansPerTrace: number;
  private readonly maxConcurrentExports: number;
  private readonly flushGraceMs: number;
  private readonly maxTraceAgeMs: number;

  private inFlightExports = 0;
  private exportWaiters: Array<() => void> = [];

  constructor(
    private readonly exporter: SpanExporter,
    options?: PerRequestSpanProcessorOptions,
  ) {
    this.maxBufferedTraces = parseEnvInt(
      process.env.A365_PER_REQUEST_MAX_TRACES,
      options?.maxBufferedTraces ?? DEFAULT_MAX_BUFFERED_TRACES,
    );
    this.maxSpansPerTrace = parseEnvInt(
      process.env.A365_PER_REQUEST_MAX_SPANS_PER_TRACE,
      options?.maxSpansPerTrace ?? DEFAULT_MAX_SPANS_PER_TRACE,
    );
    this.maxConcurrentExports = parseEnvInt(
      process.env.A365_PER_REQUEST_MAX_CONCURRENT_EXPORTS,
      options?.maxConcurrentExports ?? DEFAULT_MAX_CONCURRENT_EXPORTS,
    );
    this.flushGraceMs = parseEnvInt(
      process.env.A365_PER_REQUEST_FLUSH_GRACE_MS,
      options?.flushGraceMs ?? DEFAULT_FLUSH_GRACE_MS,
    );
    this.maxTraceAgeMs = parseEnvInt(
      process.env.A365_PER_REQUEST_MAX_TRACE_AGE_MS,
      options?.maxTraceAgeMs ?? DEFAULT_MAX_TRACE_AGE_MS,
    );
  }

  onStart(span: Span, ctx: Context): void {
    const traceId = span.spanContext().traceId;
    let buf = this.traces.get(traceId);
    if (!buf) {
      if (this.traces.size >= this.maxBufferedTraces) {
        logger.warn(
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

      logger.debug(
        `[PerRequestSpanProcessor] Trace started traceId=${traceId} maxTraceAgeMs=${this.maxTraceAgeMs}`,
      );
    }
    buf.openCount += 1;

    const root = isRootSpanFromContext(ctx);
    logger.debug(
      `[PerRequestSpanProcessor] Span start traceId=${traceId} spanId=${span.spanContext().spanId}` +
        ` root=${root} openCount=${buf.openCount}`,
    );

    // Capture a context to export under.
    if (root) {
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
      if (buf.droppedSpans === 1 || buf.droppedSpans % 100 === 0) {
        logger.warn(
          `[PerRequestSpanProcessor] Dropping ended span due to maxSpansPerTrace=${this.maxSpansPerTrace} ` +
            `traceId=${traceId} droppedSpans=${buf.droppedSpans}`,
        );
      }
    } else {
      buf.spans.push(span);
    }
    buf.openCount -= 1;
    if (buf.openCount < 0) {
      logger.warn(
        `[PerRequestSpanProcessor] openCount underflow traceId=${traceId} spanId=${span.spanContext().spanId} resettingToZero`,
      );
      buf.openCount = 0;
    }

    logger.debug(
      `[PerRequestSpanProcessor] Span end name=${span.name} traceId=${traceId} spanId=${span.spanContext().spanId}` +
        ` root=${isRootSpan(span)} openCount=${buf.openCount} rootEnded=${buf.rootEnded}`,
    );

    if (isRootSpan(span)) {
      buf.rootEnded = true;
      buf.rootEndedAtMs = Date.now();
      if (buf.openCount === 0) {
        this.flushTrace(traceId, "trace_completed");
      }
    } else if (buf.rootEnded && buf.openCount === 0) {
      this.flushTrace(traceId, "trace_completed");
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

    if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      this.sweepTimer.unref();
    }
  }

  private stopSweepTimerIfIdle(): void {
    if (this.traces.size !== 0) return;
    if (!this.sweepTimer) return;
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

      for (const [traceId, trace] of this.traces.entries()) {
        // 1) Max age safety flush
        if (now - trace.startedAtMs >= this.maxTraceAgeMs) {
          toFlush.push({ traceId, reason: "max_trace_age" });
          continue;
        }

        // 2) Root ended grace window flush
        if (trace.rootEnded && trace.openCount > 0 && trace.rootEndedAtMs) {
          if (now - trace.rootEndedAtMs >= this.flushGraceMs) {
            toFlush.push({ traceId, reason: "root_ended_grace" });
          }
        }
      }

      await Promise.all(toFlush.map((x) => this.flushTrace(x.traceId, x.reason)));
      this.stopSweepTimerIfIdle();
    } finally {
      this.isSweeping = false;
    }
  }

  private async flushTrace(traceId: string, reason: FlushReason): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    this.traces.delete(traceId);
    this.stopSweepTimerIfIdle();

    const spans = trace.spans;
    if (spans.length === 0) return;

    logger.debug(
      `[PerRequestSpanProcessor] Flushing trace traceId=${traceId} reason=${reason} spans=${spans.length} rootEnded=${trace.rootEnded}`,
    );

    if (!trace.rootCtx) {
      logger.error(
        `[PerRequestSpanProcessor] Missing rootCtx for trace ${traceId}, cannot export spans`,
      );
      return;
    }

    await this.acquireExportSlot();

    try {
      await new Promise<void>((resolve) => {
        try {
          context.with(trace.rootCtx as Context, () => {
            try {
              this.exporter.export(spans, (result) => {
                if (result.code !== 0) {
                  logger.error(
                    `[PerRequestSpanProcessor] Export failed traceId=${traceId} reason=${reason} code=${result.code}`,
                    result.error,
                  );
                } else {
                  logger.debug(
                    `[PerRequestSpanProcessor] Export succeeded traceId=${traceId} reason=${reason} spans=${spans.length}`,
                  );
                }
                resolve();
              });
            } catch (err) {
              logger.error(
                `[PerRequestSpanProcessor] Export threw traceId=${traceId} reason=${reason} spans=${spans.length}`,
                err,
              );
              resolve();
            }
          });
        } catch (err) {
          logger.error(
            `[PerRequestSpanProcessor] context.with threw traceId=${traceId} reason=${reason}`,
            err,
          );
          resolve();
        }
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
