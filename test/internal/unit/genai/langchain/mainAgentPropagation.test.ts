// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * End-to-end test that the LangChain tracer sets agent identity attributes on
 * the `invoke_agent` span BEFORE any child runs start, so that
 * GenAIMainAgentSpanProcessor.onStart can read them from the parent and
 * propagate them onto child `chat`/`execute_tool` spans.
 *
 * Mirrors microsoft/opentelemetry-distro-python PR #171
 * (tests/langchain/test_main_agent_propagation.py).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Run } from "@langchain/core/tracers/base";

import { LangChainTracer } from "../../../../../src/genai/instrumentations/langchain/tracer.js";
import {
  GEN_AI_MAIN_AGENT_NAME_KEY,
  GenAIMainAgentSpanProcessor,
} from "../../../../../src/genai/mainAgent/index.js";
import { ATTR_GEN_AI_AGENT_NAME } from "../../../../../src/genai/semconv.js";

function makeAgentRun(overrides: Partial<Run> = {}): Run {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: "MyAgent",
    run_type: "chain",
    start_time: Date.now(),
    end_time: Date.now() + 100,
    serialized: {
      id: ["langchain", "langgraph", "pregel", "CompiledStateGraph"],
    },
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

function makeChatRun(parentId: string, overrides: Partial<Run> = {}): Run {
  return {
    id: `chat-${Math.random().toString(36).slice(2, 8)}`,
    name: "gpt-4o",
    run_type: "llm",
    parent_run_id: parentId,
    start_time: Date.now(),
    end_time: Date.now() + 100,
    serialized: {},
    inputs: {},
    outputs: {},
    execution_order: 2,
    child_execution_order: 2,
    child_runs: [],
    tags: [],
    events: [],
    ...overrides,
  } as unknown as Run;
}

describe("LangChainTracer × GenAIMainAgentSpanProcessor propagation", () => {
  let provider: BasicTracerProvider;
  let memoryExporter: InMemorySpanExporter;

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new GenAIMainAgentSpanProcessor(), new SimpleSpanProcessor(memoryExporter)],
    });
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it("sets gen_ai.agent.name on invoke_agent span at start so child chat span inherits microsoft.gen_ai.main_agent.name", async () => {
    const tracer = provider.getTracer("langchain-test");
    const lct = new LangChainTracer(tracer);

    // 1) Start the agent run (this opens the invoke_agent span and must set
    //    gen_ai.agent.name BEFORE any child runs start).
    const agentRun = makeAgentRun({ name: "MyAgent" });
    await lct.onRunCreate(agentRun);

    // 2) While the agent run is still open, start a child chat run. The
    //    GenAIMainAgentSpanProcessor.onStart for this span runs *now*, and
    //    must see gen_ai.agent.name on the parent span attributes.
    const chatRun = makeChatRun(agentRun.id, { name: "gpt-4o" });
    await lct.onRunCreate(chatRun);

    // 3) End both runs.
    // _endTrace is protected; cast to invoke for test purposes.
    await (lct as unknown as { _endTrace: (r: Run) => Promise<void> })._endTrace(chatRun);
    await (lct as unknown as { _endTrace: (r: Run) => Promise<void> })._endTrace(agentRun);

    const finished = memoryExporter.getFinishedSpans();
    const chatSpan = finished.find((s) => s.name.startsWith("chat"));
    const agentSpan = finished.find((s) => s.name.startsWith("invoke_agent"));
    expect(agentSpan, "invoke_agent span should be exported").toBeDefined();
    expect(chatSpan, "chat span should be exported").toBeDefined();

    // The parent invoke_agent span must end up with the agent name set.
    expect(agentSpan!.attributes[ATTR_GEN_AI_AGENT_NAME]).toBe("MyAgent");

    // Critical: the child chat span must have inherited the main-agent name
    // via the GenAIMainAgentSpanProcessor at on_start time. If the LangChain
    // tracer set gen_ai.agent.name only at _endTrace, this would be undefined.
    expect(chatSpan!.attributes[GEN_AI_MAIN_AGENT_NAME_KEY]).toBe("MyAgent");
  });
});
