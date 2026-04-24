// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";
import { ExportResultCode } from "@opentelemetry/core";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Agent365Exporter } from "../../../../src/a365/exporter/Agent365Exporter.js";
import {
  partitionByIdentity,
  parseIdentityKey,
  hexTraceId,
  hexSpanId,
  kindName,
  statusName,
  resolveAgent365Endpoint,
  truncateSpan,
  MAX_SPAN_SIZE_BYTES,
} from "../../../../src/a365/exporter/utils.js";
import { ResolvedExporterOptions } from "../../../../src/a365/exporter/Agent365ExporterOptions.js";
import { configureA365Logger, _resetA365LoggerForTest } from "../../../../src/a365/logging.js";

const TENANT_ID = "tenant-11111111-1111-1111-1111-111111111111";
const AGENT_ID = "agent-22222222-2222-2222-2222-222222222222";

function makeSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
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
    ...overrides,
  } as unknown as ReadableSpan;
}

/** Helper: export a single span and return the parsed payload attributes. */
async function exportAndGetPayload(
  fetchSpy: ReturnType<typeof vi.fn>,
  attrs: Record<string, unknown>,
  exporterOptions?: ConstructorParameters<typeof Agent365Exporter>[0],
) {
  const exporter = new Agent365Exporter({
    tokenResolver: () => "tok",
    ...exporterOptions,
  });

  const span = makeSpan({
    attributes: {
      "microsoft.tenant.id": TENANT_ID,
      "gen_ai.agent.id": AGENT_ID,
      ...attrs,
    },
  });

  const result = await new Promise<number>((resolve) => {
    exporter.export([span], (r) => resolve(r.code));
  });

  const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
  const exportedSpan = body.resourceSpans[0].scopeSpans[0].spans[0];
  return { result, exportedSpan, span, body };
}

