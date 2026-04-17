// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace, context as otelContext, propagation, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

import {
  InvokeAgentScope,
  InferenceScope,
  ExecuteToolScope,
} from "../../../../src/a365/scopes/index.js";
import {
  injectContextToHeaders,
  extractContextFromHeaders,
  runWithExtractedTraceContext,
  runWithParentSpanRef,
  isParentSpanRef,
} from "../../../../src/a365/context.js";
import { InferenceOperationType } from "../../../../src/a365/contracts.js";
import type {
  ParentSpanRef,
  InferenceDetails,
  ToolCallDetails,
  AgentDetails,
} from "../../../../src/a365/contracts.js";

// File-level OTel setup — shared by all describe blocks.
let provider: BasicTracerProvider;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let flushProvider: any;
let exporter: InMemorySpanExporter;
let contextManager: AsyncLocalStorageContextManager;

beforeAll(() => {
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalProvider: any = trace.getTracerProvider();
  if (globalProvider && typeof globalProvider.addSpanProcessor === "function") {
    globalProvider.addSpanProcessor(processor);
    flushProvider = globalProvider;
  } else {
    provider = new BasicTracerProvider({ spanProcessors: [processor] });
    trace.setGlobalTracerProvider(provider);
    flushProvider = provider;
  }
});

beforeEach(() => exporter.reset());

afterAll(async () => {
  exporter.reset();
  await provider?.shutdown?.();
  contextManager.disable();
  otelContext.disable();
});

