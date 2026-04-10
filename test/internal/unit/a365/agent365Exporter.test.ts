// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";
import { ExportResultCode } from "@opentelemetry/core";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Agent365Exporter } from "../../../../src/_a365/exporter/Agent365Exporter.js";
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
} from "../../../../src/_a365/exporter/utils.js";
import { ResolvedExporterOptions } from "../../../../src/_a365/exporter/Agent365ExporterOptions.js";

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
      "microsoft.tenant.id": "tenant-1",
      "gen_ai.agent.id": "agent-1",
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
    vi.restoreAllMocks();
  });

  describe("export", () => {
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
      assert.ok(url.includes("/observability/tenants/tenant-1/agents/agent-1/traces"));
      assert.strictEqual(options.method, "POST");
      assert.strictEqual(options.headers["authorization"], "Bearer test-token");
      assert.strictEqual(options.headers["x-ms-tenant-id"], "tenant-1");
      assert.strictEqual(options.headers["content-type"], "application/json");
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
  });

  describe("parseIdentityKey", () => {
    it("should split key into tenantId and agentId", () => {
      const result = parseIdentityKey("tenant-1:agent-1");
      assert.strictEqual(result.tenantId, "tenant-1");
      assert.strictEqual(result.agentId, "agent-1");
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
  });

  describe("kindName / statusName", () => {
    it("should map span kinds", () => {
      assert.strictEqual(kindName(SpanKind.INTERNAL), "INTERNAL");
      assert.strictEqual(kindName(SpanKind.SERVER), "SERVER");
      assert.strictEqual(kindName(SpanKind.CLIENT), "CLIENT");
    });

    it("should map status codes", () => {
      assert.strictEqual(statusName(SpanStatusCode.OK), "OK");
      assert.strictEqual(statusName(SpanStatusCode.ERROR), "ERROR");
      assert.strictEqual(statusName(SpanStatusCode.UNSET), "UNSET");
    });
  });

  describe("resolveAgent365Endpoint", () => {
    it("should return prod endpoint for prod category", () => {
      assert.strictEqual(resolveAgent365Endpoint("prod"), "https://agent365.svc.cloud.microsoft");
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

    it("should truncate blob parts in message attributes", () => {
      const blobContent = "b".repeat(MAX_SPAN_SIZE_BYTES);
      const messageWrapper = JSON.stringify({
        version: "1.0",
        messages: [{ role: "user", parts: [{ type: "blob", content: blobContent }] }],
      });
      const span = { attributes: { "gen_ai.input.messages": messageWrapper } };
      const result = truncateSpan(span);
      const size = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(size <= MAX_SPAN_SIZE_BYTES);
      const parsed = JSON.parse(result.attributes!["gen_ai.input.messages"] as string);
      assert.strictEqual(parsed.messages[0].parts[0].content, "[blob truncated]");
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

    it("should handle spans with no attributes", () => {
      const span = { attributes: null };
      const result = truncateSpan(span);
      assert.strictEqual(result.attributes, null);
    });
  });
});
