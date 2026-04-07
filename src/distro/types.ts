// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Resource } from "@opentelemetry/resources";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { MetricReader, ViewOptions } from "@opentelemetry/sdk-metrics";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type {
  AzureMonitorOpenTelemetryOptions,
  InstrumentationOptions,
  BrowserSdkLoaderOptions,
} from "../types.js";

export type { InstrumentationOptions, BrowserSdkLoaderOptions };

/**
 * Microsoft OpenTelemetry distribution version.
 */
export const MICROSOFT_OPENTELEMETRY_VERSION = "0.1.0";

/**
 * Microsoft OpenTelemetry Options
 *
 * Top-level configuration for the Microsoft OpenTelemetry distribution.
 * Global options (resource, sampling, instrumentations, processors) live here.
 * Backend-specific options are scoped under their respective keys.
 */
export interface MicrosoftOpenTelemetryOptions {
  // ── Global options ────────────────────────────────────────────────

  /** OpenTelemetry Resource */
  resource?: Resource;
  /** The rate of telemetry items tracked that should be transmitted (Default 1.0) */
  samplingRatio?: number;
  /** The maximum number of traces to sample per second (Default 5). Set to 0 to use samplingRatio instead. */
  tracesPerSecond?: number;
  /** OpenTelemetry Instrumentations configuration */
  instrumentationOptions?: InstrumentationOptions;
  /** An array of log record processors to register to the logger provider. */
  logRecordProcessors?: LogRecordProcessor[];
  /** An array of span processors to register to the tracer provider. */
  spanProcessors?: SpanProcessor[];
  /** An array of metric readers to register to the meter provider. */
  metricReaders?: MetricReader[];
  /** An array of metric views to register to the meter provider. */
  views?: ViewOptions[];

  // ── Backend-scoped options ────────────────────────────────────────

  /** Azure Monitor configuration. When provided, Azure Monitor export is enabled. */
  azureMonitor?: AzureMonitorOpenTelemetryOptions;
}