describe("Agent365Exporter", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Map([["x-ms-correlation-id", "corr-123"]]),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    _resetA365LoggerForTest();
    vi.restoreAllMocks();
  });

  describe("export", () => {
    it("should return success immediately with no spans", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });

      const result = await new Promise<number>((resolve) => {
        exporter.export([], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      assert.strictEqual(fetchSpy.mock.calls.length, 0);
    });

    it("should export spans successfully", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });

      const span = makeSpan();
      const result = await new Promise<number>((resolve) => {
        exporter.export([span], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      assert.strictEqual(fetchSpy.mock.calls.length, 1);

      const [url, options] = fetchSpy.mock.calls[0];
      assert.ok(url.includes(`/observability/tenants/${TENANT_ID}/otlp/agents/${AGENT_ID}/traces`));
      assert.strictEqual(options.method, "POST");
      assert.strictEqual(options.headers["authorization"], "Bearer test-token");
      assert.strictEqual(options.headers["x-ms-tenant-id"], TENANT_ID);
      assert.strictEqual(options.headers["content-type"], "application/json");
    });

    it("should use provided token resolver and set authorization header", async () => {
      const token = "abc123";
      const exporter = new Agent365Exporter({
        tokenResolver: () => token,
      });

      const span = makeSpan({
        attributes: {
          "microsoft.tenant.id": TENANT_ID,
          "gen_ai.agent.id": AGENT_ID,
          "gen_ai.caller.client_ip": "10.0.0.5",
        },
      });

      const result = await new Promise<number>((resolve) => {
        exporter.export([span], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      const [, options] = fetchSpy.mock.calls[0];
      assert.strictEqual(options.headers["authorization"], `Bearer ${token}`);

      const payload = JSON.parse(options.body);
      const exportedSpan = payload.resourceSpans[0].scopeSpans[0].spans[0];
      assert.ok(exportedSpan.attributes);
      assert.strictEqual(exportedSpan.attributes["microsoft.tenant.id"], TENANT_ID);
      assert.strictEqual(exportedSpan.attributes["gen_ai.agent.id"], AGENT_ID);
      assert.strictEqual(exportedSpan.attributes["gen_ai.caller.client_ip"], "10.0.0.5");
    });

    it("should use async token resolver", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: async () => "async-token",
      });

      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      const [, options] = fetchSpy.mock.calls[0];
      assert.strictEqual(options.headers["authorization"], "Bearer async-token");
    });

    it("should export to default prod endpoint", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "tok-prod",
      });

      await new Promise<void>((resolve) => {
        exporter.export([makeSpan()], () => resolve());
      });

      const [url] = fetchSpy.mock.calls[0];
      assert.ok(url.startsWith("https://agent365.svc.cloud.microsoft/observability/tenants/"));
      assert.ok(url.includes("/otlp/agents/"));
    });

    it("should use S2S endpoint when configured", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
        useS2SEndpoint: true,
      });

      await new Promise<void>((resolve) => {
        exporter.export([makeSpan()], () => resolve());
      });

      const [url] = fetchSpy.mock.calls[0];
      assert.ok(url.includes("/observabilityService/tenants/"));
      assert.ok(url.includes(`/otlp/agents/${AGENT_ID}/traces`));
    });

    it("should use S2S endpoint with domain override", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "tok-s2s-custom",
        useS2SEndpoint: true,
        domainOverride: "https://custom.domain",
      });

      await new Promise<void>((resolve) => {
        exporter.export([makeSpan()], () => resolve());
      });

      const [url, options] = fetchSpy.mock.calls[0];
      assert.ok(url.startsWith("https://custom.domain/observabilityService/tenants/"));
      assert.ok(url.includes("/otlp/agents/"));
      assert.strictEqual(options.headers["authorization"], "Bearer tok-s2s-custom");
      assert.strictEqual(options.headers["x-ms-tenant-id"], TENANT_ID);
    });

    it("should use domain override when configured", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
        domainOverride: "https://custom.example.com",
      });

      await new Promise<void>((resolve) => {
        exporter.export([makeSpan()], () => resolve());
      });

      const [url] = fetchSpy.mock.calls[0];
      assert.ok(url.startsWith("https://custom.example.com/"));
    });

    it("should skip export when no token resolver", async () => {
      const exporter = new Agent365Exporter({});

      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      assert.strictEqual(fetchSpy.mock.calls.length, 0);
    });

    it("should skip spans missing identity attributes", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });

      const spanNoIdentity = makeSpan({ attributes: {} });
      const result = await new Promise<number>((resolve) => {
        exporter.export([spanNoIdentity], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      assert.strictEqual(fetchSpy.mock.calls.length, 0);
    });

    it("should skip spans missing only tenant ID", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });

      const span = makeSpan({ attributes: { "gen_ai.agent.id": AGENT_ID } });
      const result = await new Promise<number>((resolve) => {
        exporter.export([span], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      assert.strictEqual(fetchSpy.mock.calls.length, 0);
    });

    it("should skip spans missing only agent ID", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });

      const span = makeSpan({ attributes: { "microsoft.tenant.id": TENANT_ID } });
      const result = await new Promise<number>((resolve) => {
        exporter.export([span], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      assert.strictEqual(fetchSpy.mock.calls.length, 0);
    });

    it("should fail after shutdown", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });

      await exporter.shutdown();

      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.FAILED);
    });

    it("should be idempotent on multiple shutdown calls", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });

      await exporter.shutdown();
      await exporter.shutdown();

      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.FAILED);
    });

    it("should support forceFlush as a no-op", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });
      // Should not throw
      await exporter.forceFlush();
    });

    it("should build correct OTLP payload", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });

      await new Promise<void>((resolve) => {
        exporter.export([makeSpan()], () => resolve());
      });

      const [, options] = fetchSpy.mock.calls[0];
      const payload = JSON.parse(options.body);

      assert.ok(payload.resourceSpans);
      assert.strictEqual(payload.resourceSpans.length, 1);
      assert.ok(payload.resourceSpans[0].scopeSpans);
      assert.strictEqual(payload.resourceSpans[0].scopeSpans.length, 1);
      assert.strictEqual(payload.resourceSpans[0].scopeSpans[0].scope.name, "test-scope");

      const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
      assert.strictEqual(span.name, "test-span");
      assert.strictEqual(span.kind, "INTERNAL");
      assert.strictEqual(span.status.code, "OK");
    });

    it("should preserve all attribute types in exported payload", async () => {
      const { exportedSpan } = await exportAndGetPayload(fetchSpy, {
        string_attr: "hello",
        number_attr: 42,
        boolean_attr: true,
        string_array_attr: ["a", "b", "c"],
        number_array_attr: [1, 2, 3],
      });

      assert.strictEqual(exportedSpan.attributes["string_attr"], "hello");
      assert.strictEqual(exportedSpan.attributes["number_attr"], 42);
      assert.strictEqual(exportedSpan.attributes["boolean_attr"], true);
      assert.deepStrictEqual(exportedSpan.attributes["string_array_attr"], ["a", "b", "c"]);
      assert.deepStrictEqual(exportedSpan.attributes["number_array_attr"], [1, 2, 3]);
    });

    it("should partition spans by identity and export separately", async () => {
      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });

      const span1 = makeSpan({
        attributes: { "microsoft.tenant.id": "t1", "gen_ai.agent.id": "a1" },
      });
      const span2 = makeSpan({
        attributes: { "microsoft.tenant.id": "t2", "gen_ai.agent.id": "a2" },
      });

      await new Promise<void>((resolve) => {
        exporter.export([span1, span2], () => resolve());
      });

      assert.strictEqual(fetchSpy.mock.calls.length, 2);
    });

    it("should include events in exported spans", async () => {
      const span = makeSpan({
        events: [
          {
            name: "test-event",
            time: [1700000000, 500000000],
            attributes: { "event.attr": "val" },
          },
        ],
      });

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      await new Promise<void>((resolve) => {
        exporter.export([span], () => resolve());
      });

      const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const exportedSpan = payload.resourceSpans[0].scopeSpans[0].spans[0];
      assert.ok(exportedSpan.events);
      assert.strictEqual(exportedSpan.events.length, 1);
      assert.strictEqual(exportedSpan.events[0].name, "test-event");
    });

    it("should include links in exported spans", async () => {
      const span = makeSpan({
        links: [
          {
            context: {
              traceId: "ddddeeeeffffaaaa1111222233334444",
              spanId: "5555666677778888",
              traceFlags: TraceFlags.SAMPLED,
            },
            attributes: { "link.attr": "val" },
          },
        ],
      });

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      await new Promise<void>((resolve) => {
        exporter.export([span], () => resolve());
      });

      const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const exportedSpan = payload.resourceSpans[0].scopeSpans[0].spans[0];
      assert.ok(exportedSpan.links);
      assert.strictEqual(exportedSpan.links.length, 1);
    });

    it("should include parent span ID when present", async () => {
      const span = makeSpan({
        parentSpanContext: {
          traceId: "aaaabbbbccccddddeeee111122223333",
          spanId: "9999aaaa0000bbbb",
          traceFlags: TraceFlags.SAMPLED,
        },
      });

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      await new Promise<void>((resolve) => {
        exporter.export([span], () => resolve());
      });

      const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const exportedSpan = payload.resourceSpans[0].scopeSpans[0].spans[0];
      assert.ok(exportedSpan.parentSpanId);
    });

    it("should pass httpRequestTimeoutMilliseconds to fetch AbortSignal.timeout", async () => {
      const customTimeout = 12345;
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

      const exporter = new Agent365Exporter({
        tokenResolver: () => "tok",
        httpRequestTimeoutMilliseconds: customTimeout,
      });

      await new Promise<void>((resolve) => {
        exporter.export([makeSpan()], () => resolve());
      });

      assert.ok(timeoutSpy.mock.calls.some((call) => call[0] === customTimeout));
      timeoutSpy.mockRestore();
    });

    it("should emit exporter and group success event logs", async () => {
      const customLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      configureA365Logger({ logger: customLogger, logLevel: "info|warn|error" });

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      await new Promise<void>((resolve) => {
        exporter.export([makeSpan()], () => resolve());
      });

      const infoLines = customLogger.info.mock.calls.map((call) => String(call[0]));
      assert.ok(
        infoLines.some(
          (line) =>
            line.includes("[EVENT]: export-group succeeded in") &&
            line.includes("Spans exported successfully") &&
            line.includes(`"tenantId":"${TENANT_ID}"`) &&
            line.includes(`"agentId":"${AGENT_ID}"`),
        ),
      );
      assert.ok(
        infoLines.some(
          (line) =>
            line.includes("[EVENT]: agent365-export succeeded in") &&
            line.includes("All spans exported successfully"),
        ),
      );
    });

    it("should emit exporter and group failure event logs", async () => {
      fetchSpy.mockResolvedValue({
        status: 400,
        headers: new Map([["x-ms-correlation-id", "corr-failure"]]),
      });

      const customLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      configureA365Logger({ logger: customLogger, logLevel: "info|warn|error" });

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.FAILED);
      const errorLines = customLogger.error.mock.calls.map((call) => String(call[0]));
      assert.ok(
        errorLines.some(
          (line) =>
            line.includes("[EVENT]: export-group failed in") &&
            line.includes(`"correlationId":"corr-failure"`),
        ),
      );
      assert.ok(
        errorLines.some(
          (line) =>
            line.includes("[EVENT]: agent365-export failed in") &&
            line.includes("One or more export groups failed"),
        ),
      );
    });
  });

  describe("retry", () => {
    it("should retry on 500 errors", async () => {
      let callCount = 0;
      fetchSpy.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({
            status: 500,
            headers: new Map([["x-ms-correlation-id", "corr"]]),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Map([["x-ms-correlation-id", "corr"]]),
        });
      });

      const exporter = new Agent365Exporter({
        tokenResolver: () => "test-token",
      });

      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      assert.ok(callCount >= 3);
    });

    it("should retry on 429 errors", async () => {
      let callCount = 0;
      fetchSpy.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.resolve({
            status: 429,
            headers: new Map([["x-ms-correlation-id", "corr"]]),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Map([["x-ms-correlation-id", "corr"]]),
        });
      });

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      assert.ok(callCount >= 2);
    });

    it("should retry on 408 errors", async () => {
      let callCount = 0;
      fetchSpy.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.resolve({
            status: 408,
            headers: new Map([["x-ms-correlation-id", "corr"]]),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Map([["x-ms-correlation-id", "corr"]]),
        });
      });

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      assert.ok(callCount >= 2);
    });

    it("should not retry on 400 errors", async () => {
      let callCount = 0;
      fetchSpy.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          status: 400,
          headers: new Map([["x-ms-correlation-id", "corr"]]),
        });
      });

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.FAILED);
      assert.strictEqual(callCount, 1);
    });

    it("should not retry on 403 errors", async () => {
      let callCount = 0;
      fetchSpy.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          status: 403,
          headers: new Map([["x-ms-correlation-id", "corr"]]),
        });
      });

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.FAILED);
      assert.strictEqual(callCount, 1);
    });

    it("should retry on network errors", async () => {
      let callCount = 0;
      fetchSpy.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error("network failure"));
        }
        return Promise.resolve({
          status: 200,
          headers: new Map([["x-ms-correlation-id", "corr"]]),
        });
      });

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.SUCCESS);
      assert.ok(callCount >= 3);
    });

    it("should fail after max retries exhausted", async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve({
          status: 500,
          headers: new Map([["x-ms-correlation-id", "corr"]]),
        }),
      );

      const exporter = new Agent365Exporter({ tokenResolver: () => "tok" });
      const result = await new Promise<number>((resolve) => {
        exporter.export([makeSpan()], (r) => resolve(r.code));
      });

      assert.strictEqual(result, ExportResultCode.FAILED);
      // DEFAULT_MAX_RETRIES = 3, so 1 initial + 3 retries = 4 total
      assert.strictEqual(fetchSpy.mock.calls.length, 4);
    });
  });
});

