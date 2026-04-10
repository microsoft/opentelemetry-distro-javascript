// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { Logger } from "../shared/logging/index.js";

const OTEL_EXPORTER_OTLP_ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
const OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
const OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT";
const OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT";

/**
 * Determines whether OTLP export should be enabled.
 *
 * OTLP is enabled when any supported OTLP endpoint environment variable is set:
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, or `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`.
 */
export function isOtlpEnabled(): boolean {
  return [
    OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
  ].some((envVar) => !!process.env[envVar]);
}

export interface OtlpComponents {
  spanProcessor?: SpanProcessor;
  metricReader?: MetricReader;
  logRecordProcessor?: LogRecordProcessor;
}

/**
 * Creates OTLP HTTP exporters for traces, metrics, and logs.
 *
 * All configuration is driven by the standard OpenTelemetry OTLP environment variables.
 * The underlying `@opentelemetry/exporter-*-otlp-http` packages read these variables
 * automatically — no programmatic config is required.
 *
 * ## Supported environment variables
 *
 * ### General (apply to all signals)
 *
 * - `OTEL_EXPORTER_OTLP_ENDPOINT`
 *     Base endpoint URL for all signals (e.g. `http://localhost:4318`).
 *     Signal paths (`/v1/traces`, `/v1/metrics`, `/v1/logs`) are appended automatically.
 *
 * - `OTEL_EXPORTER_OTLP_HEADERS`
 *     Comma-separated list of key=value pairs sent as HTTP headers on every request
 *     (e.g. `api-key=secret,x-tenant=123`).
 *
 * - `OTEL_EXPORTER_OTLP_TIMEOUT`
 *     Maximum time (in milliseconds) the exporter will wait for each export request.
 *     Default: `10000`.
 *
 * - `OTEL_EXPORTER_OTLP_COMPRESSION`
 *     Compression algorithm: `gzip` or `none`. Default: `none`.
 *
 * - `OTEL_EXPORTER_OTLP_PROTOCOL`
 *     Transport protocol. Only `http/protobuf` (default) and `http/json` are
 *     supported by the HTTP exporters used here.
 *
 * ### Traces
 *
 * - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
 *     Full endpoint URL for traces (e.g. `http://localhost:4318/v1/traces`).
 *     Overrides `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces`.
 *
 * - `OTEL_EXPORTER_OTLP_TRACES_HEADERS`
 *     Additional headers for trace exports only. Merged with `OTEL_EXPORTER_OTLP_HEADERS`.
 *
 * - `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT`
 *     Timeout for trace exports. Overrides `OTEL_EXPORTER_OTLP_TIMEOUT`.
 *
 * - `OTEL_EXPORTER_OTLP_TRACES_COMPRESSION`
 *     Compression for trace exports. Overrides `OTEL_EXPORTER_OTLP_COMPRESSION`.
 *
 * ### Metrics
 *
 * - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
 *     Full endpoint URL for metrics (e.g. `http://localhost:4318/v1/metrics`).
 *     Overrides `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/metrics`.
 *
 * - `OTEL_EXPORTER_OTLP_METRICS_HEADERS`
 *     Additional headers for metric exports only.
 *
 * - `OTEL_EXPORTER_OTLP_METRICS_TIMEOUT`
 *     Timeout for metric exports. Overrides `OTEL_EXPORTER_OTLP_TIMEOUT`.
 *
 * - `OTEL_EXPORTER_OTLP_METRICS_COMPRESSION`
 *     Compression for metric exports. Overrides `OTEL_EXPORTER_OTLP_COMPRESSION`.
 *
 * - `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`
 *     Aggregation temporality: `cumulative` (default), `delta`, or `lowmemory`.
 *
 * - `OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION`
 *     Histogram aggregation: `explicit_bucket_histogram` (default) or
 *     `base2_exponential_bucket_histogram`.
 *
 * ### Logs
 *
 * - `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
 *     Full endpoint URL for logs (e.g. `http://localhost:4318/v1/logs`).
 *     Overrides `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/logs`.
 *
 * - `OTEL_EXPORTER_OTLP_LOGS_HEADERS`
 *     Additional headers for log exports only.
 *
 * - `OTEL_EXPORTER_OTLP_LOGS_TIMEOUT`
 *     Timeout for log exports. Overrides `OTEL_EXPORTER_OTLP_TIMEOUT`.
 *
 * - `OTEL_EXPORTER_OTLP_LOGS_COMPRESSION`
 *     Compression for log exports. Overrides `OTEL_EXPORTER_OTLP_COMPRESSION`.
 */
export function createOtlpComponents(): OtlpComponents {
  const components: OtlpComponents = {};

  Logger.getInstance().info("OTLP export enabled for traces, metrics, and logs.");

  // Trace exporter — reads OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  // OTEL_EXPORTER_OTLP_HEADERS, OTEL_EXPORTER_OTLP_TRACES_HEADERS,
  // OTEL_EXPORTER_OTLP_TIMEOUT, OTEL_EXPORTER_OTLP_TRACES_TIMEOUT,
  // OTEL_EXPORTER_OTLP_COMPRESSION, OTEL_EXPORTER_OTLP_TRACES_COMPRESSION
  const traceExporter = new OTLPTraceExporter();
  components.spanProcessor = new BatchSpanProcessor(traceExporter);

  // Metric exporter — reads OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  // OTEL_EXPORTER_OTLP_HEADERS, OTEL_EXPORTER_OTLP_METRICS_HEADERS,
  // OTEL_EXPORTER_OTLP_TIMEOUT, OTEL_EXPORTER_OTLP_METRICS_TIMEOUT,
  // OTEL_EXPORTER_OTLP_COMPRESSION, OTEL_EXPORTER_OTLP_METRICS_COMPRESSION,
  // OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE,
  // OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION
  const metricExporter = new OTLPMetricExporter();
  components.metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
  });

  // Log exporter — reads OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
  // OTEL_EXPORTER_OTLP_HEADERS, OTEL_EXPORTER_OTLP_LOGS_HEADERS,
  // OTEL_EXPORTER_OTLP_TIMEOUT, OTEL_EXPORTER_OTLP_LOGS_TIMEOUT,
  // OTEL_EXPORTER_OTLP_COMPRESSION, OTEL_EXPORTER_OTLP_LOGS_COMPRESSION
  const logExporter = new OTLPLogExporter();
  components.logRecordProcessor = new BatchLogRecordProcessor(logExporter);

  return components;
}
