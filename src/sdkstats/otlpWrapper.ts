// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Network statsbeat wrappers for OTLP exporters.
 *
 * The upstream OTLP HTTP exporters do not surface HTTP status codes — only
 * the {@link ExportResult} enum and any raised exception. The decorators
 * here capture that signal so the network statsbeat pipeline can record
 * success / failure / exception / duration counts per endpoint.
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

import {
  recordDuration,
  recordException,
  recordFailure,
  recordSuccess,
} from "./networkStats.js";

/**
 * Resolve the destination hostname for a given OTLP signal.
 *
 * The OTel HTTP exporters do not expose their endpoint on a stable public
 * field, so we read the same env-var precedence the exporters themselves
 * use ({@link https://opentelemetry.io/docs/specs/otel/protocol/exporter/}).
 * Falls back to `"unknown"` when no endpoint can be resolved (e.g. fully
 * programmatic config without env vars).
 */
function resolveEndpointHost(signal: "traces" | "metrics" | "logs"): string {
  const signalSpecific =
    signal === "traces"
      ? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
      : signal === "metrics"
        ? "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"
        : "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT";

  const raw = process.env[signalSpecific] ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!raw) return "unknown";

  try {
    return new URL(raw).hostname || raw;
  } catch {
    return raw;
  }
}

/**
 * Common bookkeeping for an export attempt.
 *
 * The OTel JS exporter contract is callback-based, not promise-based, and
 * the HTTP exporters surface no status code — only an {@link ExportResult}.
 * On `ExportResultCode.SUCCESS` we record a success; otherwise we record
 * failure with a placeholder `statusCode=0` (matching the Python distro).
 * Synchronous throws and async-completed errors are both recorded as
 * exceptions keyed by the error class name.
 */
function wrapExport<T>(
  endpoint: string,
  inner: (resultCallback: (result: ExportResult) => void) => void,
  resultCallback: (result: ExportResult) => void,
  _items: T,
): void {
  const start = Date.now();
  let settled = false;
  const settle = (result: ExportResult): void => {
    if (settled) return;
    settled = true;
    recordDuration(endpoint, (Date.now() - start) / 1000);
    if (result.code === ExportResultCode.SUCCESS) {
      recordSuccess(endpoint);
    } else {
      // The HTTP exporters don't expose an HTTP status code, so record
      // failures with statusCode=0 (matches Python distro).
      recordFailure(endpoint, 0);
    }
    resultCallback(result);
  };

  try {
    inner(settle);
  } catch (err) {
    settled = true;
    recordDuration(endpoint, (Date.now() - start) / 1000);
    recordException(endpoint, errorName(err));
    throw err;
  }
}

function errorName(err: unknown): string {
  if (err instanceof Error) {
    return err.name || err.constructor.name || "Error";
  }
  return typeof err;
}

/**
 * Span exporter decorator that records network statsbeat counts.
 */
export class NetworkStatsSpanExporter implements SpanExporter {
  private readonly endpoint: string;

  constructor(private readonly inner: SpanExporter) {
    this.endpoint = resolveEndpointHost("traces");
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    wrapExport(
      this.endpoint,
      (cb) => this.inner.export(spans, cb),
      resultCallback,
      spans,
    );
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
  private readonly endpoint: string;
  selectAggregationTemporality?: (instrumentType: InstrumentType) => AggregationTemporality;
  selectAggregation?: (instrumentType: InstrumentType) => AggregationOption;

  constructor(private readonly inner: PushMetricExporter) {
    this.endpoint = resolveEndpointHost("metrics");
    if (inner.selectAggregationTemporality) {
      this.selectAggregationTemporality = (t) => inner.selectAggregationTemporality!(t);
    }
    if (inner.selectAggregation) {
      this.selectAggregation = (t) => inner.selectAggregation!(t);
    }
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    wrapExport(
      this.endpoint,
      (cb) => this.inner.export(metrics, cb),
      resultCallback,
      metrics,
    );
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
  private readonly endpoint: string;

  constructor(private readonly inner: LogRecordExporter) {
    this.endpoint = resolveEndpointHost("logs");
  }

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    wrapExport(
      this.endpoint,
      (cb) => this.inner.export(logs, cb),
      resultCallback,
      logs,
    );
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