describe("Trace Context Propagation", () => {
  describe("injectContextToHeaders", () => {
    it("should inject traceparent header from active span", () => {
      const tracer = trace.getTracer("test");
      const span = tracer.startSpan("sender");
      const { traceId, spanId, traceFlags } = span.spanContext();
      const ctx = trace.setSpan(otelContext.active(), span);

      otelContext.with(ctx, () => {
        const headers: Record<string, string> = {};
        const result = injectContextToHeaders(headers);
        expect(result).toBe(headers);

        const traceparent = headers["traceparent"];
        expect(traceparent).toBeDefined();

        // W3C traceparent format: {version}-{trace-id}-{parent-id}-{trace-flags}
        const parts = traceparent.split("-");
        expect(parts).toHaveLength(4);
        expect(parts[0]).toBe("00"); // version
        expect(parts[1]).toBe(traceId);
        expect(parts[2]).toBe(spanId);
        expect(parts[3]).toBe(traceFlags.toString(16).padStart(2, "0"));
      });

      span.end();
    });

    it("should be a no-op when no active span exists", () => {
      const headers: Record<string, string> = {};
      injectContextToHeaders(headers);
      expect(headers["traceparent"]).toBeUndefined();
    });
  });

  describe("extractContextFromHeaders", () => {
    it("should extract valid traceparent into Context with correct traceId/spanId", () => {
      const traceId = "0af7651916cd43dd8448eb211c80319c";
      const spanId = "b7ad6b7169203331";

      const extracted = extractContextFromHeaders({
        traceparent: `00-${traceId}-${spanId}-01`,
      });
      const span = trace.getSpan(extracted);

      expect(span).toBeDefined();
      expect(span!.spanContext().traceId).toBe(traceId);
      expect(span!.spanContext().spanId).toBe(spanId);
      expect(span!.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
    });

    it("should return base context for missing or malformed headers", () => {
      expect(trace.getSpan(extractContextFromHeaders({}))).toBeUndefined();
      expect(trace.getSpan(extractContextFromHeaders({ traceparent: "invalid" }))).toBeUndefined();
    });
  });

  describe("end-to-end inject → extract round-trip", () => {
    it("should preserve trace and parent-child relationship across services", async () => {
      const tracer = trace.getTracer("test");
      const senderSpan = tracer.startSpan("sender");
      const senderCtx = trace.setSpan(otelContext.active(), senderSpan);

      const headers: Record<string, string> = {};
      otelContext.with(senderCtx, () => injectContextToHeaders(headers));

      const result = runWithExtractedTraceContext(headers, () => {
        const child = tracer.startSpan("receiver");
        expect(child.spanContext().traceId).toBe(senderSpan.spanContext().traceId);
        child.end();
        return "ok";
      });
      expect(result).toBe("ok");

      senderSpan.end();
      await flushProvider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const receiver = spans.find((s) => s.name === "receiver");
      expect(receiver!.spanContext().traceId).toBe(senderSpan.spanContext().traceId);
      expect(receiver!.parentSpanContext?.spanId).toBe(senderSpan.spanContext().spanId);
    });
  });

  describe("scope with extracted Context as ParentContext", () => {
    it("should create scope as child of extracted trace context", async () => {
      const traceId = "0af7651916cd43dd8448eb211c80319c";
      const spanId = "b7ad6b7169203331";
      const extractedCtx = extractContextFromHeaders({
        traceparent: `00-${traceId}-${spanId}-01`,
      });

      const scope = InvokeAgentScope.start(
        {},
        {},
        { agentId: "ctx-agent", tenantId: "test-tenant" },
        undefined,
        { parentContext: extractedCtx },
      );
      expect(scope.getSpanContext().traceId).toBe(traceId);
      scope.dispose();

      await flushProvider.forceFlush();

      const span = exporter
        .getFinishedSpans()
        .find((s) => s.name.toLowerCase().includes("invoke_agent"));
      expect(span!.parentSpanContext?.spanId).toBe(spanId);
    });
  });

  describe("ParentSpanRef with isRemote", () => {
    it("should propagate isRemote=true to child span parentSpanContext", async () => {
      const parentRef: ParentSpanRef = {
        traceId: "3af7651916cd43dd8448eb211c80319c",
        spanId: "e7ad6b7169203331",
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      };

      const scope = InvokeAgentScope.start(
        {},
        {},
        { agentId: "remote-agent", tenantId: "test-tenant" },
        undefined,
        { parentContext: parentRef },
      );
      scope.dispose();

      await flushProvider.forceFlush();

      const span = exporter
        .getFinishedSpans()
        .find((s) => s.spanContext().traceId === parentRef.traceId);
      expect(span!.parentSpanContext?.spanId).toBe(parentRef.spanId);
      expect(span!.parentSpanContext?.isRemote).toBe(true);
    });
  });
});

describe("ParentSpanRef - Explicit Parent Span Support", () => {
  const testAgentDetails: AgentDetails = {
    agentId: "test-agent",
    agentName: "Test Agent",
    agentDescription: "A test agent",
    tenantId: "test-tenant-456",
  };

  const testRequest = {
    conversationId: "test-conv-psr",
    channel: { name: "PSRChannel", description: "https://psr.channel" },
  };

  describe("runWithParentSpanRef", () => {
    it("should execute callback with parent span context", () => {
      const parentRef: ParentSpanRef = {
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
      };

      let executed = false;
      const result = runWithParentSpanRef(parentRef, () => {
        executed = true;
        return "test-result";
      });

      expect(executed).toBe(true);
      expect(result).toBe("test-result");
    });
  });

  it.each([
    [
      "InvokeAgentScope",
      (parentRef: ParentSpanRef) => {
        return InvokeAgentScope.start(
          testRequest,
          {},
          { agentId: "test-agent", agentName: "Test Agent", tenantId: "test-tenant-456" },
          undefined,
          { parentContext: parentRef },
        );
      },
      (name: string) =>
        name.toLowerCase().includes("invokeagent") || name.toLowerCase().includes("invoke_agent"),
    ],
    [
      "InferenceScope",
      (parentRef: ParentSpanRef) => {
        const inferenceDetails: InferenceDetails = {
          operationName: InferenceOperationType.CHAT,
          model: "gpt-4",
          providerName: "openai",
        };
        return InferenceScope.start(testRequest, inferenceDetails, testAgentDetails, undefined, {
          parentContext: parentRef,
        });
      },
      (name: string) => name.toLowerCase().includes("chat"),
    ],
    [
      "ExecuteToolScope",
      (parentRef: ParentSpanRef) => {
        const toolDetails: ToolCallDetails = {
          toolName: "test-tool",
          arguments: '{"param": "value"}',
        };
        return ExecuteToolScope.start(testRequest, toolDetails, testAgentDetails, undefined, {
          parentContext: parentRef,
        });
      },
      (name: string) => name.toLowerCase().includes("execute_tool"),
    ],
  ])(
    "should create a child span with correct parent relationship (%s)",
    async (_label, createScope, nameMatches) => {
      const tracer = trace.getTracer("test");
      const rootSpan = tracer.startSpan("root-span");
      const parentSpanContext = rootSpan.spanContext();

      const parentRef: ParentSpanRef = {
        traceId: parentSpanContext.traceId,
        spanId: parentSpanContext.spanId,
      };

      const baseCtx = trace.setSpan(otelContext.active(), rootSpan);
      await otelContext.with(baseCtx, async () => {
        const childScope = createScope(parentRef);
        expect(childScope.getSpanContext().traceId).toBe(parentSpanContext.traceId);
        childScope.dispose();
      });

      rootSpan.end();

      await flushProvider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const childSpan = spans.find((s) => nameMatches(s.name));
      expect(childSpan).toBeDefined();
      expect(childSpan!.spanContext().traceId).toBe(parentSpanContext.traceId);
      expect(childSpan!.parentSpanContext?.spanId).toBe(parentSpanContext.spanId);
    },
  );

  describe("runWithParentSpanRef with nested scope creation", () => {
    it("should correctly parent spans created inside runWithParentSpanRef", async () => {
      const tracer = trace.getTracer("test");
      const rootSpan = tracer.startSpan("root-span");
      const parentSpanContext = rootSpan.spanContext();

      const parentRef: ParentSpanRef = {
        traceId: parentSpanContext.traceId,
        spanId: parentSpanContext.spanId,
      };

      const baseCtx = trace.setSpan(otelContext.active(), rootSpan);
      await otelContext.with(baseCtx, async () => {
        runWithParentSpanRef(parentRef, () => {
          const nestedScope = InvokeAgentScope.start(
            testRequest,
            {},
            {
              agentId: "nested-agent",
              tenantId: "test-tenant-456",
            },
          );

          const nestedSpanContext = nestedScope.getSpanContext();
          expect(nestedSpanContext.traceId).toBe(parentSpanContext.traceId);

          nestedScope.dispose();
        });
      });

      rootSpan.end();

      await flushProvider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const nestedSpan = spans.find((s) => s.name.includes("invoke_agent"));
      expect(nestedSpan).toBeDefined();
      expect(nestedSpan!.spanContext().traceId).toBe(parentSpanContext.traceId);
      expect(nestedSpan!.parentSpanContext?.spanId).toBe(parentSpanContext.spanId);
    });
  });

  describe("getSpanContext method", () => {
    it("should return the span context from a scope (and be usable as ParentSpanRef)", async () => {
      const scope = InvokeAgentScope.start(
        testRequest,
        {},
        {
          agentId: "test-agent",
          tenantId: "test-tenant-456",
        },
      );
      const spanContext = scope.getSpanContext();

      expect(spanContext).toBeDefined();
      expect(spanContext.traceId).toBeDefined();
      expect(spanContext.spanId).toBeDefined();
      expect(spanContext.traceId.length).toBe(32); // 32 hex chars
      expect(spanContext.spanId.length).toBe(16); // 16 hex chars

      const parentRef: ParentSpanRef = {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      };
      const inferenceDetails: InferenceDetails = {
        operationName: InferenceOperationType.CHAT,
        model: "gpt-4",
      };
      const activeParentSpan = trace.wrapSpanContext(spanContext);
      const baseCtx = trace.setSpan(otelContext.active(), activeParentSpan);
      const childScope = otelContext.with(baseCtx, () =>
        InferenceScope.start(testRequest, inferenceDetails, testAgentDetails, undefined, {
          parentContext: parentRef,
        }),
      );
      expect(childScope.getSpanContext().traceId).toBe(spanContext.traceId);

      scope.dispose();
      childScope.dispose();

      await flushProvider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const parentSpan = spans.find((s) => s.name.toLowerCase().includes("invoke_agent"));
      const childSpan = spans.find((s) => s.name.toLowerCase().includes("chat"));

      expect(parentSpan).toBeDefined();
      expect(childSpan).toBeDefined();
      expect(childSpan!.spanContext().traceId).toBe(parentSpan!.spanContext().traceId);
      expect(childSpan!.parentSpanContext?.spanId).toBe(parentSpan!.spanContext().spanId);
    });
  });

  describe("traceFlags propagation", () => {
    it("should record child spans when parentRef.traceFlags is SAMPLED", async () => {
      const parentRef: ParentSpanRef = {
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags: TraceFlags.SAMPLED,
      };

      runWithParentSpanRef(parentRef, () => {
        const scope = InvokeAgentScope.start(
          testRequest,
          {},
          {
            agentId: "sampled-agent",
            tenantId: "test-tenant-456",
          },
        );
        scope.dispose();
      });

      await flushProvider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const childSpan = spans.find(
        (s) =>
          s.name.toLowerCase().includes("invokeagent") ||
          s.name.toLowerCase().includes("invoke_agent"),
      );

      expect(childSpan).toBeDefined();
      expect(childSpan!.spanContext().traceId).toBe(parentRef.traceId);
      expect(childSpan!.parentSpanContext?.spanId).toBe(parentRef.spanId);
      expect(childSpan!.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
    });

    it("should not record child spans when parentRef.traceFlags is NONE", async () => {
      const parentRef: ParentSpanRef = {
        traceId: "abcdef0123456789abcdef0123456789",
        spanId: "abcdef0123456789",
        traceFlags: TraceFlags.NONE,
      };

      runWithParentSpanRef(parentRef, () => {
        const scope = InvokeAgentScope.start(
          testRequest,
          {},
          {
            agentId: "unsampled-agent",
            tenantId: "test-tenant-456",
          },
        );
        scope.dispose();
      });

      await flushProvider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const childSpan = spans.find(
        (s) =>
          (s.name.toLowerCase().includes("invokeagent") ||
            s.name.toLowerCase().includes("invoke_agent")) &&
          s.spanContext().traceId === parentRef.traceId,
      );

      // The span should not be exported when traceFlags is NONE
      expect(childSpan).toBeUndefined();
    });

    it("should default to SAMPLED when parentRef.traceFlags is not provided and no active span matches", async () => {
      const parentRef: ParentSpanRef = {
        traceId: "fedcba9876543210fedcba9876543210",
        spanId: "fedcba9876543210",
        // traceFlags is not provided — should default to SAMPLED
      };

      runWithParentSpanRef(parentRef, () => {
        const scope = InvokeAgentScope.start(
          testRequest,
          {},
          {
            agentId: "default-sampled-agent",
            tenantId: "test-tenant-456",
          },
        );
        scope.dispose();
      });

      await flushProvider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const childSpan = spans.find(
        (s) =>
          (s.name.toLowerCase().includes("invokeagent") ||
            s.name.toLowerCase().includes("invoke_agent")) &&
          s.spanContext().traceId === parentRef.traceId,
      );

      // Should be recorded when traceFlags defaults to SAMPLED
      expect(childSpan).toBeDefined();
      expect(childSpan!.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
    });

    it("should inherit traceFlags from active span when parentRef.traceFlags is not provided but traceId matches", async () => {
      const tracer = trace.getTracer("test");
      const rootSpan = tracer.startSpan("active-root-span");
      const parentSpanContext = rootSpan.spanContext();

      const parentRef: ParentSpanRef = {
        traceId: parentSpanContext.traceId,
        spanId: parentSpanContext.spanId,
        // traceFlags is not provided
      };

      const baseCtx = trace.setSpan(otelContext.active(), rootSpan);
      await otelContext.with(baseCtx, async () => {
        runWithParentSpanRef(parentRef, () => {
          const scope = InvokeAgentScope.start(
            testRequest,
            {},
            {
              agentId: "inherited-flags-agent",
              tenantId: "test-tenant-456",
            },
          );
          scope.dispose();
        });
      });

      rootSpan.end();

      await flushProvider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const childSpan = spans.find(
        (s) =>
          (s.name.toLowerCase().includes("invokeagent") ||
            s.name.toLowerCase().includes("invoke_agent")) &&
          s.spanContext().traceId === parentRef.traceId,
      );

      // Should be recorded with traceFlags inherited from active span
      expect(childSpan).toBeDefined();
      expect(childSpan!.spanContext().traceFlags).toBe(parentSpanContext.traceFlags);
    });
  });
});

describe("isParentSpanRef type guard", () => {
  it("should return true for ParentSpanRef objects", () => {
    expect(isParentSpanRef({ traceId: "abc", spanId: "def" })).toBe(true);
  });

  it("should return false for OTel Context objects", () => {
    const ctx = otelContext.active();
    expect(isParentSpanRef(ctx)).toBe(false);
  });

  it("should return false for null", () => {
    expect(isParentSpanRef(null as any)).toBe(false);
  });

  it("should return false for objects without traceId", () => {
    expect(isParentSpanRef({ spanId: "def" } as any)).toBe(false);
  });

  it("should return false for objects without spanId", () => {
    expect(isParentSpanRef({ traceId: "abc" } as any)).toBe(false);
  });
});
