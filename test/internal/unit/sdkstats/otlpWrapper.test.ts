// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

import {
  NetworkStatsLogExporter,
  NetworkStatsMetricExporter,
  NetworkStatsSpanExporter,
} from "../../../../src/sdkstats/otlpWrapper.js";
import {
  REQUEST_DURATION_NAME,
  REQUEST_EXCEPTION_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_SUCCESS_NAME,
  _resetAllForTest,
  drain,
} from "../../../../src/sdkstats/networkStats.js";

// `shortHost("https://collector.example.com:4318")` strips the first
// path component, so the dimension value the wrappers record is just
// "collector". `endpoint` is the category label ("otlp").
const HOST = "collector";
const ENDPOINT = "otlp";

function setEndpointEnv(): void {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `https://collector.example.com:4318`;
}

function clearEndpointEnv(): void {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
}

function makeFakeSpanExporter(
  result: ExportResult | "throw" | Error,
): SpanExporter & { exported: number } {
  return {
    exported: 0,
    export(_spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
      this.exported++;
      if (result === "throw") {
        throw new TypeError("boom");
      }
      if (result instanceof Error) {
        cb({ code: ExportResultCode.FAILED, error: result });
        return;
      }
      cb(result);
    },
    shutdown(): Promise<void> {
      return Promise.resolve();
    },
    forceFlush(): Promise<void> {
      return Promise.resolve();
    },
  };
}

describe("sdkstats/otlpWrapper", () => {
  beforeEach(() => {
    _resetAllForTest();
    setEndpointEnv();
  });

  afterEach(() => {
    _resetAllForTest();
    clearEndpointEnv();
  });

  describe("NetworkStatsSpanExporter", () => {
    it("records success + duration on SUCCESS", async () => {
      const inner = makeFakeSpanExporter({ code: ExportResultCode.SUCCESS });
      const wrapper = new NetworkStatsSpanExporter(inner);

      await new Promise<void>((resolve) =>
        wrapper.export([], (result) => {
          expect(result.code).toBe(ExportResultCode.SUCCESS);
          resolve();
        }),
      );
      expect(inner.exported).toBe(1);

      const success = drain(REQUEST_SUCCESS_NAME);
      expect([...success.entries()]).toEqual([[[ENDPOINT, HOST], 1]]);
      const dur = drain(REQUEST_DURATION_NAME);
      expect([...dur.keys()][0]).toEqual([ENDPOINT, HOST]);
    });

    it("records failure(0) + duration on FAILED result (no HTTP status code surfaced)", async () => {
      const inner = makeFakeSpanExporter({ code: ExportResultCode.FAILED });
      const wrapper = new NetworkStatsSpanExporter(inner);
      await new Promise<void>((resolve) => wrapper.export([], () => resolve()));

      const failure = drain(REQUEST_FAILURE_NAME);
      expect([...failure.entries()]).toEqual([[[ENDPOINT, HOST, "0"], 1]]);
    });

    it("records exception + duration and re-throws on a synchronous throw", async () => {
      const inner = makeFakeSpanExporter("throw");
      const wrapper = new NetworkStatsSpanExporter(inner);

      expect(() => wrapper.export([], () => {})).toThrow(TypeError);
      const exc = drain(REQUEST_EXCEPTION_NAME);
      expect([...exc.entries()]).toEqual([[[ENDPOINT, HOST, "TypeError"], 1]]);
      const dur = drain(REQUEST_DURATION_NAME);
      expect(dur.size).toBe(1);
    });

    it("forwards forceFlush and shutdown", async () => {
      const inner = makeFakeSpanExporter({ code: ExportResultCode.SUCCESS });
      const flushSpy = vi.spyOn(inner, "forceFlush");
      const shutdownSpy = vi.spyOn(inner, "shutdown");
      const wrapper = new NetworkStatsSpanExporter(inner);
      await wrapper.forceFlush();
      await wrapper.shutdown();
      expect(flushSpy).toHaveBeenCalledOnce();
      expect(shutdownSpy).toHaveBeenCalledOnce();
    });
  });

  describe("NetworkStatsMetricExporter", () => {
    function makeMetricExporter(result: ExportResult): PushMetricExporter {
      return {
        export(_m: ResourceMetrics, cb: (r: ExportResult) => void): void {
          cb(result);
        },
        forceFlush(): Promise<void> {
          return Promise.resolve();
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
        selectAggregationTemporality(): 0 {
          return 0;
        },
      };
    }

    it("records success + duration", async () => {
      const wrapper = new NetworkStatsMetricExporter(
        makeMetricExporter({ code: ExportResultCode.SUCCESS }),
      );
      await new Promise<void>((resolve) =>
        wrapper.export({} as ResourceMetrics, () => resolve()),
      );
      expect([...drain(REQUEST_SUCCESS_NAME).entries()]).toEqual([[[ENDPOINT, HOST], 1]]);
    });

    it("forwards selectAggregationTemporality only when inner provides it", () => {
      const innerWithSelector = makeMetricExporter({ code: ExportResultCode.SUCCESS });
      const wrapperA = new NetworkStatsMetricExporter(innerWithSelector);
      expect(typeof wrapperA.selectAggregationTemporality).toBe("function");

      const innerWithoutSelector: PushMetricExporter = {
        export(_m, cb) {
          cb({ code: ExportResultCode.SUCCESS });
        },
        forceFlush() {
          return Promise.resolve();
        },
        shutdown() {
          return Promise.resolve();
        },
      };
      const wrapperB = new NetworkStatsMetricExporter(innerWithoutSelector);
      expect(wrapperB.selectAggregationTemporality).toBeUndefined();
      expect(wrapperB.selectAggregation).toBeUndefined();
    });
  });

  describe("NetworkStatsLogExporter", () => {
    function makeLogExporter(result: ExportResult): LogRecordExporter {
      return {
        export(_l: ReadableLogRecord[], cb: (r: ExportResult) => void): void {
          cb(result);
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
      };
    }

    it("records success + duration on SUCCESS", async () => {
      const wrapper = new NetworkStatsLogExporter(
        makeLogExporter({ code: ExportResultCode.SUCCESS }),
      );
      await new Promise<void>((resolve) => wrapper.export([], () => resolve()));
      expect([...drain(REQUEST_SUCCESS_NAME).entries()]).toEqual([[[ENDPOINT, HOST], 1]]);
    });

    it("records failure(0) on FAILED result", async () => {
      const wrapper = new NetworkStatsLogExporter(
        makeLogExporter({ code: ExportResultCode.FAILED }),
      );
      await new Promise<void>((resolve) => wrapper.export([], () => resolve()));
      expect([...drain(REQUEST_FAILURE_NAME).entries()]).toEqual([[[ENDPOINT, HOST, "0"], 1]]);
    });
  });

  it("falls back to 'unknown' when no OTLP endpoint env vars are set", () => {
    clearEndpointEnv();
    const wrapper = new NetworkStatsSpanExporter({
      export: (_s, cb) => cb({ code: ExportResultCode.SUCCESS }),
      shutdown: () => Promise.resolve(),
    } as SpanExporter);
    return new Promise<void>((resolve) =>
      wrapper.export([], () => {
        const success = drain(REQUEST_SUCCESS_NAME);
        expect([...success.keys()][0]).toEqual([ENDPOINT, "unknown"]);
        resolve();
      }),
    );
  });
});
