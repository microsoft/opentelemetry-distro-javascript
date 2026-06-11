// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Network SDKStats accumulator for SDK self-telemetry.
 *
 * Per-export counters and timings for telemetry exporters. Exporters call
 * the {@link recordSuccess} / {@link recordFailure} / {@link recordRetry} /
 * {@link recordThrottle} / {@link recordException} / {@link recordDuration}
 * functions after each transmit; the {@link SdkStatsMetrics}
 * observable-gauge callbacks drain the accumulated counts on each export
 * interval.
 *
 * Mirrors `src/microsoft/opentelemetry/_sdkstats/_utils.py` from the Python
 * implementation.
 */

// Wire-format metric names and the set of HTTP status-code buckets used
// below live in `./constants.js` so the A365 exporter wrapper can
// share a single source of truth. Re-exported here for backwards
// compatibility with existing imports of these symbols from
// `./networkStats.js`.
import {
  REQUEST_SUCCESS_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_DURATION_NAME,
  RETRY_COUNT_NAME,
  THROTTLE_COUNT_NAME,
  EXCEPTION_COUNT_NAME,
  NETWORK_METRIC_NAMES,
  RETRY_STATUSES,
  THROTTLE_STATUSES,
  IGNORED_STATUSES,
  type NetworkMetricName,
} from "./constants.js";

export {
  REQUEST_SUCCESS_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_DURATION_NAME,
  RETRY_COUNT_NAME,
  THROTTLE_COUNT_NAME,
  EXCEPTION_COUNT_NAME,
  NETWORK_METRIC_NAMES,
};
export type { NetworkMetricName };

/**
 * Composite key for an aggregated network SDKStats counter.
 *
 * Per the Application Insights SDKStats spec the per-key dimensions are
 * `endpoint` (category, e.g. "a365") and `host` (stamp-specific
 * region or hostname), optionally followed by a third dimension —
 * `statusCode` (failure/retry/throttle) or `exceptionType` (exception).
 *
 * @internal
 */
export type NetworkKey = readonly string[];

// Single-threaded JS execution → no lock needed (Python uses one because of
// the GIL + threads; Node.js doesn't share JS objects across worker threads).
type CounterMetricName = Exclude<NetworkMetricName, typeof REQUEST_DURATION_NAME>;

const REQUESTS_MAP: Record<CounterMetricName, Map<string, number>> = {
  [REQUEST_SUCCESS_NAME]: new Map(),
  [REQUEST_FAILURE_NAME]: new Map(),
  [RETRY_COUNT_NAME]: new Map(),
  [THROTTLE_COUNT_NAME]: new Map(),
  [EXCEPTION_COUNT_NAME]: new Map(),
};

// Duration is tracked as running sum + count so the observable-gauge
// callback can report the per-interval average (per spec).
interface DurationAccumulator {
  sum: number;
  count: number;
}
const DURATION_MAP: Map<string, DurationAccumulator> = new Map();

// `Map` keys are compared by identity for arrays/objects, so we serialize
// the key tuple to a string. The `\u0000` separator can't appear in a URL
// hostname, HTTP status code, or exception-type string, so this is
// unambiguous.
const KEY_SEPARATOR = "\u0000";

function encodeKey(key: NetworkKey): string {
  return key.join(KEY_SEPARATOR);
}

function decodeKey(encoded: string): NetworkKey {
  return encoded.split(KEY_SEPARATOR);
}

function bump(metric: CounterMetricName, key: NetworkKey, value = 1): void {
  const bucket = REQUESTS_MAP[metric];
  const encoded = encodeKey(key);
  bucket.set(encoded, (bucket.get(encoded) ?? 0) + value);
}

export function recordSuccess(endpoint: string, host: string): void {
  bump(REQUEST_SUCCESS_NAME, [endpoint, host]);
}

export function recordFailure(endpoint: string, host: string, statusCode: number | string): void {
  bump(REQUEST_FAILURE_NAME, [endpoint, host, String(statusCode)]);
}

export function recordRetry(endpoint: string, host: string, statusCode: number | string): void {
  bump(RETRY_COUNT_NAME, [endpoint, host, String(statusCode)]);
}

export function recordThrottle(endpoint: string, host: string, statusCode: number | string): void {
  bump(THROTTLE_COUNT_NAME, [endpoint, host, String(statusCode)]);
}

