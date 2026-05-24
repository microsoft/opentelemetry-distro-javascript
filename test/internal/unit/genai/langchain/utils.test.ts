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
  setResponseIdAttribute,
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
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_MICROSOFT_SESSION_ID,
  ATTR_GEN_AI_CONVERSATION_ID,
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
    assert.ok(JSON.stringify(parsed).includes("Hello"));
    // Both messages should be included in structured input
    assert.ok(JSON.stringify(parsed).includes("Hi there"));
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
    assert.ok(JSON.stringify(JSON.parse(msgCall![1] as string)).includes("What is 2+2?"));
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
    assert.ok(JSON.stringify(JSON.parse(msgCall![1] as string)).includes("Build this"));
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
    assert.ok(JSON.stringify(JSON.parse(msgCall![1] as string)).includes("Here is the answer"));
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
    assert.ok(JSON.stringify(JSON.parse(msgCall![1] as string)).includes("Generated text"));
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
    assert.ok(JSON.stringify(JSON.parse(msgCall![1] as string)).includes("Single response"));
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

  it("populates both request and response model when response_metadata is the only source", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: {
        generations: [
          [{ message: { kwargs: { response_metadata: { model_name: "gpt-4o-2024-08-06" } } } }],
        ],
      },
    });
    setModelAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "gpt-4o-2024-08-06",
      ),
      "request model should fall back to response model when no request-side identifier exists",
    );
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_MODEL && c[1] === "gpt-4o-2024-08-06",
      ),
      "response model should be set from response_metadata.model_name",
    );
  });

  it("prefers response model over request-side identifier for AzureChatOpenAI runs", () => {
    // LangChain JS hardcodes ls_model_name to "gpt-3.5-turbo" for AzureChatOpenAI
    // (https://github.com/langchain-ai/langchainjs/issues/10874), so for that
    // client the server-reported model is a closer approximation of the
    // requested model than the request-side identifier.
    const span = makeSpan();
    const run = makeRun({
      serialized: {
        id: ["langchain", "chat_models", "azure_openai", "AzureChatOpenAI"],
      },
      extra: { invocation_params: { model: "gpt-4o" } },
      outputs: {
        generations: [
          [{ message: { kwargs: { response_metadata: { model_name: "gpt-4o-2024-08-06" } } } }],
        ],
      },
    });
    setModelAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "gpt-4o-2024-08-06",
      ),
      "request model should prefer the response-side identifier for AzureChatOpenAI",
    );
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_MODEL && c[1] === "gpt-4o-2024-08-06",
      ),
      "response model should come from response_metadata.model_name",
    );
  });

  it("avoids the AzureChatOpenAI ls_model_name=gpt-3.5-turbo regression", () => {
    // Regression test: AzureChatOpenAI sets ls_model_name to the BaseChatOpenAI
    // default ("gpt-3.5-turbo") regardless of the configured deployment. The
    // response-side model_name carries the actual served model, which we should
    // emit as gen_ai.request.model to avoid misattributing the request.
    const span = makeSpan();
    const run = makeRun({
      serialized: {
        id: ["langchain", "chat_models", "azure_openai", "AzureChatOpenAI"],
      },
      extra: { metadata: { ls_model_name: "gpt-3.5-turbo" } },
      outputs: {
        generations: [
          [
            {
              message: {
                kwargs: { response_metadata: { model_name: "gpt-4o-mini-2024-07-18" } },
              },
            },
          ],
        ],
      },
    });
    setModelAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "gpt-4o-mini-2024-07-18",
      ),
      "request model should use the server-reported model rather than the LangChain default",
    );
    assert.ok(
      !calls.some((c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "gpt-3.5-turbo"),
      "request model must not fall back to the hardcoded ls_model_name default",
    );
  });

  it("keeps request and response model separate for non-Azure clients (e.g. ChatOpenAI)", () => {
    // For plain ChatOpenAI / Foundry deployments the request-side identifier
    // (deployment alias or `model` kwarg) is correct and must be used as-is for
    // gen_ai.request.model. Only AzureChatOpenAI needs the response-model
    // workaround.
    const span = makeSpan();
    const run = makeRun({
      serialized: {
        id: ["langchain", "chat_models", "openai", "ChatOpenAI"],
      },
      extra: { invocation_params: { model: "deployment-o4-mini" } },
      outputs: {
        generations: [
          [
            {
              message: {
                kwargs: { response_metadata: { model_name: "o4-mini-2025-04-16" } },
              },
            },
          ],
        ],
      },
    });
    setModelAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "deployment-o4-mini",
      ),
      "request model should come from invocation_params.model for non-Azure clients",
    );
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_MODEL && c[1] === "o4-mini-2025-04-16",
      ),
      "response model should come from response_metadata.model_name",
    );
    assert.ok(
      !calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "o4-mini-2025-04-16",
      ),
      "non-Azure runs must not overwrite the request model with the response model",
    );
  });

  it("uses llmOutput.model_name as a response-model source", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: { llmOutput: { model_name: "o4-mini-2025-04-16" } },
    });
    setModelAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_MODEL && c[1] === "o4-mini-2025-04-16",
      ),
    );
  });

  // Responses API (useResponsesApi: true) — LangChain's openai provider
  // populates response_metadata.model (canonical) and, for backwards compat
  // with chat completion calls, also response_metadata.model_name. We must
  // honor both shapes so non-OpenAI RAPI providers (e.g. @langchain/perplexity)
  // and any future major where the model_name alias is dropped keep working.
  it("RAPI v1: extracts response model from response_metadata.model when only `model` is set", () => {
    const span = makeSpan();
    const run = makeRun({
      serialized: {
        id: ["langchain", "chat_models", "openai", "ChatOpenAI"],
      },
      extra: { invocation_params: { model: "deployment-o4-mini" } },
      outputs: {
        generations: [
          [
            {
              message: {
                response_metadata: {
                  model: "o4-mini-2025-04-16",
                  model_provider: "openai",
                  id: "resp_abc",
                },
              },
            },
          ],
        ],
      },
    });
    setModelAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "deployment-o4-mini",
      ),
      "request model should come from invocation_params.model for non-Azure RAPI clients",
    );
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_MODEL && c[1] === "o4-mini-2025-04-16",
      ),
      "response model should be sourced from response_metadata.model (RAPI canonical field)",
    );
  });

  it("RAPI v1: prefers response_metadata.model over response_metadata.model_name when both are present", () => {
    const span = makeSpan();
    const run = makeRun({
      serialized: {
        id: ["langchain", "chat_models", "openai", "ChatOpenAI"],
      },
      extra: { invocation_params: { model: "deployment-o4-mini" } },
      outputs: {
        generations: [
          [
            {
              message: {
                response_metadata: {
                  model: "o4-mini-2025-04-16",
                  // LangChain duplicates `model` into `model_name` "for
                    // backwards compat with chat completion calls". We pin a
                    // distinct sentinel here so the assertion proves we read
                    // the canonical `model` field first rather than coupling
                    // to the `model_name` alias.
                    model_name: "model_name-alias-should-be-ignored",
                    model_provider: "openai",
                  },
              },
            },
          ],
        ],
      },
    });
    setModelAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_MODEL && c[1] === "o4-mini-2025-04-16",
      ),
      "response model should come from response_metadata.model (canonical)",
    );
    assert.ok(
      !calls.some(
        (c: unknown[]) =>
          c[0] === ATTR_GEN_AI_RESPONSE_MODEL && c[1] === "model_name-alias-should-be-ignored",
      ),
      "response model must not fall back to the model_name alias when model is set",
    );
  });

  it("RAPI v0: extracts response model from kwargs.response_metadata.model", () => {
    const span = makeSpan();
    const run = makeRun({
      serialized: {
        id: ["langchain", "chat_models", "openai", "ChatOpenAI"],
      },
      extra: { invocation_params: { model: "deployment-o4-mini" } },
      outputs: {
        generations: [
          [
            {
              message: {
                kwargs: {
                  response_metadata: {
                    model: "o4-mini-2025-04-16",
                    model_provider: "openai",
                  },
                },
              },
            },
          ],
        ],
      },
    });
    setModelAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "deployment-o4-mini",
      ),
    );
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_MODEL && c[1] === "o4-mini-2025-04-16",
      ),
    );
  });

  it("AzureChatOpenAI + RAPI: response_metadata.model still drives the workaround request model", () => {
    // Combines the AzureChatOpenAI ls_model_name=gpt-3.5-turbo regression (see
    // langchain-ai/langchainjs#10874) with the RAPI response shape. The
    // response-side model must populate gen_ai.request.model (via the Azure
    // workaround) AND gen_ai.response.model, even when LangChain only sets
    // `model` (no `model_name` alias).
    const span = makeSpan();
    const run = makeRun({
      serialized: {
        id: ["langchain", "chat_models", "azure_openai", "AzureChatOpenAI"],
      },
      extra: { metadata: { ls_model_name: "gpt-3.5-turbo" } },
      outputs: {
        generations: [
          [
            {
              message: {
                response_metadata: {
                  model: "gpt-4o-mini-2024-07-18",
                  model_provider: "openai",
                },
              },
            },
          ],
        ],
      },
    });
    setModelAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_REQUEST_MODEL && c[1] === "gpt-4o-mini-2024-07-18",
      ),
      "AzureChatOpenAI request model should use response_metadata.model when model_name is absent",
    );
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_MODEL && c[1] === "gpt-4o-mini-2024-07-18",
      ),
    );
  });
});

