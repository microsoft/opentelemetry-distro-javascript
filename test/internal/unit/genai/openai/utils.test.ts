// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert, describe, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span as AgentsSpan, SpanData } from "@openai/agents-core";
import {
  safeJsonDumps,
  getSpanName,
  getSpanKind,
  getSpanStatus,
  getAttributesFromGenerationSpanData,
  getAttributesFromFunctionSpanData,
  getAttributesFromMCPListToolsSpanData,
  getAttributesFromResponse,
  buildInputMessages,
  buildOutputMessages,
  CONTENT_KEYS,
  KEY_MAPPINGS,
} from "../../../../../src/genai/instrumentations/openai/utils.js";
import {
  GEN_AI_SPAN_KIND_AGENT,
  GEN_AI_SPAN_KIND_CHAIN,
  GEN_AI_SPAN_KIND_CHAT,
  GEN_AI_SPAN_KIND_TOOL,
  GEN_AI_REQUEST_CONTENT_KEY,
  GEN_AI_RESPONSE_CONTENT_KEY,
} from "../../../../../src/genai/instrumentations/openai/semconv.js";
import {
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from "../../../../../src/genai/index.js";

function makeAgentsSpan(overrides: Partial<AgentsSpan<SpanData>> = {}): AgentsSpan<SpanData> {
  return {
    spanId: "span-1",
    traceId: "trace-1",
    parentId: undefined,
    startedAt: new Date().toISOString(),
    endedAt: undefined,
    spanData: { type: "agent" } as SpanData,
    error: undefined,
    ...overrides,
  } as unknown as AgentsSpan<SpanData>;
}

describe("OpenAI Utils", () => {
  describe("safeJsonDumps", () => {
    it("returns JSON string for an object", () => {
      const result = safeJsonDumps({ hello: "world" });
      assert.strictEqual(result, '{"hello":"world"}');
    });

    it("handles circular references gracefully", () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      const result = safeJsonDumps(obj);
      assert.ok(typeof result === "string");
    });
  });

  describe("getSpanName", () => {
    it("returns name from spanData if present", () => {
      const span = makeAgentsSpan({
        spanData: { type: "agent", name: "MyAgent" } as unknown as SpanData,
      });
      assert.strictEqual(getSpanName(span), "MyAgent");
    });

    it("returns handoff name for handoff spans", () => {
      const span = makeAgentsSpan({
        spanData: { type: "handoff", to_agent: "TargetAgent" } as unknown as SpanData,
      });
      assert.strictEqual(getSpanName(span), "handoff to TargetAgent");
    });

    it("returns type when no name is present", () => {
      const span = makeAgentsSpan({
        spanData: { type: "generation" } as SpanData,
      });
      assert.strictEqual(getSpanName(span), "generation");
    });

    it("returns 'unknown' for missing data", () => {
      const span = makeAgentsSpan({ spanData: undefined as unknown as SpanData });
      assert.strictEqual(getSpanName(span), "unknown");
    });
  });

  describe("getSpanKind", () => {
    it("maps 'agent' to GEN_AI_SPAN_KIND_AGENT", () => {
      assert.strictEqual(getSpanKind({ type: "agent" } as SpanData), GEN_AI_SPAN_KIND_AGENT);
    });

    it("maps 'function' to GEN_AI_SPAN_KIND_TOOL", () => {
      assert.strictEqual(getSpanKind({ type: "function" } as SpanData), GEN_AI_SPAN_KIND_TOOL);
    });

    it("maps 'generation' to GEN_AI_SPAN_KIND_CHAT", () => {
      assert.strictEqual(getSpanKind({ type: "generation" } as SpanData), GEN_AI_SPAN_KIND_CHAT);
    });

    it("maps 'response' to GEN_AI_SPAN_KIND_CHAT", () => {
      assert.strictEqual(getSpanKind({ type: "response" } as SpanData), GEN_AI_SPAN_KIND_CHAT);
    });

    it("maps 'handoff' to GEN_AI_SPAN_KIND_CHAIN", () => {
      assert.strictEqual(getSpanKind({ type: "handoff" } as SpanData), GEN_AI_SPAN_KIND_CHAIN);
    });

    it("maps undefined to GEN_AI_SPAN_KIND_CHAIN", () => {
      assert.strictEqual(getSpanKind(undefined), GEN_AI_SPAN_KIND_CHAIN);
    });
  });

  describe("getSpanStatus", () => {
    it("returns OK for span without error", () => {
      const span = makeAgentsSpan();
      const status = getSpanStatus(span);
      assert.strictEqual(status.code, SpanStatusCode.OK);
    });

    it("returns ERROR for span with error", () => {
      const span = makeAgentsSpan({
        error: { message: "something failed" } as unknown,
      } as Partial<AgentsSpan<SpanData>>);
      const status = getSpanStatus(span);
      assert.strictEqual(status.code, SpanStatusCode.ERROR);
      assert.strictEqual(status.message, "something failed");
    });

    it("returns 'Unknown error' when error has no message", () => {
      const span = makeAgentsSpan({
        error: {} as unknown,
      } as Partial<AgentsSpan<SpanData>>);
      const status = getSpanStatus(span);
      assert.strictEqual(status.code, SpanStatusCode.ERROR);
      assert.strictEqual(status.message, "Unknown error");
    });
  });

  describe("getAttributesFromGenerationSpanData", () => {
    it("extracts model and provider", () => {
      const data = { type: "generation", model: "gpt-4o" } as unknown as SpanData;
      const attrs = getAttributesFromGenerationSpanData(data);
      assert.strictEqual(attrs[ATTR_GEN_AI_PROVIDER_NAME], "openai");
      assert.strictEqual(attrs[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
    });

    it("extracts usage tokens", () => {
      const data = {
        type: "generation",
        usage: { input_tokens: 10, output_tokens: 20 },
      } as unknown as SpanData;
      const attrs = getAttributesFromGenerationSpanData(data);
      assert.strictEqual(attrs[ATTR_GEN_AI_USAGE_INPUT_TOKENS], 10);
      assert.strictEqual(attrs[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS], 20);
    });

    it("extracts input and output content", () => {
      const data = {
        type: "generation",
        input: "hello",
        output: "world",
      } as unknown as SpanData;
      const attrs = getAttributesFromGenerationSpanData(data);
      assert.strictEqual(attrs[GEN_AI_REQUEST_CONTENT_KEY], '"hello"');
      assert.strictEqual(attrs[GEN_AI_RESPONSE_CONTENT_KEY], '"world"');
    });
  });

  describe("getAttributesFromFunctionSpanData", () => {
    it("extracts tool name", () => {
      const data = { type: "function", name: "get_weather" } as unknown as SpanData;
      const attrs = getAttributesFromFunctionSpanData(data);
      assert.strictEqual(attrs[ATTR_GEN_AI_TOOL_NAME], "get_weather");
    });

    it("extracts input and output", () => {
      const data = {
        type: "function",
        name: "my_tool",
        input: "test input",
        output: "test output",
      } as unknown as SpanData;
      const attrs = getAttributesFromFunctionSpanData(data);
      assert.strictEqual(attrs[GEN_AI_REQUEST_CONTENT_KEY], "test input");
      assert.strictEqual(attrs[GEN_AI_RESPONSE_CONTENT_KEY], "test output");
    });

    it("handles object input", () => {
      const data = {
        type: "function",
        name: "my_tool",
        input: { city: "Seattle" },
      } as unknown as SpanData;
      const attrs = getAttributesFromFunctionSpanData(data);
      assert.strictEqual(attrs[GEN_AI_REQUEST_CONTENT_KEY], '{"city":"Seattle"}');
    });
  });

  describe("getAttributesFromMCPListToolsSpanData", () => {
    it("extracts result", () => {
      const data = {
        type: "mcp_tools",
        result: [{ name: "tool1" }],
      } as unknown as SpanData;
      const attrs = getAttributesFromMCPListToolsSpanData(data);
      assert.strictEqual(attrs[GEN_AI_RESPONSE_CONTENT_KEY], '[{"name":"tool1"}]');
    });

    it("returns empty when no result", () => {
      const data = { type: "mcp_tools" } as unknown as SpanData;
      const attrs = getAttributesFromMCPListToolsSpanData(data);
      assert.strictEqual(Object.keys(attrs).length, 0);
    });
  });

  describe("getAttributesFromResponse", () => {
    it("extracts model and usage", () => {
      const response = {
        model: "gpt-4o",
        usage: { input_tokens: 5, output_tokens: 15 },
      };
      const attrs = getAttributesFromResponse(response);
      assert.strictEqual(attrs[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
      assert.strictEqual(attrs[ATTR_GEN_AI_USAGE_INPUT_TOKENS], 5);
      assert.strictEqual(attrs[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS], 15);
    });

    it("handles missing fields", () => {
      const attrs = getAttributesFromResponse({});
      assert.strictEqual(Object.keys(attrs).length, 0);
    });
  });

  describe("buildInputMessages", () => {
    it("extracts user role content", () => {
      const messages = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ];
      const result = buildInputMessages(messages);
      assert.strictEqual(result, '["Hello"]');
    });

    it("falls back to full array when no user messages", () => {
      const messages = [{ role: "system", content: "System prompt" }];
      const result = buildInputMessages(messages);
      assert.strictEqual(result, JSON.stringify(messages));
    });
  });

  describe("buildOutputMessages", () => {
    it("extracts output_text content", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "output_text", text: "Hello there!" },
            { type: "other", text: "ignored" },
          ],
        },
      ];
      const result = buildOutputMessages(messages);
      assert.strictEqual(result, '["Hello there!"]');
    });

    it("falls back to full array when no output_text", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_call", text: "" }],
        },
      ];
      const result = buildOutputMessages(messages);
      assert.strictEqual(result, JSON.stringify(messages));
    });
  });

  describe("CONTENT_KEYS", () => {
    it("contains expected content-sensitive keys", () => {
      assert.ok(CONTENT_KEYS.has("gen_ai.input.messages"));
      assert.ok(CONTENT_KEYS.has("gen_ai.output.messages"));
      assert.ok(CONTENT_KEYS.has("gen_ai.tool.call.arguments"));
      assert.ok(CONTENT_KEYS.has("gen_ai.tool.call.result"));
      assert.ok(CONTENT_KEYS.has(GEN_AI_REQUEST_CONTENT_KEY));
      assert.ok(CONTENT_KEYS.has(GEN_AI_RESPONSE_CONTENT_KEY));
    });
  });

  describe("KEY_MAPPINGS", () => {
    it("maps function request content to tool args", () => {
      assert.strictEqual(
        KEY_MAPPINGS.get(`function${GEN_AI_REQUEST_CONTENT_KEY}`),
        "gen_ai.tool.call.arguments",
      );
    });

    it("maps generation response content to output messages", () => {
      assert.strictEqual(
        KEY_MAPPINGS.get(`generation${GEN_AI_RESPONSE_CONTENT_KEY}`),
        "gen_ai.output.messages",
      );
    });
  });
});
