// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";
import { ExportResultCode } from "@opentelemetry/core";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Agent365Exporter } from "../../../../src/a365/exporter/Agent365Exporter.js";
import type { TokenResolverContext } from "../../../../src/a365/exporter/TokenResolverContext.js";
import { _resetA365LoggerForTest } from "../../../../src/a365/logging.js";

const TENANT_ID = "tenant-11111111-1111-1111-1111-111111111111";
const AGENT_ID = "agent-22222222-2222-2222-2222-222222222222";
const USER_ID = "user-33333333-3333-3333-3333-333333333333";

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
    ...overrides,
  } as unknown as ReadableSpan;
}

describe("ContextualTokenResolver", () => {
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

  it("should call contextualTokenResolver with correct context", async () => {
    let captured: TokenResolverContext | undefined;
    const exporter = new Agent365Exporter({
      contextualTokenResolver: (ctx) => {
        captured = ctx;
        return "ctx-token";
      },
    });

    const span = makeSpan({
      attributes: {
        "microsoft.tenant.id": TENANT_ID,
        "gen_ai.agent.id": AGENT_ID,
        "gen_ai.operation.name": "invoke_agent",
        "microsoft.agent.user.id": USER_ID,
      },
    });

    const result = await new Promise<number>((resolve) => {
      exporter.export([span], (r) => resolve(r.code));
    });

    assert.strictEqual(result, ExportResultCode.SUCCESS);
    assert.ok(captured);
    assert.strictEqual(captured!.identity.agentId, AGENT_ID);
    assert.strictEqual(captured!.tenantId, TENANT_ID);
    assert.strictEqual(captured!.identity.agenticUserId, USER_ID);

    const [, options] = fetchSpy.mock.calls[0];
    assert.strictEqual(options.headers["authorization"], "Bearer ctx-token");
  });

  it("should pass undefined agenticUserId when not present on span", async () => {
    let captured: TokenResolverContext | undefined;
    const exporter = new Agent365Exporter({
      contextualTokenResolver: (ctx) => {
        captured = ctx;
        return "ctx-token";
      },
    });

    const span = makeSpan(); // no microsoft.agent.user.id attribute
    const result = await new Promise<number>((resolve) => {
      exporter.export([span], (r) => resolve(r.code));
    });

    assert.strictEqual(result, ExportResultCode.SUCCESS);
    assert.ok(captured);
    assert.strictEqual(captured!.identity.agenticUserId, undefined);
  });

  it("should prefer contextualTokenResolver over tokenResolver when both set", async () => {
    let vanillaCalled = false;
    let contextualCalled = false;

    const exporter = new Agent365Exporter({
      tokenResolver: () => {
        vanillaCalled = true;
        return "vanilla-token";
      },
      contextualTokenResolver: () => {
        contextualCalled = true;
        return "ctx-token";
      },
    });

    const span = makeSpan();
    const result = await new Promise<number>((resolve) => {
      exporter.export([span], (r) => resolve(r.code));
    });

    assert.strictEqual(result, ExportResultCode.SUCCESS);
    assert.strictEqual(vanillaCalled, false);
    assert.strictEqual(contextualCalled, true);

    const [, options] = fetchSpy.mock.calls[0];
    assert.strictEqual(options.headers["authorization"], "Bearer ctx-token");
  });

  it("should fall back to tokenResolver when contextualTokenResolver is not set", async () => {
    let vanillaCalled = false;

    const exporter = new Agent365Exporter({
      tokenResolver: (agentId, tenantId) => {
        vanillaCalled = true;
        assert.strictEqual(agentId, AGENT_ID);
        assert.strictEqual(tenantId, TENANT_ID);
        return "vanilla-token";
      },
    });

    const span = makeSpan();
    const result = await new Promise<number>((resolve) => {
      exporter.export([span], (r) => resolve(r.code));
    });

    assert.strictEqual(result, ExportResultCode.SUCCESS);
    assert.strictEqual(vanillaCalled, true);

    const [, options] = fetchSpy.mock.calls[0];
    assert.strictEqual(options.headers["authorization"], "Bearer vanilla-token");
  });

  it("should handle async contextualTokenResolver", async () => {
    const exporter = new Agent365Exporter({
      contextualTokenResolver: async (ctx) => {
        return `async-token-${ctx.identity.agentId}`;
      },
    });

    const span = makeSpan();
    const result = await new Promise<number>((resolve) => {
      exporter.export([span], (r) => resolve(r.code));
    });

    assert.strictEqual(result, ExportResultCode.SUCCESS);
    const [, options] = fetchSpy.mock.calls[0];
    assert.strictEqual(options.headers["authorization"], `Bearer async-token-${AGENT_ID}`);
  });

  it("should skip export when contextualTokenResolver returns null", async () => {
    const exporter = new Agent365Exporter({
      contextualTokenResolver: () => null,
    });

    const span = makeSpan();
    const result = await new Promise<number>((resolve) => {
      exporter.export([span], (r) => resolve(r.code));
    });

    // No fetch calls should be made when token is null
    assert.strictEqual(fetchSpy.mock.calls.length, 0);
  });

  it("should skip export when contextualTokenResolver returns undefined", async () => {
    const exporter = new Agent365Exporter({
      contextualTokenResolver: () => undefined,
    });

    const span = makeSpan();
    const result = await new Promise<number>((resolve) => {
      exporter.export([span], (r) => resolve(r.code));
    });

    assert.strictEqual(fetchSpy.mock.calls.length, 0);
  });

  it("should handle contextualTokenResolver that throws", async () => {
    const exporter = new Agent365Exporter({
      contextualTokenResolver: () => {
        throw new Error("auth failed");
      },
    });

    const span = makeSpan();
    const result = await new Promise<number>((resolve) => {
      exporter.export([span], (r) => resolve(r.code));
    });

    assert.strictEqual(result, ExportResultCode.FAILED);
    assert.strictEqual(fetchSpy.mock.calls.length, 0);
  });
});
