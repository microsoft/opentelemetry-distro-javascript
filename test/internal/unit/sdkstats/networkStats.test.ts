// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it } from "vitest";

import {
  NETWORK_METRIC_NAMES,
  REQUEST_SUCCESS_NAME,
  _resetAllForTest,
  drain,
  recordSuccess,
  shortHost,
} from "../../../../src/sdkstats/networkStats.js";

describe("sdkstats/networkStats", () => {
  beforeEach(() => {
    _resetAllForTest();
  });

  it("exposes the Request_Success_Count metric name", () => {
    expect(NETWORK_METRIC_NAMES).toEqual([REQUEST_SUCCESS_NAME]);
    expect(REQUEST_SUCCESS_NAME).toBe("Request_Success_Count");
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

  it("drain() empties the bucket atomically — second drain returns an empty map", () => {
    recordSuccess("otlp", "a.example.com");
    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(1);
    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(0);
  });

  it("_resetAllForTest() clears every bucket", () => {
    recordSuccess("otlp", "a.example.com");
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
