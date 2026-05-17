// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Network statsbeat accumulator for SDK self-telemetry.
 *
 * Per-export success / failure / retry / throttle / exception counts and
 * cumulative request duration for telemetry exporters. Exporters call the
 * `record*` functions after each transmit; the {@link SdkStatsMetrics}
 * observable-gauge callbacks drain the accumulated counts on each export
 * interval.
 *
 * Mirrors `src/microsoft/opentelemetry/_sdkstats/_utils.py` from the Python
 * distro (microsoft/opentelemetry-distro-python#144).
 */

/**
 * HTTP status codes treated as throttling for SDKStats purposes.
 *
 * @internal
 */
export const THROTTLE_STATUS_CODES: ReadonlySet<number> = new Set([402]);

export const REQUEST_SUCCESS_NAME = "request_success_count";
export const REQUEST_FAILURE_NAME = "request_failure_count";
export const REQUEST_RETRY_NAME = "request_retry_count";
export const REQUEST_THROTTLE_NAME = "request_throttle_count";
export const REQUEST_EXCEPTION_NAME = "request_exception_count";
export const REQUEST_DURATION_NAME = "request_duration";

/**
 * Names of all six network statsbeat metrics, in registration order.
 *
 * @internal
 */
export const NETWORK_METRIC_NAMES = [
  REQUEST_SUCCESS_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_RETRY_NAME,
  REQUEST_THROTTLE_NAME,
  REQUEST_EXCEPTION_NAME,
  REQUEST_DURATION_NAME,
] as const;

export type NetworkMetricName = (typeof NETWORK_METRIC_NAMES)[number];

/**
 * Composite key for an aggregated network statsbeat counter.
 *
 * - Single-element tuples key on `endpoint` only (success / duration).
 * - Two-element tuples key on `[endpoint, statusCode | exceptionType]`
 *   (failure / retry / throttle / exception).
 *
 * @internal
 */
export type NetworkKey = readonly [string] | readonly [string, string];

// Single-threaded JS execution → no lock needed (Python uses one because of
// the GIL + threads; Node.js doesn't share JS objects across worker threads).
const REQUESTS_MAP: Record<NetworkMetricName, Map<string, number>> = {
  [REQUEST_SUCCESS_NAME]: new Map(),
  [REQUEST_FAILURE_NAME]: new Map(),
  [REQUEST_RETRY_NAME]: new Map(),
  [REQUEST_THROTTLE_NAME]: new Map(),
  [REQUEST_EXCEPTION_NAME]: new Map(),
  [REQUEST_DURATION_NAME]: new Map(),
};

// `Map` keys are compared by identity for arrays/objects, so we serialize
// the key tuple to a string. The `\u0000` separator can't appear in a URL
// hostname or HTTP status string, so this is unambiguous.
const KEY_SEPARATOR = "\u0000";

function encodeKey(key: NetworkKey): string {
  return key.length === 1 ? key[0] : `${key[0]}${KEY_SEPARATOR}${key[1]}`;
}

function decodeKey(encoded: string): NetworkKey {
  const sep = encoded.indexOf(KEY_SEPARATOR);
  if (sep < 0) return [encoded] as const;
  return [encoded.slice(0, sep), encoded.slice(sep + 1)] as const;
}

function bump(metric: NetworkMetricName, key: NetworkKey, value = 1): void {
  const bucket = REQUESTS_MAP[metric];
  const encoded = encodeKey(key);
  bucket.set(encoded, (bucket.get(encoded) ?? 0) + value);
}

export function recordSuccess(endpoint: string): void {
  bump(REQUEST_SUCCESS_NAME, [endpoint]);
}

export function recordFailure(endpoint: string, statusCode: number | string): void {
  bump(REQUEST_FAILURE_NAME, [endpoint, String(statusCode)]);
}

export function recordRetry(endpoint: string, statusCode: number | string): void {
  bump(REQUEST_RETRY_NAME, [endpoint, String(statusCode)]);
}

export function recordThrottle(endpoint: string, statusCode: number | string = 402): void {
  bump(REQUEST_THROTTLE_NAME, [endpoint, String(statusCode)]);
}

export function recordException(endpoint: string, exceptionType: string): void {
  bump(REQUEST_EXCEPTION_NAME, [endpoint, exceptionType]);
}

export function recordDuration(endpoint: string, durationSeconds: number): void {
  bump(REQUEST_DURATION_NAME, [endpoint], durationSeconds);
}

/**
 * Atomically return and reset the counts for `metric`.
 *
 * Used by the observable-gauge callbacks so each observation reports only
 * the delta accumulated during the export interval.
 */
export function drain(metric: NetworkMetricName): Map<NetworkKey, number> {
  const bucket = REQUESTS_MAP[metric];
  const snapshot = new Map<NetworkKey, number>();
  for (const [encoded, value] of bucket) {
    snapshot.set(decodeKey(encoded), value);
  }
  bucket.clear();
  return snapshot;
}

/**
 * @internal Test-only: clear all network statsbeat counters.
 */
export function _resetAllForTest(): void {
  for (const name of NETWORK_METRIC_NAMES) {
    REQUESTS_MAP[name].clear();
  }
}
