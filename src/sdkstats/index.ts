// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * SDK self-telemetry (SDKStats) for the Microsoft OpenTelemetry Distro.
 *
 * Backend-agnostic SDK health and usage telemetry that works regardless
 * of which export backends are enabled (Azure Monitor, OTLP, A365,
 * Console). Tracks:
 *
 * - **Features** — which distro features are active (A365, OTLP, console,
 *   live metrics, browser SDK loader, ...)
 * - **Instrumentations** — which library instrumentations are enabled
 *
 * Mirrors `src/microsoft/opentelemetry/_sdkstats/__init__.py` from the
 * Python distro.
 */

export {
  SdkStatsDistroFeature,
  SDKSTATS_DISABLED_ENV,
  APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL,
  isSdkStatsEnabled,
  setSdkStatsFeature,
  getSdkStatsFeatureFlags,
  setSdkStatsInstrumentation,
  getSdkStatsInstrumentationFlags,
  setSdkStatsShutdown,
  getSdkStatsShutdown,
} from "./state.js";

export { SdkStatsMetrics, FEATURE_TYPE_FEATURE, FEATURE_TYPE_INSTRUMENTATION } from "./metrics.js";
export type { SdkStatsMetricsOptions } from "./metrics.js";

export { SdkStatsManager } from "./manager.js";

export {
  REQUEST_SUCCESS_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_DURATION_NAME,
  RETRY_COUNT_NAME,
  THROTTLE_COUNT_NAME,
  EXCEPTION_COUNT_NAME,
  NETWORK_METRIC_NAMES,
  recordSuccess,
  recordFailure,
  recordRetry,
  recordThrottle,
  recordException,
  recordDuration,
  classifyStatusCode,
  drain,
  shortHost,
  _resetAllForTest as _resetNetworkStatsForTest,
} from "./networkStats.js";
export type { NetworkMetricName, NetworkKey, StatusCodeKind } from "./networkStats.js";

export {
  NetworkStatsSpanExporter,
  NetworkStatsMetricExporter,
  NetworkStatsLogExporter,
} from "./otlpWrapper.js";
