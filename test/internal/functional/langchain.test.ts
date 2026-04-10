// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Functional test for LangChain instrumentation.
 *
 * Exercises the full pipeline: LangChainTracer receives LangChain Run callbacks
 * and produces OTel spans captured by an InMemorySpanExporter. Validates that
 * the correct spans, attributes, and parent-child relationships are emitted.
 */

import { afterEach, assert, describe, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Run } from "@langchain/core/tracers/base";
import { LangChainTracer } from "../../../src/genai/instrumentations/langchain/tracer.js";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_MICROSOFT_SESSION_ID,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
} from "../../../src/genai/index.js";

let provider: BasicTracerProvider;
let exporter: InMemorySpanExporter;
let langchainTracer: LangChainTracer;

function setup(options?: { isContentRecordingEnabled?: boolean }) {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const tracer = provider.getTracer("test-langchain", "1.0.0");
  langchainTracer = new LangChainTracer(tracer, options);
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    name: "test-run",
    run_type: "llm",
    start_time: Date.now(),
    end_time: Date.now() + 100,
    serialized: {},
    inputs: {},
    outputs: {},
    execution_order: 1,
    child_execution_order: 1,
    child_runs: [],
    tags: [],
    events: [],
    ...overrides,
  } as unknown as Run;
}

afterEach(async () => {
  if (provider) {
    await provider.forceFlush();
    await provider.shutdown();
  }
  exporter?.reset();
});

