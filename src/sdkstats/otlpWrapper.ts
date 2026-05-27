// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Network statsbeat wrappers for OTLP exporters.
 *
 * The upstream OTLP HTTP exporters do not surface HTTP status codes — only
 * the {@link ExportResult} enum and any raised exception. The decorators
 * here capture that signal so the network statsbeat pipeline can record
 * success counts per endpoint.
 *
 * Mirrors `src/microsoft/opentelemetry/_sdkstats/_otlp_wrapper.py` from the
 * Python distro (microsoft/opentelemetry-distro-python#144).
 */

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type {
  AggregationTemporality,
  AggregationOption,
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

import { recordSuccess, recordException, recordDuration, shortHost } from "./networkStats.js";

/** Per spec, `endpoint` is a category label, not the destination URL. */
const OTLP_ENDPOINT_CATEGORY = "otlp";

/**
 * The OTLP exporters do not surface HTTP status codes — only the
 * {@link ExportResult} enum and an optional {@link ExportResult.error}.
 * We classify non-success outcomes as `Exception_Count` under a
 * deterministic exception-type label so the dimension is stable across
 * exports.
 */
const OTLP_FAILED_EXCEPTION_TYPE = "ExporterFailed";

/**
 * Resolve the short-host string for a given OTLP signal.
 *
 * The OTel HTTP exporters do not expose their endpoint on a stable public
 * field, so we read the same env-var precedence the exporters themselves
 * use ({@link https://opentelemetry.io/docs/specs/otel/protocol/exporter/}).
 * Falls back to `"unknown"` when no endpoint can be resolved (e.g. fully
 * programmatic config without env vars).
 */
function resolveShortHost(signal: "traces" | "metrics" | "logs"): string {
  const signalSpecific =
    signal === "traces"
      ? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
      : signal === "metrics"
        ? "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"
        : "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT";

  const raw = process.env[signalSpecific] ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!raw) return "unknown";
  return shortHost(raw);
}

/**
 * Common bookkeeping for an export attempt.
 *
 * Records success/exception counters and request duration regardless of
 * outcome, per the SDKStats spec ("Request_Duration ... avg request
 * duration for all requests during the scheduled interval").
 */
function wrapExport<T>(
  host: string,
  inner: (resultCallback: (result: ExportResult) => void) => void,
  resultCallback: (result: ExportResult) => void,
  _items: T,
): void {
  const start = Date.now();
  let settled = false;
  const settle = (result: ExportResult): void => {
    if (settled) return;
    settled = true;
    recordDuration(OTLP_ENDPOINT_CATEGORY, host, Date.now() - start);
    if (result.code === ExportResultCode.SUCCESS) {
      recordSuccess(OTLP_ENDPOINT_CATEGORY, host);
    } else {
      recordException(OTLP_ENDPOINT_CATEGORY, host, OTLP_FAILED_EXCEPTION_TYPE);
    }
    resultCallback(result);
  };

  try {
    inner(settle);
  } catch (err) {
    settle({
      code: ExportResultCode.FAILED,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Span exporter decorator that records network statsbeat counts.
 */
export class NetworkStatsSpanExporter implements SpanExporter {
  private readonly host: string;

  constructor(private readonly inner: SpanExporter) {
    this.host = resolveShortHost("traces");
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    wrapExport(this.host, (cb) => this.inner.export(spans, cb), resultCallback, spans);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/**
 * Metric exporter decorator that records network statsbeat counts.
 *
 * `selectAggregationTemporality` / `selectAggregation` are forwarded only
 * when the inner exporter defines them — preserving its preferences while
 * keeping our wrapper transparent to the SDK's default-aggregation logic
 * for exporters that don't.
 */
export class NetworkStatsMetricExporter implements PushMetricExporter {
  private readonly host: string;
  selectAggregationTemporality?: (instrumentType: InstrumentType) => AggregationTemporality;
  selectAggregation?: (instrumentType: InstrumentType) => AggregationOption;

  constructor(private readonly inner: PushMetricExporter) {
    this.host = resolveShortHost("metrics");
    if (inner.selectAggregationTemporality) {
      this.selectAggregationTemporality = (t) => inner.selectAggregationTemporality!(t);
    }
    if (inner.selectAggregation) {
      this.selectAggregation = (t) => inner.selectAggregation!(t);
    }
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    wrapExport(this.host, (cb) => this.inner.export(metrics, cb), resultCallback, metrics);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/**
 * Log exporter decorator that records network statsbeat counts.
 */
export class NetworkStatsLogExporter implements LogRecordExporter {
  private readonly host: string;

  constructor(private readonly inner: LogRecordExporter) {
    this.host = resolveShortHost("logs");
  }

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    wrapExport(this.host, (cb) => this.inner.export(logs, cb), resultCallback, logs);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
