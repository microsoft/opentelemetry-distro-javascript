// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Network statsbeat accumulator for SDK self-telemetry.
 *
 * Per-export success counts for telemetry exporters. Exporters call
 * {@link recordSuccess} after each successful transmit; the
 * {@link SdkStatsMetrics} observable-gauge callbacks drain the
 * accumulated counts on each export interval.
 *
 * Mirrors `src/microsoft/opentelemetry/_sdkstats/_utils.py` from the Python
 * distro (microsoft/opentelemetry-distro-python#144).
 */

// Metric names must match the AzMon statsbeat backend's recognized
// schema (see `StatsbeatCounter` enum in
// `@azure/monitor-opentelemetry-exporter/dist/esm/export/statsbeat/types.js`).
// Sending envelopes under any other name returns HTTP 200 but the
// backend doesn't index them, so they're invisible in the statsbeat
// dashboards. The constants below intentionally match the wire-format
// names — do NOT rename them to lowercase.
export const REQUEST_SUCCESS_NAME = "Request_Success_Count";

/**
 * Names of registered network statsbeat metrics, in registration order.
 *
 * @internal
 */
export const NETWORK_METRIC_NAMES = [REQUEST_SUCCESS_NAME] as const;

export type NetworkMetricName = (typeof NETWORK_METRIC_NAMES)[number];

/**
 * Composite key for an aggregated network statsbeat counter.
 *
 * Per the Application Insights SDKStats spec the per-key dimensions are
 * `endpoint` (category, e.g. "otlp", "a365") and `host` (stamp-specific
 * region or hostname).
 *
 * @internal
 */
export type NetworkKey = readonly [string, string];

// Single-threaded JS execution → no lock needed (Python uses one because of
// the GIL + threads; Node.js doesn't share JS objects across worker threads).
const REQUESTS_MAP: Record<NetworkMetricName, Map<string, number>> = {
  [REQUEST_SUCCESS_NAME]: new Map(),
};

// `Map` keys are compared by identity for arrays/objects, so we serialize
// the key tuple to a string. The `\u0000` separator can't appear in a URL
// hostname or HTTP status string, so this is unambiguous.
const KEY_SEPARATOR = "\u0000";

function encodeKey(key: NetworkKey): string {
  return key.join(KEY_SEPARATOR);
}

function decodeKey(encoded: string): NetworkKey {
  const parts = encoded.split(KEY_SEPARATOR);
  return [parts[0], parts[1]] as const;
}

function bump(metric: NetworkMetricName, key: NetworkKey, value = 1): void {
  const bucket = REQUESTS_MAP[metric];
  const encoded = encodeKey(key);
  bucket.set(encoded, (bucket.get(encoded) ?? 0) + value);
}

export function recordSuccess(endpoint: string, host: string): void {
  bump(REQUEST_SUCCESS_NAME, [endpoint, host]);
}

/**
 * Compute the stamp-specific short host for the SDKStats `host` dimension.
 *
 * Mirrors `getShortHost` in the AzMon exporter's `NetworkStatsbeatMetrics`
 * but additionally strips any trailing port (`:4318`) so localhost-style
 * URLs report a clean `localhost` instead of `localhost:4318`. Examples:
 *   `https://westus2-1.in.applicationinsights.azure.com` → `westus2`
 *   `http://localhost:4318/v1/traces`                    → `localhost`
 *   `https://collector.example.com:8080`                  → `collector`
 * For non-URL inputs, returns the hostname or the raw input on failure.
 *
 * @internal
 */
export function shortHost(input: string): string {
  if (!input) return "unknown";
  let host = input;
  try {
    const hostRegex = /^https?:\/\/(?:www\.)?([^/.-]+)/;
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
