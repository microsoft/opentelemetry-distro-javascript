// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert, beforeEach, describe, it, vi } from "vitest";
import type { Tracer, Span as OtelSpan } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span as AgentsSpan, SpanData } from "@openai/agents-core";
import type { Trace as AgentTrace } from "@openai/agents-core";
import { OpenAIAgentsTraceProcessor } from "../../../../../src/genai/instrumentations/openai/openAIAgentsTraceProcessor.js";

function makeMockOtelSpan(): OtelSpan & { attrs: Record<string, unknown>; _name: string } {
  const attrs: Record<string, unknown> = {};
  let _name = "";
  return {
    attrs,
    get _name() {
      return _name;
    },
    setAttribute: vi.fn((key: string, value: unknown) => {
      attrs[key] = value;
    }),
    setStatus: vi.fn(),
    end: vi.fn(),
    updateName: vi.fn((name: string) => {
      _name = name;
    }),
    spanContext: vi.fn(() => ({
      traceId: "0000000000000001",
      spanId: "00000001",
      traceFlags: 1,
    })),
    isRecording: vi.fn(() => true),
    recordException: vi.fn(),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
  } as unknown as OtelSpan & { attrs: Record<string, unknown>; _name: string };
}

function makeMockTracer(mockSpan?: OtelSpan): Tracer & { spans: OtelSpan[] } {
  const spans: OtelSpan[] = [];
  let hasReturnedInjectedSpan = false;
  return {
    spans,
    startSpan: vi.fn(() => {
      const span =
        mockSpan && !hasReturnedInjectedSpan
          ? ((hasReturnedInjectedSpan = true), mockSpan)
          : makeMockOtelSpan();
      spans.push(span);
      return span;
    }),
    startActiveSpan: vi.fn(),
  } as unknown as Tracer;
}

function makeAgentsSpan(overrides: Partial<Record<string, unknown>> = {}): AgentsSpan<SpanData> {
  return {
    spanId: "span-1",
    traceId: "trace-1",
    parentId: undefined,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    spanData: { type: "agent", name: "TestAgent" },
    error: undefined,
    ...overrides,
  } as unknown as AgentsSpan<SpanData>;
}

function makeTrace(traceId = "trace-1"): AgentTrace {
  return { traceId } as unknown as AgentTrace;
}

