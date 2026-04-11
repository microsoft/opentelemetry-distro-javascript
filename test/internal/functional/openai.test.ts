// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Functional test for OpenAI Agents instrumentation.
 *
 * Exercises the full pipeline: OpenAIAgentsTraceProcessor receives OpenAI
 * Agents SDK span callbacks and produces OTel spans captured by an
 * InMemorySpanExporter. Validates that the correct spans, attributes, and
 * parent-child relationships are emitted.
 */

import { afterEach, assert, describe, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Span as AgentsSpan, SpanData } from "@openai/agents-core";
import { OpenAIAgentsTraceProcessor } from "../../../src/genai/instrumentations/openai/openAIAgentsTraceProcessor.js";
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
} from "../../../src/genai/index.js";

let provider: BasicTracerProvider;
let exporter: InMemorySpanExporter;
let processor: OpenAIAgentsTraceProcessor;

function setup(options?: {
  isContentRecordingEnabled?: boolean;
  suppressInvokeAgentInput?: boolean;
}) {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const tracer = provider.getTracer("test-openai-agents", "1.0.0");
  processor = new OpenAIAgentsTraceProcessor(tracer, options);
}

let spanCounter = 0;
function makeSpan(overrides: Partial<Record<string, unknown>> = {}): AgentsSpan<SpanData> {
  const id = `span-${++spanCounter}`;
  return {
    spanId: id,
    traceId: "trace-1",
    parentId: undefined,
    startedAt: new Date().toISOString(),
    endedAt: new Date(Date.now() + 100).toISOString(),
    spanData: { type: "agent", name: "TestAgent" },
    error: undefined,
    ...overrides,
  } as unknown as AgentsSpan<SpanData>;
}

afterEach(async () => {
  spanCounter = 0;
  if (provider) {
    await provider.forceFlush();
    await provider.shutdown();
  }
  exporter?.reset();
});

