// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, describe, it, vi } from "vitest";
import type { Span } from "@opentelemetry/api";
import type { Run } from "@langchain/core/tracers/base";
import {
  getOperationType,
  setOperationTypeAttribute,
  setAgentAttributes,
  setToolAttributes,
  setInputMessagesAttribute,
  setOutputMessagesAttribute,
  setModelAttribute,
  setProviderNameAttribute,
  setSessionIdAttribute,
  setSystemInstructionsAttribute,
  setTokenAttributes,
  isString,
} from "../../../../../src/genai/instrumentations/langchain/utils.js";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_MICROSOFT_SESSION_ID,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
} from "../../../../../src/genai/index.js";

function makeSpan(): Span & { attrs: Record<string, unknown> } {
  const attrs: Record<string, unknown> = {};
  return {
    attrs,
    setAttribute: vi.fn((key: string, value: unknown) => {
      attrs[key] = value;
      return this;
    }),
    setStatus: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
    addEvent: vi.fn(),
    isRecording: vi.fn(() => true),
    spanContext: vi.fn(),
    updateName: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
  } as unknown as Span & { attrs: Record<string, unknown> };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    name: "test-run",
    run_type: "llm",
    start_time: Date.now(),
    serialized: {},
    inputs: {},
    execution_order: 1,
    child_execution_order: 1,
    child_runs: [],
    tags: [],
    events: [],
    ...overrides,
  } as unknown as Run;
}

function makeLangGraphRun(overrides: Partial<Run> = {}): Run {
  return makeRun({
    run_type: "chain",
    name: "MyAgent",
    serialized: {
      id: ["langchain", "langgraph", "pregel", "CompiledStateGraph"],
    },
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isString", () => {
  it("returns true for strings", () => {
    assert.strictEqual(isString("hello"), true);
    assert.strictEqual(isString(""), true);
  });

  it("returns false for non-strings", () => {
    assert.strictEqual(isString(123), false);
    assert.strictEqual(isString(null), false);
    assert.strictEqual(isString(undefined), false);
    assert.strictEqual(isString({}), false);
  });
});

describe("getOperationType", () => {
  it("returns invoke_agent for LangGraph chain runs", () => {
    const run = makeLangGraphRun();
    assert.strictEqual(getOperationType(run), GEN_AI_OPERATION_INVOKE_AGENT);
  });

  it("returns execute_tool for tool runs", () => {
    const run = makeRun({ run_type: "tool" });
    assert.strictEqual(getOperationType(run), GEN_AI_OPERATION_EXECUTE_TOOL);
  });

  it("returns chat for llm runs", () => {
    const run = makeRun({ run_type: "llm" });
    assert.strictEqual(getOperationType(run), GEN_AI_OPERATION_CHAT);
  });

  it("returns unknown for unrecognized run types", () => {
    const run = makeRun({ run_type: "retriever" as Run["run_type"] });
    assert.strictEqual(getOperationType(run), "unknown");
  });

  it("returns unknown for chain runs that are not LangGraph agents", () => {
    const run = makeRun({ run_type: "chain", serialized: {} });
    assert.strictEqual(getOperationType(run), "unknown");
  });
});

describe("setOperationTypeAttribute", () => {
  it("sets the operation name attribute on the span", () => {
    const span = makeSpan();
    setOperationTypeAttribute("chat", span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_OPERATION_NAME && c[1] === "chat",
      ),
    );
  });
});

describe("setAgentAttributes", () => {
  it("sets agent name for LangGraph agent runs", () => {
    const span = makeSpan();
    const run = makeLangGraphRun({ name: "WeatherAgent" });
    setAgentAttributes(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_AGENT_NAME && c[1] === "WeatherAgent",
      ),
    );
  });

  it("does not set agent name for non-agent runs", () => {
    const span = makeSpan();
    const run = makeRun({ run_type: "llm", name: "SomeModel" });
    setAgentAttributes(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });
});

