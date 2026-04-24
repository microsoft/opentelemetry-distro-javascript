// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context as otelContext, trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

import { PerRequestSpanProcessor } from "../../../../src/a365/processors/PerRequestSpanProcessor.js";

// ── helpers ──────────────────────────────────────────────────────────────────

type MockExporter = SpanExporter & {
  batches: ReadableSpan[][];
  callCount: number;
  resultCode: ExportResultCode;
};

function makeMockExporter(resultCode = ExportResultCode.SUCCESS): MockExporter {
  const batches: ReadableSpan[][] = [];
  let callCount = 0;
  return {
    batches,
    get callCount() {
      return callCount;
    },
    set callCount(v) {
      callCount = v;
    },
    resultCode,
    export(spans: ReadableSpan[], cb: (result: ExportResult) => void) {
      batches.push([...spans]);
      callCount++;
      cb({ code: resultCode });
    },
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build a provider that runs spans through a `PerRequestSpanProcessor`.
 * Returns the provider and its tracer for span creation.
 */
function buildProvider(processor: PerRequestSpanProcessor): {
  provider: BasicTracerProvider;
  tracer: ReturnType<BasicTracerProvider["getTracer"]>;
} {
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  return { provider, tracer: provider.getTracer("test") };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("PerRequestSpanProcessor", () => {
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(() => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    otelContext.setGlobalContextManager(contextManager);
  });

  afterEach(async () => {
    otelContext.disable();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("basic buffering and export", () => {
    it("exports all spans when root ends and no open children remain", async () => {
      const exporter = makeMockExporter();
      const processor = new PerRequestSpanProcessor(exporter);
      const { provider, tracer } = buildProvider(processor);

      const root = tracer.startSpan("root");
      const rootCtx = trace.setSpan(otelContext.active(), root);
      const child = tracer.startSpan("child", {}, rootCtx);
      child.end();
      root.end();

      await provider.shutdown();

      expect(exporter.callCount).toBe(1);
      expect(exporter.batches[0]).toHaveLength(2);
      const names = exporter.batches[0].map((s) => s.name);
      expect(names).toContain("root");
      expect(names).toContain("child");
    });

    it("exports after last child ends when root already ended", async () => {
      const exporter = makeMockExporter();
      const processor = new PerRequestSpanProcessor(exporter, { flushGraceMs: 0 });
      const { provider, tracer } = buildProvider(processor);

      const root = tracer.startSpan("root");
      const rootCtx = trace.setSpan(otelContext.active(), root);
      const child = tracer.startSpan("child", {}, rootCtx);

      // End root first, child still open
      root.end();
      expect(exporter.callCount).toBe(0);

      // Now end child — processor should detect both root ended and openCount hits 0
      child.end();

      await provider.shutdown();

      expect(exporter.callCount).toBe(1);
      expect(exporter.batches[0]).toHaveLength(2);
    });

    it("does not export a root-only span until root ends", async () => {
      const exporter = makeMockExporter();
      const processor = new PerRequestSpanProcessor(exporter);
      const { provider, tracer } = buildProvider(processor);

      const root = tracer.startSpan("root");
      // Root has not ended — nothing exported yet
      expect(exporter.callCount).toBe(0);

      root.end();
      await provider.shutdown();

      expect(exporter.callCount).toBe(1);
    });

    it("two independent traces are exported separately", async () => {
      const exporter = makeMockExporter();
      const processor = new PerRequestSpanProcessor(exporter);
      const { provider, tracer } = buildProvider(processor);

      const root1 = tracer.startSpan("root1");
      const root2 = tracer.startSpan("root2");
      root1.end();
      root2.end();

      await provider.shutdown();

      expect(exporter.callCount).toBe(2);
      // Each batch contains exactly 1 span
      expect(exporter.batches[0]).toHaveLength(1);
      expect(exporter.batches[1]).toHaveLength(1);
    });
  });

  describe("guard-rail limits", () => {
    it("drops new traces when maxBufferedTraces is reached", async () => {
      const exporter = makeMockExporter();
      const processor = new PerRequestSpanProcessor(exporter, { maxBufferedTraces: 1 });
      const { provider, tracer } = buildProvider(processor);

      // First trace fills the buffer
      const root1 = tracer.startSpan("root1");
      // Second trace should be silently dropped (buffer full)
      const root2 = tracer.startSpan("root2");

      root1.end(); // export fires for trace 1
      root2.end(); // trace 2 was never buffered, nothing to export

      await provider.shutdown();

      expect(exporter.callCount).toBe(1);
      expect(exporter.batches[0][0].name).toBe("root1");
    });

    it("drops spans that exceed maxSpansPerTrace", async () => {
      const exporter = makeMockExporter();
      const processor = new PerRequestSpanProcessor(exporter, { maxSpansPerTrace: 2 });
      const { provider, tracer } = buildProvider(processor);

      const root = tracer.startSpan("root");
      const rootCtx = trace.setSpan(otelContext.active(), root);
      const child1 = tracer.startSpan("child1", {}, rootCtx);
      const child2 = tracer.startSpan("child2", {}, rootCtx);
      const child3 = tracer.startSpan("child3", {}, rootCtx);

      child1.end();
      child2.end();
      child3.end(); // should be dropped — buffer full at maxSpansPerTrace=2
      root.end(); // root itself will be the 3rd span — also dropped

      await provider.shutdown();

      // Only 2 spans should have been exported
      expect(exporter.batches[0]).toHaveLength(2);
    });
  });

  describe("forceFlush and shutdown", () => {
    it("forceFlush exports all buffered traces immediately", async () => {
      const exporter = makeMockExporter();
      const processor = new PerRequestSpanProcessor(exporter);
      const { provider, tracer } = buildProvider(processor);

      const root = tracer.startSpan("root");
      const rootCtx = trace.setSpan(otelContext.active(), root);
      const child = tracer.startSpan("child", {}, rootCtx);
      child.end();
      // Root still open — normally nothing exported yet

      await processor.forceFlush();
      // After force flush the buffered trace should be exported
      expect(exporter.callCount).toBe(1);

      root.end(); // ends after flush — trace already gone, no-op
      await provider.shutdown();
    });

    it("shutdown flushes pending traces and calls exporter.shutdown", async () => {
      const exporter = makeMockExporter();
      const processor = new PerRequestSpanProcessor(exporter);
      const { provider, tracer } = buildProvider(processor);

      const root = tracer.startSpan("root");
      const rootCtx = trace.setSpan(otelContext.active(), root);
      const child = tracer.startSpan("child", {}, rootCtx);
      child.end();

      await provider.shutdown(); // triggers processor.shutdown internally

      expect(exporter.callCount).toBe(1);
      expect(exporter.shutdown).toHaveBeenCalledOnce();
    });
  });

  describe("sweep timer: grace period flush", () => {
    it("flushes trace via grace period when children outlive root", async () => {
      vi.useFakeTimers();

      const exporter = makeMockExporter();
      const flushGraceMs = 500;
      const processor = new PerRequestSpanProcessor(exporter, {
        flushGraceMs,
        maxTraceAgeMs: 60_000,
      });
      const { tracer } = buildProvider(processor);

      const root = tracer.startSpan("root");
      const rootCtx = trace.setSpan(otelContext.active(), root);
      const child = tracer.startSpan("child", {}, rootCtx);
      root.end(); // root ends while child is still open

      expect(exporter.callCount).toBe(0);

      vi.advanceTimersByTime(flushGraceMs);
      await vi.runAllTimersAsync();

      expect(exporter.callCount).toBe(1);

      child.end(); // trace already swept, ending child should be a no-op
    });

    it("flushes stale trace after maxTraceAgeMs via sweep", async () => {
      vi.useFakeTimers();

      const exporter = makeMockExporter();
      const maxTraceAgeMs = 1000;
      const processor = new PerRequestSpanProcessor(exporter, {
        maxTraceAgeMs,
        flushGraceMs: 500,
      });
      const { tracer } = buildProvider(processor);

      // Start a trace but never end it
      const root = tracer.startSpan("root");
      const rootCtx = trace.setSpan(otelContext.active(), root);
      const child = tracer.startSpan("child", {}, rootCtx);
      child.end();
      // root still open — no export yet
      expect(exporter.callCount).toBe(0);

      // Advance past maxTraceAgeMs so sweep picks it up
      vi.advanceTimersByTime(maxTraceAgeMs + 100);
      await vi.runAllTimersAsync();

      expect(exporter.callCount).toBe(1);
    });
  });

  describe("export failure handling", () => {
    it("continues without throwing on exporter failure", async () => {
      const exporter = makeMockExporter(ExportResultCode.FAILED);
      const processor = new PerRequestSpanProcessor(exporter);
      const { provider, tracer } = buildProvider(processor);

      const root = tracer.startSpan("root");
      root.end();

      // shutdown should not throw even when export fails
      await expect(provider.shutdown()).resolves.not.toThrow();
      expect(exporter.callCount).toBeGreaterThan(0);
    });
  });

  describe("concurrent export limit", () => {
    it("queues exports when maxConcurrentExports is reached", async () => {
      // Use a manual-resolve exporter to hold the first export slot open
      let resolveFirstExport!: () => void;
      let resolveFirstExportStarted!: () => void;
      const firstExportStarted = new Promise<void>((resolve) => {
        resolveFirstExportStarted = resolve;
      });
      let resolveSecondExportStarted!: () => void;
      const secondExportStarted = new Promise<void>((resolve) => {
        resolveSecondExportStarted = resolve;
      });
      let exportCount = 0;
      const batches: ReadableSpan[][] = [];

      const slowExporter: SpanExporter = {
        export(spans: ReadableSpan[], cb: (result: ExportResult) => void) {
          batches.push([...spans]);
          const idx = ++exportCount;
          if (idx === 1) {
            resolveFirstExportStarted();
            // Hold first slot open until manually released
            new Promise<void>((resolve) => {
              resolveFirstExport = resolve;
            }).then(() => cb({ code: ExportResultCode.SUCCESS }));
          } else {
            resolveSecondExportStarted();
            cb({ code: ExportResultCode.SUCCESS });
          }
        },
        shutdown: vi.fn().mockResolvedValue(undefined),
      };

      const processor = new PerRequestSpanProcessor(slowExporter, {
        maxConcurrentExports: 1,
      });
      const { tracer } = buildProvider(processor);

      // End two root spans to trigger two independent exports
      const root1 = tracer.startSpan("root1");
      const root2 = tracer.startSpan("root2");
      root1.end();
      root2.end();

      await firstExportStarted;
      expect(exportCount).toBe(1);

      // Release the first export
      resolveFirstExport();
      await secondExportStarted;

      expect(exportCount).toBe(2);
    });
  });
});
