// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { Agent365Exporter } from "../../../../src/a365/exporter/Agent365Exporter.js";
import {
  REQUEST_DURATION_NAME,
  REQUEST_EXCEPTION_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_RETRY_NAME,
  REQUEST_SUCCESS_NAME,
  REQUEST_THROTTLE_NAME,
  _resetAllForTest,
  drain,
  shortHost as _shortHost,
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

function fetchHost(): string {
  // Whatever URL `Agent365Exporter` POSTs to in the default config — we
  // pluck it from the captured fetch args and pass through the same
  // shortHost() transform the production code uses.
  const calls = (globalThis.fetch as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? [];
  if (calls.length === 0) return "unknown";
  const url = calls[0][0] as string;
  return _shortHost(url);
}

const ENDPOINT = "a365";

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

  it("records request_success_count + request_duration on a 2xx response", async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      headers: new Map([["x-ms-correlation-id", "c1"]]),
    });

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    const host = fetchHost();
    expect([...drain(REQUEST_SUCCESS_NAME).entries()]).toEqual([[[ENDPOINT, host], 1]]);
    const dur = drain(REQUEST_DURATION_NAME);
    expect([...dur.keys()][0]).toEqual([ENDPOINT, host]);
    expect((dur.get([ENDPOINT, host]) ?? [...dur.values()][0])).toBeGreaterThanOrEqual(0);
  });

  it("records request_retry_count for every retryable response and a final request_failure_count when retries are exhausted", async () => {
    fetchSpy.mockResolvedValue({ status: 503, headers: new Map() });
    // Speed up retries — postWithRetries does 1 initial + 3 retries = 4 attempts.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    const host = fetchHost();
    const retries = drain(REQUEST_RETRY_NAME);
    expect([...retries.entries()]).toEqual([[[ENDPOINT, host, "503"], 4]]);
    const failures = drain(REQUEST_FAILURE_NAME);
    expect([...failures.entries()]).toEqual([[[ENDPOINT, host, "503"], 1]]);
  });

  it("records request_failure_count for non-retryable, non-throttle status codes", async () => {
    fetchSpy.mockResolvedValue({ status: 404, headers: new Map() });
    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    const host = fetchHost();
    expect([...drain(REQUEST_FAILURE_NAME).entries()]).toEqual([[[ENDPOINT, host, "404"], 1]]);
    expect(drain(REQUEST_RETRY_NAME).size).toBe(0);
  });

  it("records request_throttle_count on HTTP 402", async () => {
    fetchSpy.mockResolvedValue({ status: 402, headers: new Map() });
    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    const host = fetchHost();
    expect([...drain(REQUEST_THROTTLE_NAME).entries()]).toEqual([[[ENDPOINT, host, "402"], 1]]);
    expect(drain(REQUEST_FAILURE_NAME).size).toBe(0);
  });

  it("records request_exception_count + duration when fetch rejects, on every retry", async () => {
    class AbortError extends Error {
      override name = "AbortError";
    }
    fetchSpy.mockRejectedValue(new AbortError("aborted"));
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
    await exportSpan(exporter);

    const host = fetchHost();
    const exceptions = drain(REQUEST_EXCEPTION_NAME);
    expect([...exceptions.entries()]).toEqual([[[ENDPOINT, host, "AbortError"], 4]]);
    const durations = drain(REQUEST_DURATION_NAME);
    expect([...durations.keys()][0]).toEqual([ENDPOINT, host]);
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
    expect(drain(REQUEST_DURATION_NAME).size).toBe(0);
  });
});