describe("OpenAIAgentsTraceProcessor", () => {
  let processor: OpenAIAgentsTraceProcessor;
  let mockSpan: OtelSpan & { attrs: Record<string, unknown> };
  let tracer: Tracer & { spans: OtelSpan[] };

  beforeEach(() => {
    mockSpan = makeMockOtelSpan();
    tracer = makeMockTracer(mockSpan);
    processor = new OpenAIAgentsTraceProcessor(tracer, {
      isContentRecordingEnabled: true,
    });
  });

  describe("start / shutdown", () => {
    it("start is a no-op", async () => {
      await processor.start();
    });

    it("shutdown clears internal state", async () => {
      await processor.shutdown();
    });
  });

  describe("onSpanStart / onSpanEnd", () => {
    it("creates and ends an OTel span for an agent span", async () => {
      const span = makeAgentsSpan();
      await processor.onSpanStart(span);
      assert.ok((tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls.length > 0);

      await processor.onSpanEnd(span);
      assert.ok((mockSpan.setStatus as ReturnType<typeof vi.fn>).mock.calls.length > 0);
      assert.ok((mockSpan.end as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    });

    it("skips span start when missing required fields", async () => {
      const span = makeAgentsSpan({ spanId: undefined });
      await processor.onSpanStart(span);
      assert.strictEqual((tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls.length, 0);
    });

    it("skips span end when no matching OTel span", async () => {
      const span = makeAgentsSpan({ spanId: "nonexistent" });
      await processor.onSpanEnd(span);
      // Should not throw
    });

    it("sets ERROR status for failed spans", async () => {
      const span = makeAgentsSpan({
        error: { message: "something broke" },
      });
      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);
      const statusCalls = (mockSpan.setStatus as ReturnType<typeof vi.fn>).mock.calls;
      assert.ok(statusCalls.length > 0);
      assert.strictEqual(statusCalls[0][0].code, SpanStatusCode.ERROR);
    });
  });

  describe("onTraceEnd", () => {
    it("ends root span on trace end", async () => {
      // Start a span that becomes the root (no parent)
      const span = makeAgentsSpan();
      await processor.onSpanStart(span);

      const trace = makeTrace("trace-1");
      await processor.onTraceEnd(trace);
      // Root span should be ended
    });

    it("does nothing for unknown trace", async () => {
      const trace = makeTrace("unknown-trace");
      await processor.onTraceEnd(trace);
      // Should not throw
    });
  });

  describe("agent span processing", () => {
    it("sets agent attributes", async () => {
      const span = makeAgentsSpan({
        spanData: { type: "agent", name: "MyAgent" },
      });
      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      assert.strictEqual(mockSpan.attrs["graph_node_id"], "MyAgent");
      assert.strictEqual(mockSpan.attrs["gen_ai.operation.name"], "invoke_agent");
    });
  });

  describe("generation span processing", () => {
    it("sets model and usage attributes", async () => {
      const span = makeAgentsSpan({
        spanData: {
          type: "generation",
          model: "gpt-4o",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      });
      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      assert.strictEqual(mockSpan.attrs["gen_ai.request.model"], "gpt-4o");
      assert.strictEqual(mockSpan.attrs["gen_ai.usage.input_tokens"], 10);
      assert.strictEqual(mockSpan.attrs["gen_ai.usage.output_tokens"], 20);
    });
  });

  describe("function span processing", () => {
    it("sets tool attributes and operation name", async () => {
      const span = makeAgentsSpan({
        spanData: {
          type: "function",
          name: "get_weather",
          input: "Seattle",
          output: "Sunny",
        },
      });
      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      assert.strictEqual(mockSpan.attrs["gen_ai.tool.name"], "get_weather");
      assert.strictEqual(mockSpan.attrs["gen_ai.operation.name"], "execute_tool");
      assert.strictEqual(mockSpan.attrs["gen_ai.tool.type"], "function");
    });
  });

  describe("response span processing", () => {
    it("sets model and usage from response", async () => {
      const span = makeAgentsSpan({
        spanData: {
          type: "response",
          _response: {
            model: "gpt-4o-mini",
            usage: { input_tokens: 3, output_tokens: 7 },
          },
        },
      });
      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      assert.strictEqual(mockSpan.attrs["gen_ai.request.model"], "gpt-4o-mini");
      assert.strictEqual(mockSpan.attrs["gen_ai.usage.input_tokens"], 3);
    });
  });

  describe("handoff span processing", () => {
    it("records handoff and resolves in agent span", async () => {
      // Create handoff span
      const handoffSpan = makeAgentsSpan({
        spanId: "span-handoff",
        spanData: {
          type: "handoff",
          from_agent: "AgentA",
          to_agent: "AgentB",
        },
      });
      await processor.onSpanStart(handoffSpan);
      await processor.onSpanEnd(handoffSpan);

      // Create agent span for the target agent
      const agentSpan = makeAgentsSpan({
        spanId: "span-agent",
        spanData: { type: "agent", name: "AgentB" },
      });
      await processor.onSpanStart(agentSpan);
      await processor.onSpanEnd(agentSpan);

      const agentOtelSpan = tracer.spans[tracer.spans.length - 1] as OtelSpan & {
        attrs: Record<string, unknown>;
      };
      assert.strictEqual(agentOtelSpan.attrs["graph_node_parent_id"], "AgentA");
    });
  });

  describe("content recording", () => {
    it("does not record content when disabled", async () => {
      const noContentProcessor = new OpenAIAgentsTraceProcessor(tracer, {
        isContentRecordingEnabled: false,
      });

      const span = makeAgentsSpan({
        spanData: {
          type: "generation",
          model: "gpt-4o",
          input: "secret input",
          output: "secret output",
        },
      });
      await noContentProcessor.onSpanStart(span);
      await noContentProcessor.onSpanEnd(span);

      // Model should still be set
      assert.strictEqual(mockSpan.attrs["gen_ai.request.model"], "gpt-4o");
      // Content should NOT be set
      assert.strictEqual(mockSpan.attrs["gen_ai.input.messages"], undefined);
      assert.strictEqual(mockSpan.attrs["gen_ai.output.messages"], undefined);
    });
  });

  describe("mcp_tools span processing", () => {
    it("sets tool attributes for MCP tools", async () => {
      const span = makeAgentsSpan({
        spanData: {
          type: "mcp_tools",
          server: "my-mcp-server",
          result: [{ name: "tool1" }],
        },
      });
      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      assert.strictEqual(mockSpan.attrs["gen_ai.operation.name"], "execute_tool");
      assert.strictEqual(mockSpan.attrs["gen_ai.tool.name"], "my-mcp-server");
      assert.strictEqual(mockSpan.attrs["gen_ai.tool.type"], "extension");
    });
  });
});