describe("LangChain Instrumentation Functional Tests", () => {
  describe("single LLM call", () => {
    it("produces a span with chat operation and model attributes", async () => {
      setup();
      const run = makeRun({
        id: "llm-1",
        name: "ChatOpenAI",
        run_type: "llm",
        extra: {
          metadata: { ls_model_name: "gpt-4o", ls_provider: "OpenAI" },
        },
        outputs: {
          generations: [
            [
              {
                message: {
                  usage_metadata: { input_tokens: 50, output_tokens: 20 },
                  kwargs: { response_metadata: { model_name: "gpt-4o" } },
                },
              },
            ],
          ],
        },
      });

      await langchainTracer.onRunCreate(run);
      await (langchainTracer as unknown as { _endTrace(r: Run): Promise<void> })._endTrace(run);

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);

      const span = spans[0];
      assert.ok(span.name.includes("chat"), `span name "${span.name}" should contain "chat"`);
      assert.strictEqual(span.kind, SpanKind.INTERNAL);
      assert.strictEqual(span.status.code, SpanStatusCode.OK);
      assert.strictEqual(span.attributes[ATTR_GEN_AI_OPERATION_NAME], GEN_AI_OPERATION_CHAT);
      assert.strictEqual(span.attributes[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
      assert.strictEqual(span.attributes[ATTR_GEN_AI_PROVIDER_NAME], "openai");
      assert.strictEqual(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS], 50);
      assert.strictEqual(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS], 20);
    });
  });

  describe("agent with tool and LLM children", () => {
    it("produces parent-child spans matching the LangGraph execution flow", async () => {
      setup({ isContentRecordingEnabled: true });

      // 1. Agent (parent) run
      const agentRun = makeRun({
        id: "agent-1",
        name: "ResearchAgent",
        run_type: "chain",
        serialized: {
          id: ["langchain", "langgraph", "pregel", "CompiledStateGraph"],
        },
        extra: { metadata: { session_id: "sess-abc" } },
        outputs: {
          messages: [{ role: "assistant", content: "Here is my research." }],
        },
      });

      // 2. Tool run (child of agent)
      const toolRun = makeRun({
        id: "tool-1",
        parent_run_id: "agent-1",
        name: "web_search",
        run_type: "tool",
        serialized: { name: "web_search" },
        inputs: { input: "opentelemetry langchain" },
        outputs: {
          output: {
            kwargs: { content: "search results..." },
            tool_call_id: "tc-1",
          },
        },
      });

      // 3. LLM run (child of agent)
      const llmRun = makeRun({
        id: "llm-1",
        parent_run_id: "agent-1",
        name: "ChatOpenAI",
        run_type: "llm",
        extra: {
          metadata: { ls_model_name: "gpt-4o", ls_provider: "OpenAI" },
        },
        inputs: {
          messages: [
            [
              { role: "system", content: "You are a research assistant." },
              { role: "user", content: "Find info about OTel" },
            ],
          ],
        },
        outputs: {
          generations: [
            [
              {
                text: "Here is the information...",
                message: {
                  role: "assistant",
                  content: "Here is the information...",
                  usage_metadata: { input_tokens: 200, output_tokens: 80 },
                  kwargs: { response_metadata: { model_name: "gpt-4o" } },
                },
              },
            ],
          ],
        },
      });

      // Simulate LangChain callback order: agent starts, then tool, then llm
      await langchainTracer.onRunCreate(agentRun);
      await langchainTracer.onRunCreate(toolRun);
      await langchainTracer.onRunCreate(llmRun);

      // End in reverse order (children end before parent)
      await (langchainTracer as unknown as { _endTrace(r: Run): Promise<void> })._endTrace(llmRun);
      await (langchainTracer as unknown as { _endTrace(r: Run): Promise<void> })._endTrace(toolRun);
      await (langchainTracer as unknown as { _endTrace(r: Run): Promise<void> })._endTrace(
        agentRun,
      );

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 3, `expected 3 spans, got ${spans.length}`);

      // Find spans by operation
      const agentSpan = spans.find(
        (s) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === GEN_AI_OPERATION_INVOKE_AGENT,
      );
      const toolSpan = spans.find(
        (s) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === GEN_AI_OPERATION_EXECUTE_TOOL,
      );
      const llmSpan = spans.find(
        (s) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === GEN_AI_OPERATION_CHAT,
      );

      assert.ok(agentSpan, "agent span should exist");
      assert.ok(toolSpan, "tool span should exist");
      assert.ok(llmSpan, "llm span should exist");

      // Verify agent span attributes
      assert.ok(agentSpan!.name.includes("invoke_agent"));
      assert.strictEqual(agentSpan!.attributes[ATTR_GEN_AI_AGENT_NAME], "ResearchAgent");
      assert.strictEqual(agentSpan!.attributes[ATTR_MICROSOFT_SESSION_ID], "sess-abc");

      // Verify tool span attributes
      assert.ok(toolSpan!.name.includes("execute_tool"));
      assert.strictEqual(toolSpan!.attributes[ATTR_GEN_AI_TOOL_NAME], "web_search");

      // Verify LLM span attributes
      assert.ok(llmSpan!.name.includes("chat"));
      assert.strictEqual(llmSpan!.attributes[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
      assert.strictEqual(llmSpan!.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS], 200);
      assert.strictEqual(llmSpan!.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS], 80);

      // Verify parent-child: tool and LLM spans should have the agent as parent
      assert.strictEqual(
        toolSpan!.parentSpanContext?.spanId,
        agentSpan!.spanContext().spanId,
        "tool span should be child of agent span",
      );
      assert.strictEqual(
        llmSpan!.parentSpanContext?.spanId,
        agentSpan!.spanContext().spanId,
        "llm span should be child of agent span",
      );
    });
  });

  describe("content recording gating", () => {
    it("does not record message content when disabled", async () => {
      setup({ isContentRecordingEnabled: false });

      const run = makeRun({
        id: "llm-no-content",
        name: "ChatOpenAI",
        run_type: "llm",
        inputs: {
          messages: [[{ role: "user", content: "Secret question" }]],
        },
        outputs: {
          generations: [[{ text: "Secret answer" }]],
        },
      });

      await langchainTracer.onRunCreate(run);
      await (langchainTracer as unknown as { _endTrace(r: Run): Promise<void> })._endTrace(run);

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);

      const span = spans[0];
      assert.strictEqual(
        span.attributes[ATTR_GEN_AI_INPUT_MESSAGES],
        undefined,
        "should not record input messages",
      );
      assert.strictEqual(
        span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES],
        undefined,
        "should not record output messages",
      );
    });

    it("records message content when enabled", async () => {
      setup({ isContentRecordingEnabled: true });

      const run = makeRun({
        id: "llm-with-content",
        name: "ChatOpenAI",
        run_type: "llm",
        inputs: {
          messages: [[{ role: "user", content: "What is 2+2?" }]],
        },
        outputs: {
          generations: [[{ text: "4" }]],
        },
      });

      await langchainTracer.onRunCreate(run);
      await (langchainTracer as unknown as { _endTrace(r: Run): Promise<void> })._endTrace(run);

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);

      const span = spans[0];
      assert.ok(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES], "should record input messages");
      assert.ok(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES], "should record output messages");
    });
  });

  describe("error handling", () => {
    it("sets error status and message on failed runs", async () => {
      setup();

      const run = makeRun({
        id: "llm-error",
        name: "ChatOpenAI",
        run_type: "llm",
        error: "Rate limit exceeded",
      });

      await langchainTracer.onRunCreate(run);
      await (langchainTracer as unknown as { _endTrace(r: Run): Promise<void> })._endTrace(run);

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);

      const span = spans[0];
      assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
      assert.strictEqual(span.attributes["error.message"], "Rate limit exceeded");
    });
  });

  describe("internal run filtering", () => {
    it("does not create spans for langsmith:hidden or Branch runs", async () => {
      setup();

      const hiddenRun = makeRun({ id: "hidden-1", tags: ["langsmith:hidden"] });
      const branchRun = makeRun({
        id: "branch-1",
        name: "BranchDecision",
        run_type: "chain",
        serialized: {},
      });

      await langchainTracer.onRunCreate(hiddenRun);
      await langchainTracer.onRunCreate(branchRun);

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 0, "no spans should be created for internal runs");
    });
  });
});
