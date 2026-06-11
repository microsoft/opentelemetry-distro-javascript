// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it } from "vitest";

import {
  EXCEPTION_COUNT_NAME,
  NETWORK_METRIC_NAMES,
  REQUEST_DURATION_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_SUCCESS_NAME,
  RETRY_COUNT_NAME,
  THROTTLE_COUNT_NAME,
  _resetAllForTest,
  classifyStatusCode,
  drain,
  recordDuration,
  recordException,
  recordFailure,
  recordRetry,
  recordSuccess,
  recordThrottle,
  shortHost,
} from "../../../../src/sdkstats/networkStats.js";
import {
  A365_ENDPOINT_CATEGORY,
  EXC_NETWORK,
  EXC_TIMEOUT,
} from "../../../../src/sdkstats/constants.js";

describe("sdkstats/networkStats", () => {
  beforeEach(() => {
    _resetAllForTest();
  });

  it("exposes all six SDKStats network metric names", () => {
    expect(NETWORK_METRIC_NAMES).toEqual([
      REQUEST_SUCCESS_NAME,
      REQUEST_FAILURE_NAME,
      REQUEST_DURATION_NAME,
      RETRY_COUNT_NAME,
      THROTTLE_COUNT_NAME,
      EXCEPTION_COUNT_NAME,
    ]);
    expect(REQUEST_SUCCESS_NAME).toBe("Request_Success_Count");
    expect(REQUEST_FAILURE_NAME).toBe("Request_Failure_Count");
    expect(REQUEST_DURATION_NAME).toBe("Request_Duration");
    expect(RETRY_COUNT_NAME).toBe("Retry_Count");
    expect(THROTTLE_COUNT_NAME).toBe("Throttle_Count");
    expect(EXCEPTION_COUNT_NAME).toBe("Exception_Count");
  });

  it("records failure/retry/throttle counts keyed by (endpoint, host, statusCode)", () => {
    recordFailure(A365_ENDPOINT_CATEGORY, "westus", 400);
    recordFailure(A365_ENDPOINT_CATEGORY, "westus", 400);
    recordFailure(A365_ENDPOINT_CATEGORY, "westus", 404);
    recordRetry(A365_ENDPOINT_CATEGORY, "westus", 503);
    recordThrottle(A365_ENDPOINT_CATEGORY, "westus", 429);

    const failures = drain(REQUEST_FAILURE_NAME);
    expect(failures.size).toBe(2);
    expect(failures.get([...failures.keys()].find((k) => k[2] === "400")!)).toBe(2);
    expect(failures.get([...failures.keys()].find((k) => k[2] === "404")!)).toBe(1);

    const retries = drain(RETRY_COUNT_NAME);
    expect([...retries.entries()]).toEqual([[[A365_ENDPOINT_CATEGORY, "westus", "503"], 1]]);

    const throttles = drain(THROTTLE_COUNT_NAME);
    expect([...throttles.entries()]).toEqual([[[A365_ENDPOINT_CATEGORY, "westus", "429"], 1]]);
  });

  it("records exception counts keyed by (endpoint, host, exceptionType)", () => {
    recordException(A365_ENDPOINT_CATEGORY, "collector", EXC_TIMEOUT);
    recordException(A365_ENDPOINT_CATEGORY, "collector", EXC_TIMEOUT);
    recordException(A365_ENDPOINT_CATEGORY, "collector", EXC_NETWORK);

    const exceptions = drain(EXCEPTION_COUNT_NAME);
    expect(exceptions.size).toBe(2);
    const entries = [...exceptions.entries()].sort(([a], [b]) => a[2].localeCompare(b[2]));
    expect(entries).toEqual([
      [[A365_ENDPOINT_CATEGORY, "collector", EXC_NETWORK], 1],
      [[A365_ENDPOINT_CATEGORY, "collector", EXC_TIMEOUT], 2],
    ]);
  });

  it("recordDuration averages recorded durations per (endpoint, host) on drain", () => {
    recordDuration(A365_ENDPOINT_CATEGORY, "westus", 100);
    recordDuration(A365_ENDPOINT_CATEGORY, "westus", 300);
    recordDuration(A365_ENDPOINT_CATEGORY, "eastus", 50);

    const durations = drain(REQUEST_DURATION_NAME);
    expect(durations.size).toBe(2);
    const map = new Map([...durations.entries()].map(([k, v]) => [k[1], v]));
    expect(map.get("westus")).toBe(200);
    expect(map.get("eastus")).toBe(50);

    // Second drain is empty (atomic reset).
    expect(drain(REQUEST_DURATION_NAME).size).toBe(0);
  });

  it("recordDuration ignores negative or non-finite values", () => {
    recordDuration(A365_ENDPOINT_CATEGORY, "westus", -1);
    recordDuration(A365_ENDPOINT_CATEGORY, "westus", NaN);
    recordDuration(A365_ENDPOINT_CATEGORY, "westus", Infinity);
    expect(drain(REQUEST_DURATION_NAME).size).toBe(0);
  });

  describe("classifyStatusCode", () => {
    it("buckets 2xx (except 206) as success", () => {
      expect(classifyStatusCode(200)).toBe("success");
      expect(classifyStatusCode(204)).toBe("success");
      expect(classifyStatusCode(206)).toBe("ignored");
    });

    it("buckets retryable statuses correctly", () => {
      for (const s of [401, 403, 408, 429, 500, 502, 503, 504]) {
        expect(classifyStatusCode(s)).toBe("retry");
      }
    });

    it("buckets throttle statuses correctly", () => {
      expect(classifyStatusCode(402)).toBe("throttle");
      expect(classifyStatusCode(439)).toBe("throttle");
    });

    it("treats 307/308 redirects as ignored", () => {
      expect(classifyStatusCode(307)).toBe("ignored");
      expect(classifyStatusCode(308)).toBe("ignored");
    });

    it("treats other 4xx/5xx as failure", () => {
      expect(classifyStatusCode(400)).toBe("failure");
      expect(classifyStatusCode(404)).toBe("failure");
      expect(classifyStatusCode(501)).toBe("failure");
    });
  });

  it("accumulates success counts per (endpoint, host) and reports keys as two-element tuples", () => {
    recordSuccess(A365_ENDPOINT_CATEGORY, "a.example.com");
    recordSuccess(A365_ENDPOINT_CATEGORY, "a.example.com");
    recordSuccess(A365_ENDPOINT_CATEGORY, "b.example.com");
    const snap = drain(REQUEST_SUCCESS_NAME);
    expect(snap.size).toBe(2);

    const entries = Array.from(snap.entries()).sort(([a], [b]) => a[1].localeCompare(b[1]));
    expect(entries[0][0]).toEqual([A365_ENDPOINT_CATEGORY, "a.example.com"]);
    expect(entries[0][1]).toBe(2);
    expect(entries[1][0]).toEqual([A365_ENDPOINT_CATEGORY, "b.example.com"]);
    expect(entries[1][1]).toBe(1);
  });

  it("drain() empties the bucket atomically — second drain returns an empty map", () => {
    recordSuccess(A365_ENDPOINT_CATEGORY, "a.example.com");
    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(1);
    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(0);
  });

  it("_resetAllForTest() clears every bucket", () => {
    recordSuccess(A365_ENDPOINT_CATEGORY, "a.example.com");
    _resetAllForTest();
    for (const name of NETWORK_METRIC_NAMES) {
      expect(drain(name).size).toBe(0);
    }
  });

  describe("shortHost", () => {
    it("extracts the Azure region from an AzMon ingestion URL", () => {
      expect(shortHost("https://westus2-1.in.applicationinsights.azure.com")).toBe("westus2");
    });

    it("strips the port from localhost URLs", () => {
      expect(shortHost("http://localhost:4318/v1/traces")).toBe("localhost");
    });

    it("extracts the first label from a plain hostname URL", () => {
      expect(shortHost("https://collector.example.com:8080")).toBe("collector");
    });

    it("preserves hyphens in non-Azure hostnames", () => {
      expect(shortHost("https://my-otlp-collector.example.com")).toBe("my-otlp-collector");
      expect(shortHost("https://otel-collector-prod.example.com:4318")).toBe("otel-collector-prod");
    });

    it("returns 'unknown' for empty input", () => {
      expect(shortHost("")).toBe("unknown");
    });

    it("returns the raw input for non-URL strings", () => {
      expect(shortHost("not-a-url")).toBe("not-a-url");
    });
  });
});