export function recordException(endpoint: string, host: string, exceptionType: string): void {
  bump(EXCEPTION_COUNT_NAME, [endpoint, host, exceptionType]);
}

export function recordDuration(endpoint: string, host: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const encoded = encodeKey([endpoint, host]);
  const existing = DURATION_MAP.get(encoded);
  if (existing) {
    existing.sum += durationMs;
    existing.count += 1;
  } else {
    DURATION_MAP.set(encoded, { sum: durationMs, count: 1 });
  }
}

/**
 * Classification of an HTTP status code per the Application Insights
 * SDKStats Network specification.
 *
 * - `success`: 200 (and 206 if all envelopes were accepted — handled by
 *   the caller, this helper only returns the bucket for a single response
 *   code).
 * - `retry`: 401, 403, 408, 429, 500, 502, 503, 504.
 * - `throttle`: 402, 439.
 * - `failure`: everything else (excluding redirects 307/308 which are
 *   followed transparently and never reported).
 */
export type StatusCodeKind = "success" | "retry" | "throttle" | "failure" | "ignored";

export function classifyStatusCode(status: number): StatusCodeKind {
  if (status >= 200 && status < 300 && status !== 206) return "success";
  if (IGNORED_STATUSES.has(status)) return "ignored";
  if (THROTTLE_STATUSES.has(status)) return "throttle";
  if (RETRY_STATUSES.has(status)) return "retry";
  return "failure";
}

/**
 * Compute the stamp-specific short host for the SDKStats `host` dimension.
 *
 * Mirrors `getShortHost` in the AzMon exporter's `NetworkStatsbeatMetrics` class
 * but additionally strips any trailing port (`:4318`) so localhost-style
 * URLs report a clean `localhost` instead of `localhost:4318`. Examples:
 *   `https://westus2-1.in.applicationinsights.azure.com` → `westus2`
 *   `http://localhost:4318/v1/traces`                    → `localhost`
 *   `https://collector.example.com:8080`                  → `collector`
 *   `https://my-otlp-collector.example.com`               → `my-otlp-collector`
 * For non-URL inputs, returns the hostname or the raw input on failure.
 *
 * @internal
 */
export function shortHost(input: string): string {
  if (!input) return "unknown";
  let host = input;
  try {
    const hostRegex = /^https?:\/\/(?:www\.)?([^/.]+)/;
    const res = hostRegex.exec(input);
    if (res && res.length > 1) {
      host = res[1];
    } else {
      try {
        host = new URL(input).hostname || input;
      } catch {
        host = input;
      }
    }
    host = host.replace(".in.applicationinsights.azure.com", "");
    // Strip Azure stamp suffix (e.g. westus2-1 → westus2)
    host = host.replace(/-\d+$/, "");
    const colon = host.indexOf(":");
    if (colon > 0) host = host.slice(0, colon);
  } catch {
    /* fall through */
  }
  return host;
}

/**
 * Atomically return and reset the counts for `metric`.
 *
 * Used by the observable-gauge callbacks so each observation reports only
 * the delta accumulated during the export interval.
 *
 * For {@link REQUEST_DURATION_NAME} the reported value is the average of
 * all durations recorded since the previous drain, per the spec
 * ("Request_Duration ... avg request duration during the scheduled
 * interval").
 */
export function drain(metric: NetworkMetricName): Map<NetworkKey, number> {
  const snapshot = new Map<NetworkKey, number>();
  if (metric === REQUEST_DURATION_NAME) {
    for (const [encoded, acc] of DURATION_MAP) {
      if (acc.count === 0) continue;
      snapshot.set(decodeKey(encoded), acc.sum / acc.count);
    }
    DURATION_MAP.clear();
    return snapshot;
  }
  const bucket = REQUESTS_MAP[metric];
  for (const [encoded, value] of bucket) {
    snapshot.set(decodeKey(encoded), value);
  }
  bucket.clear();
  return snapshot;
}

/**
 * @internal Test-only: clear all network SDKStats counters.
 */
export function _resetAllForTest(): void {
  for (const name of NETWORK_METRIC_NAMES) {
    if (name === REQUEST_DURATION_NAME) {
      DURATION_MAP.clear();
    } else {
      REQUESTS_MAP[name].clear();
    }
  }
}