describe("setToolAttributes", () => {
  it("sets tool attributes for tool runs", () => {
    const span = makeSpan();
    const run = makeRun({
      run_type: "tool",
      name: "search_web",
      serialized: { name: "search_web" },
      inputs: { input: "query text" },
      outputs: {
        output: {
          kwargs: { content: "result content" },
          tool_call_id: "tc-123",
        },
      },
    });
    setToolAttributes(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some((c: unknown[]) => c[0] === ATTR_GEN_AI_TOOL_NAME && c[1] === "search_web"),
    );
    assert.ok(calls.some((c: unknown[]) => c[0] === ATTR_GEN_AI_TOOL_CALL_ARGUMENTS));
    assert.ok(calls.some((c: unknown[]) => c[0] === ATTR_GEN_AI_TOOL_CALL_RESULT));
    assert.ok(calls.some((c: unknown[]) => c[0] === ATTR_GEN_AI_TOOL_TYPE && c[1] === "extension"));
    assert.ok(calls.some((c: unknown[]) => c[0] === ATTR_GEN_AI_TOOL_CALL_ID && c[1] === "tc-123"));
  });

  it("does nothing for non-tool runs", () => {
    const span = makeSpan();
    const run = makeRun({ run_type: "llm" });
    setToolAttributes(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });

  it("does nothing when serialized is missing", () => {
    const span = makeSpan();
    const run = makeRun({
      run_type: "tool",
      serialized: undefined as unknown as Record<string, unknown>,
    });
    setToolAttributes(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });
});

describe("setInputMessagesAttribute", () => {
  it("extracts simple format user messages", () => {
    const span = makeSpan();
    const run = makeRun({
      run_type: "llm",
      inputs: {
        messages: [
          [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there" },
          ],
        ],
      },
    });
    setInputMessagesAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const msgCall = calls.find((c: unknown[]) => c[0] === ATTR_GEN_AI_INPUT_MESSAGES);
    assert.ok(msgCall, "should set input messages");
    const parsed = JSON.parse(msgCall![1] as string);
    assert.ok(parsed.includes("Hello"));
    // Assistant messages should be filtered out for input
    assert.ok(!parsed.includes("Hi there"));
  });

  it("extracts LangChain lc_kwargs format", () => {
    const span = makeSpan();
    const run = makeRun({
      run_type: "llm",
      inputs: {
        messages: [[{ lc_type: "human", lc_kwargs: { content: "What is 2+2?" } }]],
      },
    });
    setInputMessagesAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const msgCall = calls.find((c: unknown[]) => c[0] === ATTR_GEN_AI_INPUT_MESSAGES);
    assert.ok(msgCall);
    assert.ok(JSON.parse(msgCall![1] as string).includes("What is 2+2?"));
  });

  it("extracts messages using id array-based type detection", () => {
    const span = makeSpan();
    // When role/lc_type/type are absent, getMessageType falls through to the id array check.
    // Content is extracted via lc_kwargs.
    const run = makeRun({
      run_type: "llm",
      inputs: {
        messages: [
          [
            {
              lc_kwargs: { content: "Build this" },
              id: ["langchain", "schema", "messages", "HumanMessage"],
            },
          ],
        ],
      },
    });
    setInputMessagesAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const msgCall = calls.find((c: unknown[]) => c[0] === ATTR_GEN_AI_INPUT_MESSAGES);
    assert.ok(msgCall);
    assert.ok(JSON.parse(msgCall![1] as string).includes("Build this"));
  });

  it("does nothing when messages is not an array", () => {
    const span = makeSpan();
    const run = makeRun({ inputs: { messages: "not-an-array" } });
    setInputMessagesAttribute(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });
});

describe("setOutputMessagesAttribute", () => {
  it("extracts output from messages array", () => {
    const span = makeSpan();
    const run = makeRun({
      run_type: "llm",
      outputs: {
        messages: [{ role: "assistant", content: "Here is the answer" }],
      },
    });
    setOutputMessagesAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const msgCall = calls.find((c: unknown[]) => c[0] === ATTR_GEN_AI_OUTPUT_MESSAGES);
    assert.ok(msgCall);
    assert.ok(JSON.parse(msgCall![1] as string).includes("Here is the answer"));
  });

  it("extracts output from generations format", () => {
    const span = makeSpan();
    const run = makeRun({
      run_type: "llm",
      outputs: {
        generations: [
          [
            {
              text: "Generated text",
            },
          ],
        ],
      },
    });
    setOutputMessagesAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const msgCall = calls.find((c: unknown[]) => c[0] === ATTR_GEN_AI_OUTPUT_MESSAGES);
    assert.ok(msgCall);
    assert.ok(JSON.parse(msgCall![1] as string).includes("Generated text"));
  });

  it("extracts output from single message object", () => {
    const span = makeSpan();
    const run = makeLangGraphRun({
      outputs: {
        message: { role: "assistant", content: "Single response" },
      },
    });
    setOutputMessagesAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const msgCall = calls.find((c: unknown[]) => c[0] === ATTR_GEN_AI_OUTPUT_MESSAGES);
    assert.ok(msgCall);
    assert.ok(JSON.parse(msgCall![1] as string).includes("Single response"));
  });

  it("does nothing when outputs is undefined", () => {
    const span = makeSpan();
    const run = makeRun({ outputs: undefined });
    setOutputMessagesAttribute(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });
});

describe("setModelAttribute", () => {
  it("extracts model from response_metadata", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: {
        generations: [[{ message: { kwargs: { response_metadata: { model_name: "gpt-4o" } } } }]],
      },
    });
    setModelAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "gpt-4o",
      ),
    );
  });

  it("extracts model from extra.metadata.ls_model_name", () => {
    const span = makeSpan();
    const run = makeRun({
      extra: { metadata: { ls_model_name: "claude-3" } },
    });
    setModelAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "claude-3",
      ),
    );
  });

  it("extracts model from extra.invocation_params.model", () => {
    const span = makeSpan();
    const run = makeRun({
      extra: { invocation_params: { model: "llama-3" } },
    });
    setModelAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "llama-3",
      ),
    );
  });

  it("does nothing when no model is found", () => {
    const span = makeSpan();
    const run = makeRun();
    setModelAttribute(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });
});

