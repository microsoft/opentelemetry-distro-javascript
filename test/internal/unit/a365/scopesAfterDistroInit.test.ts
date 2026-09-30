// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Verifies that A365 scopes produce valid (non-zero) trace/span IDs when used
 * after `useMicrosoftOpenTelemetry()` resets the global OpenTelemetry state.
 *
 * The distro calls `trace.disable()` and then deletes the global API object to
 * clear stale version locks. This creates a new `ProxyTracerProvider`, so any
 * `ProxyTracer` captured *before* the reset would delegate to the old provider
 * whose delegate is never set — producing NoopSpans with zeroed IDs.
 *
 * The fix: `OpenTelemetryScope.getTracer()` fetches the tracer lazily at
 * span-creation time instead of caching it in a static field.
 */
import { describe, it, expect, afterEach } from "vitest";
import { trace, context as otelContext, propagation } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  BasicTracerProvider,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

// Import the scopes (and thus OpenTelemetryScope) BEFORE calling
// useMicrosoftOpenTelemetry — this is the typical user import order.
import {
  InvokeAgentScope,
  InferenceScope,
  ExecuteToolScope,
  OutputScope,
  A365SpanProcessor,
  OpenTelemetryConstants,
  InferenceOperationType,
} from "../../../../src/a365/index.js";
import type { AgentDetails } from "../../../../src/a365/index.js";

const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

/**
 * Simulates the global-state reset that `useMicrosoftOpenTelemetry()` performs,
 * then registers a fresh provider with an in-memory exporter.
 */
function simulateDistroInit(): InMemorySpanExporter {
  // ── Step 1: Same reset the distro does ──────────────────────────
  trace.disable();
  otelContext.disable();
  const globalKey = Symbol.for("opentelemetry.js.api.1");
  delete (globalThis as Record<symbol, unknown>)[globalKey];

  // ── Step 2: Register a new provider (like NodeSDK.start()) ──────
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new A365SpanProcessor(), new SimpleSpanProcessor(exporter)],
  });

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);

  return exporter;
}

function withBaggage(entries: Record<string, string>, callback: () => void): void {
  let baggage = propagation.createBaggage();
  for (const [key, value] of Object.entries(entries)) {
    baggage = baggage.setEntry(key, { value });
  }
  otelContext.with(propagation.setBaggage(otelContext.active(), baggage), callback);
}

