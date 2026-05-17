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
    expect(REQUEST_SUCCESS_NAME).toBe("request_success_count");
    expect(REQUEST_DURATION_NAME).toBe("request_duration");
    expect(THROTTLE_STATUS_CODES.has(402)).toBe(true);
  });

  it("accumulates success counts per endpoint and reports keys as single-element tuples", () => {
    recordSuccess("a.example.com");
    recordSuccess("a.example.com");
    recordSuccess("b.example.com");
    const snap = drain(REQUEST_SUCCESS_NAME);
    expect(snap.size).toBe(2);

    const entries = Array.from(snap.entries()).sort(([a], [b]) => a[0].localeCompare(b[0]));
    expect(entries[0][0]).toEqual(["a.example.com"]);
    expect(entries[0][1]).toBe(2);
    expect(entries[1][0]).toEqual(["b.example.com"]);
    expect(entries[1][1]).toBe(1);
  });

  it("keys failure/retry/throttle/exception by [endpoint, second-attr]", () => {
    recordFailure("a.example.com", 503);
    recordFailure("a.example.com", 503);
    recordFailure("a.example.com", 502);
    recordRetry("a.example.com", 429);
    recordThrottle("a.example.com");
    recordException("a.example.com", "AbortError");
    recordException("a.example.com", "AbortError");

    const failures = drain(REQUEST_FAILURE_NAME);
    expect(failures.get(["a.example.com", "503"]) ??
      [...failures.entries()].find(([k]) => k[0] === "a.example.com" && k[1] === "503")?.[1]).toBe(
      2,
    );
    // Map equality on tuple keys: identity-based; verify by spreading.
    const flat = [...failures.entries()].map(([k, v]) => [k.join("|"), v] as const);
    expect(flat).toEqual(
      expect.arrayContaining([
        ["a.example.com|503", 2],
        ["a.example.com|502", 1],
      ]),
    );

    const retries = drain(REQUEST_RETRY_NAME);
    expect([...retries.values()]).toEqual([1]);
    const [retryKey] = [...retries.keys()];
    expect(retryKey).toEqual(["a.example.com", "429"]);

    const throttles = drain(REQUEST_THROTTLE_NAME);
    expect([...throttles.keys()][0]).toEqual(["a.example.com", "402"]);

    const exceptions = drain(REQUEST_EXCEPTION_NAME);
    expect([...exceptions.entries()]).toEqual([[["a.example.com", "AbortError"], 2]]);
  });

  it("accumulates duration as a sum of seconds", () => {
    recordDuration("a.example.com", 0.25);
    recordDuration("a.example.com", 1.0);
    recordDuration("b.example.com", 2.5);
    const snap = drain(REQUEST_DURATION_NAME);
    const flat = Object.fromEntries([...snap.entries()].map(([k, v]) => [k[0], v]));
    expect(flat["a.example.com"]).toBeCloseTo(1.25);
    expect(flat["b.example.com"]).toBeCloseTo(2.5);
  });

  it("drain() empties the bucket atomically — second drain returns an empty map", () => {
    recordSuccess("a.example.com");
    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(1);
    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(0);
  });

  it("_resetAllForTest() clears every bucket", () => {
    recordSuccess("a.example.com");
    recordFailure("a.example.com", 500);
    recordDuration("a.example.com", 1.0);
    _resetAllForTest();
    for (const name of NETWORK_METRIC_NAMES) {
      expect(drain(name).size).toBe(0);
    }
  });
});