describe("Exporter utils", () => {
  describe("partitionByIdentity", () => {
    it("should group spans by tenant:agent key", () => {
      const spans = [
        makeSpan({ attributes: { "microsoft.tenant.id": "t1", "gen_ai.agent.id": "a1" } }),
        makeSpan({ attributes: { "microsoft.tenant.id": "t1", "gen_ai.agent.id": "a1" } }),
        makeSpan({ attributes: { "microsoft.tenant.id": "t2", "gen_ai.agent.id": "a2" } }),
      ];
      const groups = partitionByIdentity(spans);
      assert.strictEqual(groups.size, 2);
      assert.strictEqual(groups.get("t1:a1")?.length, 2);
      assert.strictEqual(groups.get("t2:a2")?.length, 1);
    });

    it("should skip spans without identity attributes", () => {
      const spans = [
        makeSpan({ attributes: {} }),
        makeSpan({ attributes: { "microsoft.tenant.id": "t1" } }),
      ];
      const groups = partitionByIdentity(spans);
      assert.strictEqual(groups.size, 0);
    });

    it("should handle empty spans array", () => {
      const groups = partitionByIdentity([]);
      assert.strictEqual(groups.size, 0);
    });

    it("should handle spans with same tenant but different agents", () => {
      const spans = [
        makeSpan({ attributes: { "microsoft.tenant.id": "t1", "gen_ai.agent.id": "a1" } }),
        makeSpan({ attributes: { "microsoft.tenant.id": "t1", "gen_ai.agent.id": "a2" } }),
      ];
      const groups = partitionByIdentity(spans);
      assert.strictEqual(groups.size, 2);
    });
  });

  describe("parseIdentityKey", () => {
    it("should split key into tenantId and agentId", () => {
      const result = parseIdentityKey("tenant-1:agent-1");
      assert.strictEqual(result.tenantId, "tenant-1");
      assert.strictEqual(result.agentId, "agent-1");
    });

    it("should handle agent IDs containing colons", () => {
      const result = parseIdentityKey("tenant-1:agent:with:colons");
      assert.strictEqual(result.tenantId, "tenant-1");
      assert.strictEqual(result.agentId, "agent:with:colons");
    });
  });

  describe("hexTraceId / hexSpanId", () => {
    it("should pad string trace IDs to 32 chars", () => {
      assert.strictEqual(hexTraceId("abc").length, 32);
    });

    it("should pad string span IDs to 16 chars", () => {
      assert.strictEqual(hexSpanId("abc").length, 16);
    });

    it("should convert numeric trace IDs", () => {
      assert.strictEqual(hexTraceId(255), "000000000000000000000000000000ff");
    });

    it("should convert numeric span IDs", () => {
      assert.strictEqual(hexSpanId(255), "00000000000000ff");
    });

    it("should strip 0x prefix from trace IDs", () => {
      const result = hexTraceId("0xabcdef");
      assert.ok(!result.includes("0x"));
      assert.strictEqual(result.length, 32);
    });

    it("should strip 0x prefix from span IDs", () => {
      const result = hexSpanId("0xabcdef");
      assert.ok(!result.includes("0x"));
      assert.strictEqual(result.length, 16);
    });

    it("should pass through already-correct-length IDs", () => {
      const traceId = "aaaabbbbccccddddeeee111122223333";
      assert.strictEqual(hexTraceId(traceId), traceId);
    });
  });

  describe("kindName / statusName", () => {
    it("should map span kinds", () => {
      assert.strictEqual(kindName(SpanKind.INTERNAL), "INTERNAL");
      assert.strictEqual(kindName(SpanKind.SERVER), "SERVER");
      assert.strictEqual(kindName(SpanKind.CLIENT), "CLIENT");
      assert.strictEqual(kindName(SpanKind.PRODUCER), "PRODUCER");
      assert.strictEqual(kindName(SpanKind.CONSUMER), "CONSUMER");
    });

    it("should return UNSPECIFIED for unknown kind", () => {
      assert.strictEqual(kindName(999 as SpanKind), "UNSPECIFIED");
    });

    it("should map status codes", () => {
      assert.strictEqual(statusName(SpanStatusCode.OK), "OK");
      assert.strictEqual(statusName(SpanStatusCode.ERROR), "ERROR");
      assert.strictEqual(statusName(SpanStatusCode.UNSET), "UNSET");
    });

    it("should return UNSET for unknown status code", () => {
      assert.strictEqual(statusName(999 as SpanStatusCode), "UNSET");
    });
  });

  describe("resolveAgent365Endpoint", () => {
    it("should return prod endpoint for prod category", () => {
      assert.strictEqual(resolveAgent365Endpoint("prod"), "https://agent365.svc.cloud.microsoft");
    });

    it("should throw for unsupported cluster categories", () => {
      assert.throws(
        () => resolveAgent365Endpoint("preprod"),
        /Unsupported Agent365 cluster category "preprod"/,
      );
    });
  });

  describe("ResolvedExporterOptions", () => {
    it("should apply defaults", () => {
      const opts = new ResolvedExporterOptions();
      assert.strictEqual(opts.clusterCategory, "prod");
      assert.strictEqual(opts.useS2SEndpoint, false);
      assert.strictEqual(opts.maxQueueSize, 2048);
      assert.strictEqual(opts.scheduledDelayMilliseconds, 5000);
      assert.strictEqual(opts.exporterTimeoutMilliseconds, 90000);
      assert.strictEqual(opts.httpRequestTimeoutMilliseconds, 30000);
      assert.strictEqual(opts.maxExportBatchSize, 512);
      assert.strictEqual(opts.domainOverride, undefined);
      assert.strictEqual(opts.tokenResolver, undefined);
    });

    it("should accept overrides", () => {
      const opts = new ResolvedExporterOptions({
        clusterCategory: "preprod",
        maxQueueSize: 1024,
        httpRequestTimeoutMilliseconds: 10000,
      });
      assert.strictEqual(opts.clusterCategory, "preprod");
      assert.strictEqual(opts.maxQueueSize, 1024);
      assert.strictEqual(opts.httpRequestTimeoutMilliseconds, 10000);
    });

    it("should accept all options", () => {
      const tokenResolver = () => "tok";
      const opts = new ResolvedExporterOptions({
        clusterCategory: "gov",
        tokenResolver,
        useS2SEndpoint: true,
        domainOverride: "https://custom.com",
        maxQueueSize: 4096,
        scheduledDelayMilliseconds: 10000,
        exporterTimeoutMilliseconds: 120000,
        httpRequestTimeoutMilliseconds: 60000,
        maxExportBatchSize: 256,
      });
      assert.strictEqual(opts.clusterCategory, "gov");
      assert.strictEqual(opts.tokenResolver, tokenResolver);
      assert.strictEqual(opts.useS2SEndpoint, true);
      assert.strictEqual(opts.domainOverride, "https://custom.com");
      assert.strictEqual(opts.maxQueueSize, 4096);
      assert.strictEqual(opts.scheduledDelayMilliseconds, 10000);
      assert.strictEqual(opts.exporterTimeoutMilliseconds, 120000);
      assert.strictEqual(opts.httpRequestTimeoutMilliseconds, 60000);
      assert.strictEqual(opts.maxExportBatchSize, 256);
    });
  });

  describe("truncateSpan", () => {
    it("should return span unchanged if under size limit", () => {
      const span = { attributes: { key: "small value" } };
      const result = truncateSpan(span);
      assert.strictEqual(result.attributes!["key"], "small value");
    });

    it("should truncate large string attributes", () => {
      const largeValue = "x".repeat(MAX_SPAN_SIZE_BYTES + 1000);
      const span = { attributes: { key: largeValue } };
      const result = truncateSpan(span);
      const size = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(
        size <= MAX_SPAN_SIZE_BYTES,
        `Truncated span is ${size} bytes, expected <= ${MAX_SPAN_SIZE_BYTES}`,
      );
      assert.ok((result.attributes!["key"] as string).endsWith("[truncated]"));
    });

    it("should trim oversized string attribute and preserve smaller attributes", () => {
      const span = {
        attributes: {
          small_string: "keep me",
          small_number: 123,
          small_boolean: false,
          small_array: ["x", "y"],
          large_string: "x".repeat(MAX_SPAN_SIZE_BYTES),
        } as Record<string, unknown>,
      };
      const result = truncateSpan(span);
      assert.ok((result.attributes!["large_string"] as string).includes("… [truncated]"));
      assert.strictEqual(result.attributes!["small_string"], "keep me");
      assert.strictEqual(result.attributes!["small_number"], 123);
      assert.strictEqual(result.attributes!["small_boolean"], false);
      assert.deepStrictEqual(result.attributes!["small_array"], ["x", "y"]);
    });

    it("should trim both large string attributes when each exceeds limit", () => {
      const span = {
        attributes: {
          "gen_ai.input.messages": "a".repeat(MAX_SPAN_SIZE_BYTES),
          "gen_ai.output.messages": "b".repeat(MAX_SPAN_SIZE_BYTES),
          small_attr: "keep me",
        } as Record<string, unknown>,
      };
      const result = truncateSpan(span);
      assert.ok((result.attributes!["gen_ai.input.messages"] as string).includes("[truncated]"));
      assert.ok((result.attributes!["gen_ai.output.messages"] as string).includes("[truncated]"));
      assert.strictEqual(result.attributes!["small_attr"], "keep me");
    });

    it("should not mutate the original span attributes", () => {
      const largeValue = "x".repeat(MAX_SPAN_SIZE_BYTES);
      const originalAttrs = { key: largeValue };
      const span = { attributes: originalAttrs };
      truncateSpan(span);
      assert.strictEqual(originalAttrs["key"], largeValue);
    });

    it("should guarantee exported span is within 250KB after truncation", () => {
      const span = {
        attributes: {
          "gen_ai.input.messages": "x".repeat(MAX_SPAN_SIZE_BYTES),
          "gen_ai.output.messages": "y".repeat(MAX_SPAN_SIZE_BYTES),
        } as Record<string, unknown>,
      };
      const result = truncateSpan(span);
      const size = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(size <= MAX_SPAN_SIZE_BYTES);
    });

    it("should truncate blob parts in message attributes", () => {
      const blobContent = "b".repeat(MAX_SPAN_SIZE_BYTES);
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [
          {
            role: "user",
            parts: [
              { type: "blob", modality: "image", mime_type: "image/png", content: blobContent },
              { type: "text", content: "Keep this text" },
            ],
          },
        ],
      });
      const span = {
        attributes: {
          "gen_ai.input.messages": messageWrapper,
          small_attr: "keep me",
        } as Record<string, unknown>,
      };
      const result = truncateSpan(span);
      const size = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(size <= MAX_SPAN_SIZE_BYTES);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      assert.strictEqual(parsed.messages[0].parts[0].content, "[blob truncated]");
      assert.strictEqual(parsed.messages[0].parts[1].content, "Keep this text");
      assert.strictEqual(result.attributes!["small_attr"], "keep me");
    });

    it("should shrink tool_call arguments with sentinel", () => {
      const largeArgs = { data: "x".repeat(MAX_SPAN_SIZE_BYTES) };
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [
          {
            role: "assistant",
            parts: [
              { type: "tool_call", name: "search", id: "call_1", arguments: largeArgs },
              { type: "text", content: "short text" },
            ],
          },
        ],
      });
      const span = { attributes: { "gen_ai.input.messages": messageWrapper } };
      const result = truncateSpan(span);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      assert.strictEqual(parsed.messages[0].parts[0].arguments, "[truncated]");
      assert.strictEqual(parsed.messages[0].parts[0].name, "search");
      assert.strictEqual(parsed.messages[0].parts[1].content, "short text");
    });

    it("should shrink tool_call_response response with sentinel", () => {
      const largeResponse = { data: "x".repeat(MAX_SPAN_SIZE_BYTES) };
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [
          {
            role: "tool",
            parts: [
              { type: "tool_call_response", id: "call_1", response: largeResponse },
              { type: "text", content: "short text" },
            ],
          },
        ],
      });
      const span = { attributes: { "gen_ai.input.messages": messageWrapper } };
      const result = truncateSpan(span);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      assert.strictEqual(parsed.messages[0].parts[0].response, "[truncated]");
      assert.strictEqual(parsed.messages[0].parts[0].id, "call_1");
      assert.strictEqual(parsed.messages[0].parts[1].content, "short text");
    });

    it("should shrink server_tool_call payload with sentinel", () => {
      const largePayload = { type: "web_search", query: "x".repeat(MAX_SPAN_SIZE_BYTES) };
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [
          {
            role: "assistant",
            parts: [
              {
                type: "server_tool_call",
                name: "web_search",
                id: "stc_1",
                server_tool_call: largePayload,
              },
              { type: "text", content: "keep me" },
            ],
          },
        ],
      });
      const span = { attributes: { "gen_ai.input.messages": messageWrapper } };
      const result = truncateSpan(span);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      assert.strictEqual(parsed.messages[0].parts[0].server_tool_call, "[truncated]");
      assert.strictEqual(parsed.messages[0].parts[0].name, "web_search");
      assert.strictEqual(parsed.messages[0].parts[1].content, "keep me");
    });

    it("should shrink server_tool_call_response payload with sentinel", () => {
      const largePayload = {
        type: "web_search_result",
        results: "x".repeat(MAX_SPAN_SIZE_BYTES),
      };
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [
          {
            role: "tool",
            parts: [
              {
                type: "server_tool_call_response",
                id: "stc_1",
                server_tool_call_response: largePayload,
              },
              { type: "text", content: "keep me" },
            ],
          },
        ],
      });
      const span = { attributes: { "gen_ai.input.messages": messageWrapper } };
      const result = truncateSpan(span);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      assert.strictEqual(parsed.messages[0].parts[0].server_tool_call_response, "[truncated]");
      assert.strictEqual(parsed.messages[0].parts[0].id, "stc_1");
      assert.strictEqual(parsed.messages[0].parts[1].content, "keep me");
    });

    it("should trim text content in message attributes when oversized", () => {
      const largeText = "y".repeat(MAX_SPAN_SIZE_BYTES);
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [{ role: "user", parts: [{ type: "text", content: largeText }] }],
      });
      const span = { attributes: { "gen_ai.input.messages": messageWrapper } };
      const result = truncateSpan(span);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      assert.ok(parsed.messages[0].parts[0].content.includes("… [truncated]"));
      assert.ok(parsed.messages[0].parts[0].content.length < largeText.length);
      const spanSize = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(spanSize <= MAX_SPAN_SIZE_BYTES);
    });

    it("should trim utf8 text content without splitting code points", () => {
      const largeEmojiText = "🙂".repeat(90 * 1024);
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [{ role: "user", parts: [{ type: "text", content: largeEmojiText }] }],
      });
      const span = {
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000002",
        name: "test",
        kind: "INTERNAL",
        startTimeUnixNano: 0,
        endTimeUnixNano: 1,
        attributes: {
          "gen_ai.input.messages": messageWrapper,
          other_large_text: "x".repeat(MAX_SPAN_SIZE_BYTES),
        } as Record<string, unknown>,
        status: { code: "UNSET" },
      };
      const result = truncateSpan(span);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      const trimmedContent = parsed.messages[0].parts[0].content as string;
      assert.ok(trimmedContent.includes("… [truncated]"));
      const prefix = trimmedContent.slice(0, -"… [truncated]".length);
      assert.ok(Array.from(prefix).every((cp: string) => cp === "🙂"));
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_SPAN_SIZE_BYTES);
    });

    it("should handle spans with no attributes", () => {
      const span = { attributes: null };
      const result = truncateSpan(span);
      assert.strictEqual(result.attributes, null);
    });

    it("should handle non-serializable attribute values gracefully", () => {
      const span = {
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000002",
        name: "test",
        kind: "INTERNAL",
        startTimeUnixNano: 0,
        endTimeUnixNano: 1,
        attributes: {
          normal_attr: "hello",
          bigint_attr: BigInt(999),
        } as Record<string, unknown>,
        status: { code: "UNSET" },
      };
      const result = truncateSpan(span);
      assert.strictEqual(result.attributes!["normal_attr"], "hello");
      assert.strictEqual(result.attributes!["bigint_attr"], BigInt(999));
    });

    it("should shrink blobs alongside other fields by size priority", () => {
      const blobSize = 40 * 1024;
      const numBlobs = 8;
      const blobParts = Array.from({ length: numBlobs }, () => ({
        type: "blob" as const,
        modality: "image",
        mime_type: "image/png",
        content: "x".repeat(blobSize),
      }));
      const textPart = { type: "text" as const, content: "y".repeat(1024) };
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [{ role: "user", parts: [...blobParts, textPart] }],
      });
      const span = {
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000002",
        name: "test",
        kind: "INTERNAL",
        startTimeUnixNano: 0,
        endTimeUnixNano: 1,
        attributes: { "gen_ai.input.messages": messageWrapper } as Record<string, unknown>,
        status: { code: "UNSET" },
      };
      const result = truncateSpan(span);
      const resultSize = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(resultSize <= MAX_SPAN_SIZE_BYTES);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      const sentinelCount = parsed.messages[0].parts.filter(
        (p: Record<string, unknown>) => p.type === "blob" && p.content === "[blob truncated]",
      ).length;
      assert.ok(sentinelCount > 0);
      assert.ok(sentinelCount <= numBlobs);
    });

    it("should repeatedly shrink candidates by size priority until span fits", () => {
      const regularParts = [
        { type: "text", content: "a".repeat(100 * 1024) },
        { type: "reasoning", content: "b".repeat(100 * 1024) },
        { type: "text", content: "c".repeat(100 * 1024) },
        { type: "reasoning", content: "d".repeat(100 * 1024) },
      ];
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [{ role: "user", parts: regularParts }],
      });
      const span = {
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000002",
        name: "test",
        kind: "INTERNAL",
        startTimeUnixNano: 0,
        endTimeUnixNano: 1,
        attributes: { "gen_ai.input.messages": messageWrapper } as Record<string, unknown>,
        status: { code: "UNSET" },
      };
      const result = truncateSpan(span);
      const resultSize = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(resultSize <= MAX_SPAN_SIZE_BYTES);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      const truncatedCount = parsed.messages[0].parts.filter(
        (part: Record<string, unknown>) =>
          typeof part.content === "string" && (part.content as string).includes("… [truncated]"),
      ).length;
      assert.ok(truncatedCount > 1);
    });

    it("should not throw when shrink actions are exhausted and span still exceeds limit", () => {
      const hugeArray = new Array(100000).fill(42);
      const span = {
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000002",
        name: "test",
        kind: "INTERNAL",
        startTimeUnixNano: 0,
        endTimeUnixNano: 1,
        attributes: {
          non_shrinkable_1: hugeArray,
          non_shrinkable_2: hugeArray,
          small_string: "hello",
        } as Record<string, unknown>,
        status: { code: "UNSET" },
      };
      const result = truncateSpan(span);
      assert.ok(result.attributes);
      // Phase 2 fallback replaces string attributes with overlimit sentinel
      assert.strictEqual(result.attributes!["small_string"], "[overlimit]");
      const resultSize = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(resultSize > MAX_SPAN_SIZE_BYTES);
    });

    it("should only trim the excess bytes, preserving as much content as possible", () => {
      const textSize = MAX_SPAN_SIZE_BYTES + 5000;
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [{ role: "user", parts: [{ type: "text", content: "x".repeat(textSize) }] }],
      });
      const span = {
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000002",
        name: "test",
        kind: "INTERNAL",
        startTimeUnixNano: 0,
        endTimeUnixNano: 1,
        attributes: { "gen_ai.input.messages": messageWrapper } as Record<string, unknown>,
        status: { code: "UNSET" },
      };
      const result = truncateSpan(span);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      const trimmedContent = parsed.messages[0].parts[0].content as string;
      assert.ok(trimmedContent.includes("… [truncated]"));
      const trimmedLength = Buffer.byteLength(trimmedContent, "utf8");
      assert.ok(trimmedLength > textSize * 0.9);
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_SPAN_SIZE_BYTES);
    });

    it("should leave other fields untouched when trimming the largest is sufficient", () => {
      const largeContent = "L".repeat(300 * 1024);
      const mediumContent = "M".repeat(50 * 1024);
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [
          {
            role: "user",
            parts: [
              { type: "text", content: largeContent },
              { type: "text", content: mediumContent },
            ],
          },
        ],
      });
      const span = {
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000002",
        name: "test",
        kind: "INTERNAL",
        startTimeUnixNano: 0,
        endTimeUnixNano: 1,
        attributes: { "gen_ai.input.messages": messageWrapper } as Record<string, unknown>,
        status: { code: "UNSET" },
      };
      const result = truncateSpan(span);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      assert.ok((parsed.messages[0].parts[0].content as string).includes("… [truncated]"));
      assert.strictEqual(parsed.messages[0].parts[1].content, mediumContent);
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_SPAN_SIZE_BYTES);
    });

    it("should skip strings shorter than 50 bytes during truncation", () => {
      const span = {
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000002",
        name: "test",
        kind: "INTERNAL",
        startTimeUnixNano: 0,
        endTimeUnixNano: 1,
        attributes: {
          short_a: "a".repeat(49),
          short_b: "b".repeat(30),
          large_string: "x".repeat(MAX_SPAN_SIZE_BYTES),
        } as Record<string, unknown>,
        status: { code: "UNSET" },
      };
      const result = truncateSpan(span);
      assert.strictEqual(result.attributes!["short_a"], "a".repeat(49));
      assert.strictEqual(result.attributes!["short_b"], "b".repeat(30));
      assert.ok((result.attributes!["large_string"] as string).includes("… [truncated]"));
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_SPAN_SIZE_BYTES);
    });

    it("should only remove enough blobs to fit under the limit", () => {
      const blobSize = 45 * 1024;
      const numBlobs = 6;
      const blobParts = Array.from({ length: numBlobs }, () => ({
        type: "blob" as const,
        modality: "image",
        mime_type: "image/png",
        content: "x".repeat(blobSize),
      }));
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [{ role: "user", parts: blobParts }],
      });
      const span = {
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000002",
        name: "test",
        kind: "INTERNAL",
        startTimeUnixNano: 0,
        endTimeUnixNano: 1,
        attributes: { "gen_ai.input.messages": messageWrapper } as Record<string, unknown>,
        status: { code: "UNSET" },
      };
      const result = truncateSpan(span);
      const resultSize = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(resultSize <= MAX_SPAN_SIZE_BYTES);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      const sentinelCount = parsed.messages[0].parts.filter(
        (p: Record<string, unknown>) => p.content === "[blob truncated]",
      ).length;
      const preservedCount = parsed.messages[0].parts.filter(
        (p: Record<string, unknown>) => p.content !== "[blob truncated]",
      ).length;
      assert.ok(sentinelCount > 0);
      assert.ok(preservedCount > 0);
    });

    it("should use structured overflow sentinel for message attributes in phase 2 fallback", () => {
      const hugeArray = new Array(100000).fill(42);
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [
          { role: "user", parts: [{ type: "text", content: "hello user" }] },
          { role: "assistant", parts: [{ type: "text", content: "hello back" }] },
          { role: "user", parts: [{ type: "text", content: "another msg" }] },
        ],
      });
      const span = {
        traceId: "00000000000000000000000000000001",
        spanId: "0000000000000002",
        name: "test",
        kind: "INTERNAL",
        startTimeUnixNano: 0,
        endTimeUnixNano: 1,
        attributes: {
          non_shrinkable: hugeArray,
          "gen_ai.input.messages": messageWrapper,
        } as Record<string, unknown>,
        status: { code: "UNSET" },
      };
      const result = truncateSpan(span);
      const sentinelValue = result.attributes!["gen_ai.input.messages"] as string;
      const parsed = JSON.parse(sentinelValue);
      assert.strictEqual(parsed.version, "0.1.0");
      assert.strictEqual(parsed.messages.length, 1);
      assert.strictEqual(parsed.messages[0].role, "system");
      assert.strictEqual(parsed.messages[0].parts[0].type, "text");
      assert.ok(parsed.messages[0].parts[0].content.includes("3 messages exceeded limit"));
    });

    it("should truncate oversized raw dict in gen_ai.output.messages", () => {
      const rawDict = JSON.stringify({ result: "x".repeat(200 * 1024) });
      const span = {
        attributes: {
          "microsoft.tenant.id": TENANT_ID,
          "gen_ai.agent.id": AGENT_ID,
          "gen_ai.output.messages": rawDict,
          other_large: "y".repeat(100 * 1024),
        } as Record<string, unknown>,
      };
      const result = truncateSpan(span);
      // Raw dict without version field is treated as a plain string and trimmed
      const outputMsg = result.attributes!["gen_ai.output.messages"] as string;
      assert.ok(outputMsg.length < rawDict.length);
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_SPAN_SIZE_BYTES);
    });

    it("should preserve small raw dict in gen_ai.output.messages when within limit", () => {
      const smallDict = JSON.stringify({ result: "ok", count: 42 });
      const span = {
        attributes: {
          "gen_ai.output.messages": smallDict,
          "gen_ai.agent.id": "test-agent",
        } as Record<string, unknown>,
      };
      const result = truncateSpan(span);
      assert.strictEqual(result.attributes!["gen_ai.output.messages"], smallDict);
    });

    it("should use message-aware shrinking for versioned wrapper in gen_ai.output.messages", () => {
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [
          {
            role: "assistant",
            parts: [{ type: "text", content: "z".repeat(200 * 1024) }],
          },
        ],
      });
      const span = {
        attributes: {
          "gen_ai.output.messages": messageWrapper,
          other_large: "a".repeat(100 * 1024),
        } as Record<string, unknown>,
      };
      const result = truncateSpan(span);
      const output = result.attributes!["gen_ai.output.messages"] as string;
      assert.notStrictEqual(output, "[overlimit]");
      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.version, "1.0");
      assert.strictEqual(parsed.messages[0].parts[0].type, "text");
      assert.ok(parsed.messages[0].parts[0].content.length < 200 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_SPAN_SIZE_BYTES);
    });

    it("should fall back to overlimit sentinel for message attributes", () => {
      const messages = Array.from({ length: 50 }, () => ({
        role: "user",
        parts: [{ type: "text", content: "y".repeat(10000) }],
      }));
      const messageWrapper = JSON.stringify({ version: "1.0", messages });
      const span = { attributes: { "gen_ai.input.messages": messageWrapper } };
      const result = truncateSpan(span);
      const size = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(size <= MAX_SPAN_SIZE_BYTES);
    });
  });
});
