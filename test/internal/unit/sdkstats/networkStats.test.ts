// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it } from "vitest";

import {
  NETWORK_METRIC_NAMES,
  REQUEST_DURATION_NAME,
  REQUEST_EXCEPTION_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_RETRY_NAME,
  REQUEST_SUCCESS_NAME,
  REQUEST_THROTTLE_NAME,
  THROTTLE_STATUS_CODES,
  _resetAllForTest,
  drain,
  recordDuration,
  recordException,
  recordFailure,
  recordRetry,
  recordSuccess,
  recordThrottle,
} from "../../../../src/sdkstats/networkStats.js";

describe("sdkstats/networkStats", () => {
  beforeEach(() => {
    _resetAllForTest();
  });

  it("exposes 6 metric names matching the Python distro", () => {
    expect(NETWORK_METRIC_NAMES).toEqual([
      REQUEST_SUCCESS_NAME,
      REQUEST_FAILURE_NAME,
      REQUEST_RETRY_NAME,
      REQUEST_THROTTLE_NAME,
      REQUEST_EXCEPTION_NAME,
      REQUEST_DURATION_NAME,
    ]);
    expect(REQUEST_SUCCESS_NAME).toBe("Request_Success_Count");
    expect(REQUEST_DURATION_NAME).toBe("Request_Duration");
    expect(THROTTLE_STATUS_CODES.has(402)).toBe(true);
  });

  it("accumulates success counts per (endpoint, host) and reports keys as two-element tuples", () => {
    recordSuccess("otlp", "a.example.com");
    recordSuccess("otlp", "a.example.com");
    recordSuccess("otlp", "b.example.com");
    const snap = drain(REQUEST_SUCCESS_NAME);
    expect(snap.size).toBe(2);

    const entries = Array.from(snap.entries()).sort(([a], [b]) => a[1].localeCompare(b[1]));
    expect(entries[0][0]).toEqual(["otlp", "a.example.com"]);
    expect(entries[0][1]).toBe(2);
    expect(entries[1][0]).toEqual(["otlp", "b.example.com"]);
    expect(entries[1][1]).toBe(1);
  });

  it("keys failure/retry/throttle/exception by [endpoint, host, second-attr]", () => {
    recordFailure("otlp", "a.example.com", 503);
    recordFailure("otlp", "a.example.com", 503);
    recordFailure("otlp", "a.example.com", 502);
    recordRetry("otlp", "a.example.com", 429);
    recordThrottle("otlp", "a.example.com");
    recordException("otlp", "a.example.com", "AbortError");
    recordException("otlp", "a.example.com", "AbortError");

    const failures = drain(REQUEST_FAILURE_NAME);
    const flat = [...failures.entries()].map(([k, v]) => [k.join("|"), v] as const);
    expect(flat).toEqual(
      expect.arrayContaining([
        ["otlp|a.example.com|503", 2],
        ["otlp|a.example.com|502", 1],
      ]),
    );

    const retries = drain(REQUEST_RETRY_NAME);
    expect([...retries.values()]).toEqual([1]);
    const [retryKey] = [...retries.keys()];
    expect(retryKey).toEqual(["otlp", "a.example.com", "429"]);

    const throttles = drain(REQUEST_THROTTLE_NAME);
    expect([...throttles.keys()][0]).toEqual(["otlp", "a.example.com", "402"]);

    const exceptions = drain(REQUEST_EXCEPTION_NAME);
    expect([...exceptions.entries()]).toEqual([
      [["otlp", "a.example.com", "AbortError"], 2],
    ]);
  });

  it("accumulates duration as a sum of seconds", () => {
    recordDuration("otlp", "a.example.com", 0.25);
    recordDuration("otlp", "a.example.com", 1.0);
    recordDuration("otlp", "b.example.com", 2.5);
    const snap = drain(REQUEST_DURATION_NAME);
    const flat = Object.fromEntries([...snap.entries()].map(([k, v]) => [k[1], v]));
    expect(flat["a.example.com"]).toBeCloseTo(1.25);
    expect(flat["b.example.com"]).toBeCloseTo(2.5);
  });

  it("drain() empties the bucket atomically — second drain returns an empty map", () => {
    recordSuccess("otlp", "a.example.com");
    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(1);
    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(0);
  });

  it("_resetAllForTest() clears every bucket", () => {
    recordSuccess("otlp", "a.example.com");
    recordFailure("otlp", "a.example.com", 500);
    recordDuration("otlp", "a.example.com", 1.0);
    _resetAllForTest();
    for (const name of NETWORK_METRIC_NAMES) {
      expect(drain(name).size).toBe(0);
    }
  });
});