describe("setProviderNameAttribute", () => {
  it("sets provider name from metadata", () => {
    const span = makeSpan();
    const run = makeRun({ extra: { metadata: { ls_provider: "OpenAI" } } });
    setProviderNameAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_PROVIDER_NAME && c[1] === "openai",
      ),
    );
  });

  it("does nothing when no provider metadata", () => {
    const span = makeSpan();
    const run = makeRun();
    setProviderNameAttribute(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });
});

describe("setSessionIdAttribute", () => {
  it("extracts session_id from metadata", () => {
    const span = makeSpan();
    const run = makeRun({ extra: { metadata: { session_id: "sess-123" } } });
    setSessionIdAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_MICROSOFT_SESSION_ID && c[1] === "sess-123",
      ),
    );
  });

  it("falls back to conversation_id", () => {
    const span = makeSpan();
    const run = makeRun({ extra: { metadata: { conversation_id: "conv-456" } } });
    setSessionIdAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_MICROSOFT_SESSION_ID && c[1] === "conv-456",
      ),
    );
  });

  it("falls back to thread_id", () => {
    const span = makeSpan();
    const run = makeRun({ extra: { metadata: { thread_id: "thread-789" } } });
    setSessionIdAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_MICROSOFT_SESSION_ID && c[1] === "thread-789",
      ),
    );
  });

  it("does nothing for empty session id", () => {
    const span = makeSpan();
    const run = makeRun({ extra: { metadata: { session_id: "" } } });
    setSessionIdAttribute(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });

  it("does nothing when no metadata", () => {
    const span = makeSpan();
    const run = makeRun();
    setSessionIdAttribute(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });
});

describe("setSystemInstructionsAttribute", () => {
  it("extracts from prompts array", () => {
    const span = makeSpan();
    const run = makeRun({
      inputs: { prompts: ["You are a helpful assistant.", "Be concise."] },
    });
    setSystemInstructionsAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) =>
          c[0] === ATTR_GEN_AI_SYSTEM_INSTRUCTIONS &&
          (c[1] as string).includes("You are a helpful assistant."),
      ),
    );
  });

  it("extracts from system messages with lc_type", () => {
    const span = makeSpan();
    const run = makeRun({
      inputs: {
        messages: [
          { lc_type: "system", lc_kwargs: { content: "System prompt here" } },
          { lc_type: "human", lc_kwargs: { content: "User message" } },
        ],
      },
    });
    setSystemInstructionsAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) =>
          c[0] === ATTR_GEN_AI_SYSTEM_INSTRUCTIONS &&
          (c[1] as string).includes("System prompt here"),
      ),
    );
  });

  it("does nothing when no inputs", () => {
    const span = makeSpan();
    const run = makeRun({ inputs: undefined as unknown as Record<string, unknown> });
    setSystemInstructionsAttribute(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });
});

describe("setTokenAttributes", () => {
  it("extracts token usage from usage_metadata", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: {
        generations: [[{ message: { usage_metadata: { input_tokens: 100, output_tokens: 50 } } }]],
      },
    });
    setTokenAttributes(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some((c: unknown[]) => c[0] === ATTR_GEN_AI_USAGE_INPUT_TOKENS && c[1] === 100),
    );
    assert.ok(
      calls.some((c: unknown[]) => c[0] === ATTR_GEN_AI_USAGE_OUTPUT_TOKENS && c[1] === 50),
    );
  });

  it("extracts from response_metadata.tokenUsage", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: {
        generations: [
          [
            {
              message: {
                kwargs: {
                  response_metadata: { tokenUsage: { input_tokens: 10, output_tokens: 5 } },
                },
              },
            },
          ],
        ],
      },
    });
    setTokenAttributes(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(calls.some((c: unknown[]) => c[0] === ATTR_GEN_AI_USAGE_INPUT_TOKENS && c[1] === 10));
    assert.ok(calls.some((c: unknown[]) => c[0] === ATTR_GEN_AI_USAGE_OUTPUT_TOKENS && c[1] === 5));
  });

  it("does nothing when no usage data", () => {
    const span = makeSpan();
    const run = makeRun({ outputs: {} });
    setTokenAttributes(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });
});