describe("A365 scopes after distro global-state reset", () => {
  const agentDetails: AgentDetails = {
    agentId: "test-agent",
    agentName: "TestAgent",
    tenantId: "test-tenant",
  };
  const request = { conversationId: "conv-1" };

  afterEach(() => {
    trace.disable();
    otelContext.disable();
  });

  it("InvokeAgentScope should produce valid trace/span IDs", () => {
    const exporter = simulateDistroInit();

    const scope = InvokeAgentScope.start(request, {}, agentDetails);
    const ctx = scope.getSpanContext();
    expect(ctx.traceId).not.toBe(ZERO_TRACE_ID);
    expect(ctx.spanId).not.toBe(ZERO_SPAN_ID);
    scope.dispose();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].spanContext().traceId).not.toBe(ZERO_TRACE_ID);
  });

  it("InferenceScope should produce valid trace/span IDs", () => {
    const exporter = simulateDistroInit();

    const scope = InferenceScope.start(
      request,
      { operationName: InferenceOperationType.CHAT, model: "gpt-4o" },
      agentDetails,
    );
    const ctx = scope.getSpanContext();
    expect(ctx.traceId).not.toBe(ZERO_TRACE_ID);
    expect(ctx.spanId).not.toBe(ZERO_SPAN_ID);
    scope.dispose();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
  });

  it("ExecuteToolScope should produce valid trace/span IDs", () => {
    const exporter = simulateDistroInit();

    const scope = ExecuteToolScope.start(
      request,
      { toolName: "search", toolCallId: "tc-1", toolType: "function" },
      agentDetails,
    );
    const ctx = scope.getSpanContext();
    expect(ctx.traceId).not.toBe(ZERO_TRACE_ID);
    expect(ctx.spanId).not.toBe(ZERO_SPAN_ID);
    scope.dispose();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
  });

  it("OutputScope should produce valid trace/span IDs", () => {
    const exporter = simulateDistroInit();

    const scope = OutputScope.start(request, { messages: ["Hello"] }, agentDetails);
    const ctx = scope.getSpanContext();
    expect(ctx.traceId).not.toBe(ZERO_TRACE_ID);
    expect(ctx.spanId).not.toBe(ZERO_SPAN_ID);
    scope.dispose();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
  });

  it("explicit request context should override baggage attributes", () => {
    const exporter = simulateDistroInit();

    withBaggage(
      {
        [OpenTelemetryConstants.SESSION_ID_KEY]: "baggage-session",
        [OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY]: "baggage-conversation",
        [OpenTelemetryConstants.SERVICE_NAME_KEY]: "baggage-service",
        [OpenTelemetryConstants.CHANNEL_NAME_KEY]: "Baggage Channel",
        [OpenTelemetryConstants.CHANNEL_LINK_KEY]: "https://baggage.example",
      },
      () => {
        const scope = InvokeAgentScope.start(
          {
            sessionId: "request-session",
            conversationId: "request-conversation",
            operationSource: "request-service",
            channel: { name: "Request Channel", description: "https://request.example" },
          },
          {},
          agentDetails,
        );
        scope.dispose();
      },
    );

    const attributes = exporter.getFinishedSpans()[0].attributes;
    expect(attributes[OpenTelemetryConstants.SESSION_ID_KEY]).toBe("request-session");
    expect(attributes[OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY]).toBe(
      "request-conversation",
    );
    expect(attributes[OpenTelemetryConstants.SERVICE_NAME_KEY]).toBe("request-service");
    expect(attributes[OpenTelemetryConstants.CHANNEL_NAME_KEY]).toBe("Request Channel");
    expect(attributes[OpenTelemetryConstants.CHANNEL_LINK_KEY]).toBe("https://request.example");
  });

  it("absent request context should preserve baggage attributes", () => {
    const exporter = simulateDistroInit();

    withBaggage(
      {
        [OpenTelemetryConstants.SESSION_ID_KEY]: "baggage-session",
        [OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY]: "baggage-conversation",
        [OpenTelemetryConstants.SERVICE_NAME_KEY]: "baggage-service",
        [OpenTelemetryConstants.CHANNEL_NAME_KEY]: "Baggage Channel",
        [OpenTelemetryConstants.CHANNEL_LINK_KEY]: "https://baggage.example",
      },
      () => {
        const scope = InvokeAgentScope.start({}, {}, agentDetails);
        scope.dispose();
      },
    );

    const attributes = exporter.getFinishedSpans()[0].attributes;
    expect(attributes[OpenTelemetryConstants.SESSION_ID_KEY]).toBe("baggage-session");
    expect(attributes[OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY]).toBe(
      "baggage-conversation",
    );
    expect(attributes[OpenTelemetryConstants.SERVICE_NAME_KEY]).toBe("baggage-service");
    expect(attributes[OpenTelemetryConstants.CHANNEL_NAME_KEY]).toBe("Baggage Channel");
    expect(attributes[OpenTelemetryConstants.CHANNEL_LINK_KEY]).toBe("https://baggage.example");
  });

  it("ConsoleSpanExporter scenario: spans reach user-provided processors", () => {
    const exporter = simulateDistroInit();

    // Full agent flow: invoke → inference → tool → output
    const invokeScope = InvokeAgentScope.start(request, {}, agentDetails);
    invokeScope.dispose();

    const inferenceScope = InferenceScope.start(
      request,
      { operationName: InferenceOperationType.CHAT, model: "gpt-4o" },
      agentDetails,
    );
    inferenceScope.dispose();

    const toolScope = ExecuteToolScope.start(
      request,
      { toolName: "lookup", toolCallId: "tc-2", toolType: "function" },
      agentDetails,
    );
    toolScope.dispose();

    const outputScope = OutputScope.start(request, { messages: ["Done"] }, agentDetails);
    outputScope.dispose();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(4);

    for (const span of spans) {
      expect(span.spanContext().traceId).not.toBe(ZERO_TRACE_ID);
      expect(span.spanContext().spanId).not.toBe(ZERO_SPAN_ID);
    }
  });
});
