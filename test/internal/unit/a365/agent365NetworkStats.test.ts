// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { Agent365Exporter } from "../../../../src/a365/exporter/Agent365Exporter.js";
import {
  EXCEPTION_COUNT_NAME,
  REQUEST_DURATION_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_SUCCESS_NAME,
  RETRY_COUNT_NAME,
  THROTTLE_COUNT_NAME,
  _resetAllForTest,
  drain,
} from "../../../../src/sdkstats/networkStats.js";
import { _resetA365LoggerForTest } from "../../../../src/a365/logging.js";

const TENANT_ID = "tenant-11111111-1111-1111-1111-111111111111";
const AGENT_ID = "agent-22222222-2222-2222-2222-222222222222";

function makeSpan(): ReadableSpan {
  return {
    name: "test-span",
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: "aaaabbbbccccddddeeee111122223333",
      spanId: "1111222233334444",
      traceFlags: TraceFlags.SAMPLED,
    }),
    parentSpanContext: undefined,
    startTime: [1700000000, 0],
    endTime: [1700000001, 0],
    status: { code: SpanStatusCode.OK },
    attributes: {
      "microsoft.tenant.id": TENANT_ID,
      "gen_ai.agent.id": AGENT_ID,
      "gen_ai.operation.name": "invoke_agent",
    },
    events: [],
    links: [],
    resource: { attributes: {} },
    instrumentationScope: { name: "test-scope", version: "1.0.0" },
    instrumentationLibrary: { name: "test-scope", version: "1.0.0" },
    duration: [1, 0],
    ended: true,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

function exportSpan(exporter: Agent365Exporter): Promise<number> {
  return new Promise((resolve) => exporter.export([makeSpan()], (r) => resolve(r.code)));
}

describe("Agent365Exporter network statsbeat", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.MICROSOFT_OTEL_SDKSTATS_DISABLED;
    delete process.env.APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL;
    _resetAllForTest();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    _resetAllForTest();
    _resetA365LoggerForTest();
    vi.restoreAllMocks();
  });

  it("records request_success_count on a 2xx response", async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      headers: new Map([["x-ms-correlation-id", "c1"]]),
    });

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(1);
  });

  it("does not record success on non-2xx responses", async () => {
    fetchSpy.mockResolvedValue({ status: 503, headers: new Map() });
    // Speed up retries
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(0);
  });

  it("does not record success on fetch rejection", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(0);
  });

  it("records nothing when MICROSOFT_OTEL_SDKSTATS_DISABLED=true", async () => {
    process.env.MICROSOFT_OTEL_SDKSTATS_DISABLED = "true";
    fetchSpy.mockResolvedValue({
      status: 200,
      headers: new Map(),
    });

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    expect(drain(REQUEST_SUCCESS_NAME).size).toBe(0);
  });

  it("records request_failure_count with statusCode on a non-retryable, non-throttle 4xx", async () => {
    fetchSpy.mockResolvedValue({ status: 404, headers: new Map() });

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    const failures = drain(REQUEST_FAILURE_NAME);
    expect(failures.size).toBe(1);
    const [key, count] = [...failures.entries()][0];
    expect(key[0]).toBe("a365");
    expect(key[2]).toBe("404");
    expect(count).toBe(1);
  });

  it("records retry_count once per retryable response (with statusCode)", async () => {
    fetchSpy.mockResolvedValue({ status: 503, headers: new Map() });
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    const retries = drain(RETRY_COUNT_NAME);
    expect(retries.size).toBe(1);
    const [key, count] = [...retries.entries()][0];
    expect(key[2]).toBe("503");
    // DEFAULT_MAX_RETRIES = 3 → 4 total attempts, all 503.
    expect(count).toBe(4);
  });

  it("records throttle_count with statusCode on 439 (pure throttle status)", async () => {
    // Per the SDKStats spec, THROTTLE_STATUSES = {402, 439}. 429 is classified
    // as retry (not throttle) — classifyStatusCode checks THROTTLE_STATUSES
    // first, then RETRY_STATUSES, and 429 only appears in the retry set.
    fetchSpy.mockResolvedValue({ status: 439, headers: new Map() });
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    const throttles = drain(THROTTLE_COUNT_NAME);
    expect(throttles.size).toBe(1);
    const [key] = [...throttles.entries()][0];
    expect(key[2]).toBe("439");
  });

  it("records exception_count when fetch rejects", async () => {
    fetchSpy.mockRejectedValue(new Error("boom"));
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    const exceptions = drain(EXCEPTION_COUNT_NAME);
    expect(exceptions.size).toBe(1);
    const [key, count] = [...exceptions.entries()][0];
    expect(key[0]).toBe("a365");
    // 4 attempts (initial + 3 retries) each throw.
    expect(count).toBe(4);
  });

  it("records request_duration on each attempt regardless of outcome", async () => {
    fetchSpy.mockResolvedValue({ status: 200, headers: new Map() });

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    const durations = drain(REQUEST_DURATION_NAME);
    expect(durations.size).toBe(1);
    const [key, avg] = [...durations.entries()][0];
    expect(key[0]).toBe("a365");
    expect(avg).toBeGreaterThanOrEqual(0);
  });
});