describe("OpenAI Agents Instrumentation Functional Tests", () => {
  describe("single generation (LLM call)", () => {
    it("produces a span with chat operation and model attributes", async () => {
      setup({ isContentRecordingEnabled: true });

      const span = makeSpan({
        spanId: "gen-1",
        spanData: {
          type: "generation",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hello" }],
          output: [{ role: "assistant", content: "Hi there!" }],
          usage: { input_tokens: 50, output_tokens: 20 },
        },
      });

      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);

      const otelSpan = spans[0];
      assert.ok(
        otelSpan.name.includes("gpt-4o"),
        `span name "${otelSpan.name}" should contain model name`,
      );
      assert.strictEqual(otelSpan.status.code, SpanStatusCode.OK);
      assert.strictEqual(otelSpan.attributes[ATTR_GEN_AI_PROVIDER_NAME], "openai");
      assert.strictEqual(otelSpan.attributes[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
      assert.strictEqual(otelSpan.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS], 50);
      assert.strictEqual(otelSpan.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS], 20);
    });
  });

  describe("response span", () => {
    it("extracts model and usage from response data", async () => {
      setup({ isContentRecordingEnabled: true });

      const span = makeSpan({
        spanId: "resp-1",
        spanData: {
          type: "response",
          _response: {
            model: "gpt-4o-mini",
            usage: { input_tokens: 10, output_tokens: 5 },
            output: "Response text here",
          },
          _input: [{ role: "user", content: "What is 2+2?" }],
        },
      });

      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);

      const otelSpan = spans[0];
      assert.ok(otelSpan.name.includes(GEN_AI_OPERATION_CHAT));
      assert.strictEqual(otelSpan.attributes[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o-mini");
      assert.strictEqual(otelSpan.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS], 10);
      assert.strictEqual(otelSpan.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS], 5);
    });
  });

  describe("agent with function tool and generation children", () => {
    it("produces parent-child spans matching the agent execution flow", async () => {
      setup({ isContentRecordingEnabled: true });

      // 1. Agent span (root)
      const agentSpan = makeSpan({
        spanId: "agent-1",
        spanData: { type: "agent", name: "ResearchAgent" },
      });

      // 2. Function/tool span (child of agent)
      const toolSpan = makeSpan({
        spanId: "tool-1",
        parentId: "agent-1",
        spanData: {
          type: "function",
          name: "web_search",
          input: "opentelemetry agents",
          output: "search results...",
        },
      });

      // 3. Generation span (child of agent)
      const genSpan = makeSpan({
        spanId: "gen-1",
        parentId: "agent-1",
        spanData: {
          type: "generation",
          model: "gpt-4o",
          usage: { input_tokens: 200, output_tokens: 80 },
        },
      });

      // Start in order: agent, then tool, then generation
      await processor.onSpanStart(agentSpan);
      await processor.onSpanStart(toolSpan);
      await processor.onSpanStart(genSpan);

      // End in reverse order (children end before parent)
      await processor.onSpanEnd(genSpan);
      await processor.onSpanEnd(toolSpan);
      await processor.onSpanEnd(agentSpan);

      // End root trace to emit the root span
      await processor.onTraceEnd({ traceId: "trace-1" } as any);

      const spans = exporter.getFinishedSpans();
      // agent + tool + generation + root = 4 spans (root created by first span without parent)
      assert.ok(spans.length >= 3, `expected at least 3 spans, got ${spans.length}`);

      // Find spans by operation
      const agentOtel = spans.find(
        (s) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === GEN_AI_OPERATION_INVOKE_AGENT,
      );
      const toolOtel = spans.find(
        (s) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === GEN_AI_OPERATION_EXECUTE_TOOL,
      );
      const genOtel = spans.find(
        (s) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === GEN_AI_OPERATION_CHAT,
      );

      assert.ok(agentOtel, "agent span should exist");
      assert.ok(toolOtel, "tool span should exist");
      assert.ok(genOtel, "generation span should exist");

      // Verify agent span
      assert.ok(agentOtel!.name.includes(GEN_AI_OPERATION_INVOKE_AGENT));
      assert.strictEqual(agentOtel!.attributes["graph_node_id"], "ResearchAgent");

      // Verify tool span
      assert.ok(toolOtel!.name.includes(GEN_AI_OPERATION_EXECUTE_TOOL));
      assert.strictEqual(toolOtel!.attributes[ATTR_GEN_AI_TOOL_NAME], "web_search");
      assert.strictEqual(toolOtel!.attributes[ATTR_GEN_AI_TOOL_TYPE], "function");

      // Verify generation span
      assert.strictEqual(genOtel!.attributes[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
      assert.strictEqual(genOtel!.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS], 200);
      assert.strictEqual(genOtel!.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS], 80);

      // Verify parent-child: tool and gen should be children of the root span
      // (in OpenAI SDK, the first span without a parent becomes the root)
      const rootSpan = spans.find((s) => !s.parentSpanContext?.spanId);
      assert.ok(rootSpan, "root span should exist");

      // Agent, tool, and gen should all be descendants of root
      assert.strictEqual(
        toolOtel!.parentSpanContext?.spanId,
        rootSpan!.spanContext().spanId,
        "tool span should be child of root span",
      );
      assert.strictEqual(
        genOtel!.parentSpanContext?.spanId,
        rootSpan!.spanContext().spanId,
        "gen span should be child of root span",
      );
    });
  });

  describe("handoff between agents", () => {
    it("records handoff parent node in target agent span", async () => {
      setup();

      // Handoff span
      const handoff = makeSpan({
        spanId: "handoff-1",
        spanData: {
          type: "handoff",
          from_agent: "AgentA",
          to_agent: "AgentB",
        },
      });

      await processor.onSpanStart(handoff);
      await processor.onSpanEnd(handoff);

      // Target agent span
      const agentB = makeSpan({
        spanId: "agent-b",
        spanData: { type: "agent", name: "AgentB" },
      });

      await processor.onSpanStart(agentB);
      await processor.onSpanEnd(agentB);

      const spans = exporter.getFinishedSpans();
      const agentBSpan = spans.find((s) => s.attributes["graph_node_id"] === "AgentB");
      assert.ok(agentBSpan);
      assert.strictEqual(agentBSpan!.attributes["graph_node_parent_id"], "AgentA");
    });
  });

  describe("MCP tools span", () => {
    it("produces a span with tool attributes for MCP server", async () => {
      setup();

      const span = makeSpan({
        spanId: "mcp-1",
        spanData: {
          type: "mcp_tools",
          server: "my-mcp-server",
          result: [{ name: "tool1" }, { name: "tool2" }],
        },
      });

      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      // End root trace to emit the root span
      await processor.onTraceEnd({ traceId: "trace-1" } as any);

      const spans = exporter.getFinishedSpans();
      assert.ok(spans.length >= 1, `expected at least 1 span, got ${spans.length}`);

      const mcpSpan = spans.find((s) => s.attributes[ATTR_GEN_AI_TOOL_NAME] === "my-mcp-server");
      assert.ok(mcpSpan, "MCP span should exist");
      assert.strictEqual(
        mcpSpan!.attributes[ATTR_GEN_AI_OPERATION_NAME],
        GEN_AI_OPERATION_EXECUTE_TOOL,
      );
      assert.strictEqual(mcpSpan!.attributes[ATTR_GEN_AI_TOOL_TYPE], "extension");
    });
  });

  describe("content recording gating", () => {
    it("does not record content when disabled", async () => {
      setup({ isContentRecordingEnabled: false });

      const span = makeSpan({
        spanId: "gen-no-content",
        spanData: {
          type: "generation",
          model: "gpt-4o",
          input: "secret input",
          output: "secret output",
        },
      });

      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      const spans = exporter.getFinishedSpans();
      // Root span is also created since no parent
      const genSpan = spans.find((s) => s.attributes[ATTR_GEN_AI_REQUEST_MODEL] === "gpt-4o");
      assert.ok(genSpan);

      // Content keys should be absent
      assert.strictEqual(
        genSpan!.attributes["gen_ai.input.messages"],
        undefined,
        "should not record input",
      );
      assert.strictEqual(
        genSpan!.attributes["gen_ai.output.messages"],
        undefined,
        "should not record output",
      );
    });

    it("records content when enabled", async () => {
      setup({ isContentRecordingEnabled: true });

      const span = makeSpan({
        spanId: "gen-with-content",
        spanData: {
          type: "generation",
          model: "gpt-4o",
          input: "What is 2+2?",
          output: "4",
        },
      });

      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      const spans = exporter.getFinishedSpans();
      const genSpan = spans.find((s) => s.attributes[ATTR_GEN_AI_REQUEST_MODEL] === "gpt-4o");
      assert.ok(genSpan);

      assert.ok(genSpan!.attributes["gen_ai.input.messages"], "should record input");
      assert.ok(genSpan!.attributes["gen_ai.output.messages"], "should record output");
    });
  });

  describe("error handling", () => {
    it("sets error status on failed spans", async () => {
      setup();

      const span = makeSpan({
        spanId: "err-1",
        spanData: { type: "generation", model: "gpt-4o" },
        error: { message: "Rate limit exceeded" },
      });

      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      const spans = exporter.getFinishedSpans();
      const genSpan = spans.find((s) => s.attributes[ATTR_GEN_AI_REQUEST_MODEL] === "gpt-4o");
      assert.ok(genSpan);
      assert.strictEqual(genSpan!.status.code, SpanStatusCode.ERROR);
      assert.strictEqual(genSpan!.status.message, "Rate limit exceeded");
    });
  });

  describe("suppressInvokeAgentInput", () => {
    it("suppresses input messages when flag is set", async () => {
      setup({ isContentRecordingEnabled: true, suppressInvokeAgentInput: true });

      const span = makeSpan({
        spanId: "resp-suppress",
        spanData: {
          type: "response",
          _response: {
            model: "gpt-4o",
            output: "Response text",
          },
          _input: [{ role: "user", content: "Secret instructions" }],
        },
      });

      await processor.onSpanStart(span);
      await processor.onSpanEnd(span);

      const spans = exporter.getFinishedSpans();
      const respSpan = spans.find((s) => s.attributes[ATTR_GEN_AI_REQUEST_MODEL] === "gpt-4o");
      assert.ok(respSpan);
      assert.strictEqual(
        respSpan!.attributes["gen_ai.input.messages"],
        undefined,
        "input should be suppressed",
      );
    });
  });
});
