// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared constants for the SDKStats Network pipeline.
 *
 * Centralizes the wire-format metric names, HTTP status-code buckets,
 * endpoint category labels, and bounded `exceptionType` strings used by
 * the network statsbeat accumulator ({@link ./networkStats}) and the
 * A365 exporter ({@link ../a365/exporter/Agent365Exporter}).
 *
 * Ideally the wire-format metric names would be imported directly from
 * the `StatsbeatCounter` enum in `@azure/monitor-opentelemetry-exporter`
 * so we have a single source of truth. That enum is currently shipped at
 * `dist/{esm,commonjs}/export/statsbeat/types.{js,d.ts}`, but the
 * package's `package.json#exports` field only publishes `.` and
 * `./package.json`, so under our `moduleResolution: NodeNext` config a
 * direct `import { StatsbeatCounter } from
 * "@azure/monitor-opentelemetry-exporter/dist/esm/export/statsbeat/types.js"`
 * fails with `TS2307: Cannot find module … or its corresponding type
 * declarations`. Until the exporter exposes the enum from its public
 * entry point (tracked upstream in
 * https://github.com/Azure/azure-sdk-for-js, sdk/monitor/monitor-opentelemetry-exporter)
 * we mirror the values here and keep them in lockstep — sending envelopes
 * under any other name returns HTTP 200 but the AzMon SDKStats backend
 * doesn't index them.
 */

// ---------------------------------------------------------------------------
// Wire-format metric names. Must match the `StatsbeatCounter` enum in
// `@azure/monitor-opentelemetry-exporter/dist/{esm,commonjs}/export/statsbeat/types.js`.
// ---------------------------------------------------------------------------

export const REQUEST_SUCCESS_NAME = "Request_Success_Count";
export const REQUEST_FAILURE_NAME = "Request_Failure_Count";
export const REQUEST_DURATION_NAME = "Request_Duration";
export const RETRY_COUNT_NAME = "Retry_Count";
export const THROTTLE_COUNT_NAME = "Throttle_Count";
export const EXCEPTION_COUNT_NAME = "Exception_Count";

/**
 * Names of registered network SDKStats metrics, in registration order.
 *
 * @internal
 */
export const NETWORK_METRIC_NAMES = [
  REQUEST_SUCCESS_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_DURATION_NAME,
  RETRY_COUNT_NAME,
  THROTTLE_COUNT_NAME,
  EXCEPTION_COUNT_NAME,
] as const;

export type NetworkMetricName = (typeof NETWORK_METRIC_NAMES)[number];

// ---------------------------------------------------------------------------
// HTTP status-code buckets per the Application Insights SDKStats Network
// specification. Used by `classifyStatusCode` and by exporter wrappers that
// need a defensive secondary classification.
// ---------------------------------------------------------------------------

export const RETRY_STATUSES: ReadonlySet<number> = new Set([
  401, 403, 408, 429, 500, 502, 503, 504,
]);
export const THROTTLE_STATUSES: ReadonlySet<number> = new Set([402, 439]);
// 206 is handled by the caller (per-envelope breakdown). 307/308 are
// followed by the HTTP client transparently and are not reported.
export const IGNORED_STATUSES: ReadonlySet<number> = new Set([206, 307, 308]);

// ---------------------------------------------------------------------------
// Endpoint category labels. Per spec, `endpoint` is a category label, not
// the destination URL.
// ---------------------------------------------------------------------------

export const A365_ENDPOINT_CATEGORY = "a365";

// ---------------------------------------------------------------------------
// Bounded set of `exceptionType` labels for `Exception_Count`.
// Cardinality must stay bounded so the SDKStats backend can index it.
// ---------------------------------------------------------------------------

export const EXC_TIMEOUT = "Timeout exception";
export const EXC_NETWORK = "Network exception";
export const EXC_CLIENT = "Client exception";