describe("setResponseIdAttribute", () => {
  it("extracts response id from AIMessage.id (v1)", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: { generations: [[{ message: { id: "chatcmpl-abc123" } }]] },
    });
    setResponseIdAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_ID && c[1] === "chatcmpl-abc123",
      ),
    );
  });

  it("extracts response id from AIMessage kwargs.id (v0)", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: { generations: [[{ message: { kwargs: { id: "chatcmpl-xyz" } } }]] },
    });
    setResponseIdAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_ID && c[1] === "chatcmpl-xyz",
      ),
    );
  });

  it("extracts response id from llmOutput.id", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: { llmOutput: { id: "resp-42" } },
    });
    setResponseIdAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_ID && c[1] === "resp-42",
      ),
    );
  });

  it("extracts response id from response_metadata.id (v1, top-level)", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: {
        generations: [[{ message: { response_metadata: { id: "chatcmpl-meta-v1" } } }]],
      },
    });
    setResponseIdAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_ID && c[1] === "chatcmpl-meta-v1",
      ),
    );
  });

  it("extracts response id from response_metadata.id nested under kwargs (v0)", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: {
        generations: [[{ message: { kwargs: { response_metadata: { id: "chatcmpl-meta-v0" } } } }]],
      },
    });
    setResponseIdAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_ID && c[1] === "chatcmpl-meta-v0",
      ),
    );
  });

  it("prefers response_metadata.id over message.id when both are present", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: {
        generations: [
          [
            {
              message: {
                id: "ignored-message-id",
                response_metadata: { id: "preferred-metadata-id" },
              },
            },
          ],
        ],
      },
    });
    setResponseIdAttribute(run, span);
    const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    assert.ok(
      calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_ID && c[1] === "preferred-metadata-id",
      ),
    );
    assert.ok(
      !calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_RESPONSE_ID && c[1] === "ignored-message-id",
      ),
    );
  });

  it("ignores non-primitive AIMessage.id values (e.g. serialization class arrays)", () => {
    const span = makeSpan();
    const run = makeRun({
      outputs: {
        generations: [
          [
            {
              message: {
                // LangChain Serializable.id is sometimes an array of class
                // hierarchy names; it must not be emitted as a response id.
                id: ["langchain", "schema", "messages", "AIMessage"],
              },
            },
          ],
        ],
      },
    });
    setResponseIdAttribute(run, span);
    assert.strictEqual((span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });

  it("does nothing when no response id is found", () => {
    const span = makeSpan();
    const run = makeRun();
    setResponseIdAttribute(run, span);
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

  it("sets conversation_id as separate attribute", () => {
    const span = makeSpan();
    const run = makeRun({ extra: { metadata: { conversation_id: "conv-456" } } });
    setSessionIdAttribute(run, span);
    assert.ok(
      (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0] === ATTR_GEN_AI_CONVERSATION_ID && c[1] === "conv-456",
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
