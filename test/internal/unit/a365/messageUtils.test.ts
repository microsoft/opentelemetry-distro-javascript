// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";

import {
  ExecuteToolCallArguments,
  ExecuteToolCallResult,
  MessageRole,
  Modality,
  ToolCallAction,
  ToolCallOutcomeStatus,
  ToolPolicyDecision,
} from "../../../../src/a365/contracts.js";
import type { InputMessages, OutputMessages } from "../../../../src/a365/contracts.js";
import {
  isWrappedMessages,
  toInputMessages,
  toOutputMessages,
  normalizeInputMessages,
  normalizeOutputMessages,
  serializeMessages,
  serializeToolPayload,
} from "../../../../src/a365/message-utils.js";

describe("isWrappedMessages", () => {
  it("returns true for InputMessages wrapper", () => {
    const wrapper: InputMessages = {
      messages: [{ role: MessageRole.USER, parts: [{ type: "text", content: "hi" }] }],
    };
    expect(isWrappedMessages(wrapper)).toBe(true);
  });

  it("returns true for OutputMessages wrapper", () => {
    const wrapper: OutputMessages = {
      messages: [{ role: MessageRole.ASSISTANT, parts: [{ type: "text", content: "hello" }] }],
    };
    expect(isWrappedMessages(wrapper)).toBe(true);
  });

  it("returns false for string[]", () => {
    expect(isWrappedMessages(["hello"])).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(isWrappedMessages([])).toBe(false);
  });

  it("returns false for null", () => {
    expect(isWrappedMessages(null as unknown as any)).toBe(false);
  });

  it("returns false for object missing messages property", () => {
    expect(isWrappedMessages({ foo: "bar" } as unknown as any)).toBe(false);
  });

  it("returns false for object with non-array messages property", () => {
    expect(isWrappedMessages({ messages: "not-an-array" } as unknown as any)).toBe(false);
  });
});

describe("toInputMessages", () => {
  it("wraps strings as ChatMessage with role=user and TextPart", () => {
    const result = toInputMessages(["hello", "world"]);
    expect(result).toEqual([
      { role: "user", parts: [{ type: "text", content: "hello" }] },
      { role: "user", parts: [{ type: "text", content: "world" }] },
    ]);
  });

  it("handles empty array", () => {
    expect(toInputMessages([])).toEqual([]);
  });

  it("preserves message content exactly", () => {
    const content = "  special chars: <>&\"' \n\ttabs  ";
    const result = toInputMessages([content]);
    expect(result[0].parts[0]).toEqual({ type: "text", content });
  });
});

describe("toOutputMessages", () => {
  it("wraps strings as OutputMessage with role=assistant, TextPart, and default finish_reason", () => {
    const result = toOutputMessages(["response 1", "response 2"]);
    expect(result).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "response 1" }],
        finish_reason: "stop",
      },
      {
        role: "assistant",
        parts: [{ type: "text", content: "response 2" }],
        finish_reason: "stop",
      },
    ]);
  });

  it("handles empty array", () => {
    expect(toOutputMessages([])).toEqual([]);
  });
});

describe("normalizeInputMessages", () => {
  it("wraps string[] into InputMessages", () => {
    const result = normalizeInputMessages(["hello"]);
    expect(result).toEqual({
      messages: [{ role: "user", parts: [{ type: "text", content: "hello" }] }],
    });
  });

  it("returns InputMessages wrapper as-is", () => {
    const wrapper: InputMessages = {
      messages: [{ role: MessageRole.SYSTEM, parts: [{ type: "text", content: "system prompt" }] }],
    };
    expect(normalizeInputMessages(wrapper)).toBe(wrapper);
  });

  it("wraps a single string into InputMessages", () => {
    const result = normalizeInputMessages("hello");
    expect(result).toEqual({
      messages: [{ role: "user", parts: [{ type: "text", content: "hello" }] }],
    });
  });

  it("wraps empty string[] into wrapper with empty messages", () => {
    const result = normalizeInputMessages([]);
    expect(result).toEqual({ messages: [] });
  });
});

describe("normalizeOutputMessages", () => {
  it("wraps string[] into OutputMessages with default finish_reason", () => {
    const result = normalizeOutputMessages(["response"]);
    expect(result).toEqual({
      messages: [
        {
          role: "assistant",
          parts: [{ type: "text", content: "response" }],
          finish_reason: "stop",
        },
      ],
    });
  });

  it("wraps a single string into OutputMessages with default finish_reason", () => {
    const result = normalizeOutputMessages("response");
    expect(result).toEqual({
      messages: [
        {
          role: "assistant",
          parts: [{ type: "text", content: "response" }],
          finish_reason: "stop",
        },
      ],
    });
  });

  it("returns OutputMessages wrapper as-is", () => {
    const wrapper: OutputMessages = {
      messages: [
        {
          role: MessageRole.ASSISTANT,
          parts: [{ type: "text", content: "done" }],
          finish_reason: "stop",
        },
      ],
    };
    expect(normalizeOutputMessages(wrapper)).toBe(wrapper);
  });
});

describe("serializeMessages", () => {
  it("returns JSON array for message wrapper", () => {
    const wrapper: InputMessages = {
      messages: [{ role: MessageRole.USER, parts: [{ type: "text", content: "hello" }] }],
    };
    const result = serializeMessages(wrapper);
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(wrapper.messages);
  });

  it("serializes empty messages wrapper as empty array", () => {
    const wrapper: InputMessages = { messages: [] };
    const parsed = JSON.parse(serializeMessages(wrapper));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([]);
  });

  it("serializes large messages without truncation", () => {
    const largeContent = "x".repeat(100_000);
    const wrapper: InputMessages = {
      messages: [{ role: MessageRole.USER, parts: [{ type: "text", content: largeContent }] }],
    };

    const result = serializeMessages(wrapper);
    const parsed = JSON.parse(result);
    expect(parsed[0].parts[0].content).toBe(largeContent);
  });

  it("does not mutate the original messages", () => {
    const original = "z".repeat(50_000);
    const wrapper: InputMessages = {
      messages: [{ role: MessageRole.USER, parts: [{ type: "text", content: original }] }],
    };

    serializeMessages(wrapper);

    expect((wrapper.messages[0].parts[0] as { content: string }).content).toBe(original);
  });

  it("returns fallback sentinel when messages contain non-serializable values", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const wrapper: InputMessages = {
      messages: [
        {
          role: MessageRole.TOOL,
          parts: [{ type: "tool_call_response", id: "tc1", response: circular }],
        },
      ],
    };

    const result = serializeMessages(wrapper);
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].parts[0].content).toContain("serialization failed");
    expect(parsed[0].parts[0].content).toContain("1 message");
  });

  it("should serialize tool call request and response parts as plain array", () => {
    const messages: InputMessages = {
      messages: [
        {
          role: MessageRole.ASSISTANT,
          parts: [
            { type: "text", content: "Let me search for that." },
            { type: "tool_call", name: "search", id: "call_123", arguments: { query: "test" } },
          ],
        },
        {
          role: MessageRole.TOOL,
          parts: [{ type: "tool_call_response", id: "call_123", response: { results: ["item1"] } }],
        },
      ],
    };

    const parsed = JSON.parse(serializeMessages(messages));

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].parts[1].type).toBe("tool_call");
    expect(parsed[0].parts[1].arguments).toEqual({ query: "test" });
    expect(parsed[1].parts[0].type).toBe("tool_call_response");
    expect(parsed[1].parts[0].response).toEqual({ results: ["item1"] });
  });

  it("should serialize blob, file, and URI parts", () => {
    const wrapper: InputMessages = {
      messages: [
        {
          role: MessageRole.USER,
          parts: [
            {
              type: "blob",
              modality: Modality.IMAGE,
              mime_type: "image/png",
              content: "iVBORw0KGgo=",
            },
            { type: "file", modality: Modality.VIDEO, mime_type: "video/mp4", file_id: "file-123" },
            {
              type: "uri",
              modality: Modality.AUDIO,
              mime_type: "audio/mp3",
              uri: "https://example.com/audio.mp3",
            },
          ],
        },
      ],
    };

    const parsed = JSON.parse(serializeMessages(wrapper));

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].parts[0].modality).toBe("image");
    expect(parsed[0].parts[1].file_id).toBe("file-123");
    expect(parsed[0].parts[2].uri).toBe("https://example.com/audio.mp3");
  });

  it("should serialize server tool call and generic parts", () => {
    const wrapper: InputMessages = {
      messages: [
        {
          role: MessageRole.ASSISTANT,
          parts: [
            {
              type: "server_tool_call",
              name: "mcp_tool",
              id: "stc_1",
              server_tool_call: { endpoint: "/api" },
            },
          ],
        },
        {
          role: MessageRole.TOOL,
          parts: [
            {
              type: "server_tool_call_response",
              id: "stc_1",
              server_tool_call_response: { status: "ok" },
            },
          ],
        },
        {
          role: MessageRole.USER,
          parts: [{ type: "custom_annotation", timestamp: "00:01:23", note: "Important" }],
        },
      ],
    };

    const parsed = JSON.parse(serializeMessages(wrapper));

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].parts[0].server_tool_call.endpoint).toBe("/api");
    expect(parsed[1].parts[0].server_tool_call_response.status).toBe("ok");
    expect(parsed[2].parts[0].type).toBe("custom_annotation");
  });
});

describe("serializeToolPayload", () => {
  const serializationError = '{"serialization_error":"Failed to serialize execute tool payload."}';
  const legacySerializationError = '{"error":"serialization failed"}';

  it("returns undefined for nullish payloads", () => {
    expect(serializeToolPayload(undefined)).toBeUndefined();
    expect(serializeToolPayload(null)).toBeUndefined();
  });

  it("serializes extension data as metadata without replacing declared fields", () => {
    const payload = new ExecuteToolCallArguments({
      action: ToolCallAction.READ,
      parameters: {
        query: "GDPR",
        filters: { sensitivity: "high", includeArchived: true },
      },
      resources: [
        {
          id: "doc-1",
          type: "document",
          provider: "sharepoint",
          extension_data: { provider_resource_type: "page" },
        },
      ],
      extension_data: {
        action: "write",
        schema_version: "9.9",
        request_context: { scenario: "enterprise-search" },
      },
    });

    const serialized = serializeToolPayload(payload);
    const parsed = JSON.parse(serialized as string);

    expect(parsed).toEqual({
      schema_version: "1.0",
      action: "read",
      parameters: {
        query: "GDPR",
        filters: { sensitivity: "high", includeArchived: true },
      },
      resources: [
        {
          id: "doc-1",
          type: "document",
          provider: "sharepoint",
          metadata: { provider_resource_type: "page" },
        },
      ],
      metadata: {
        action: "write",
        schema_version: "9.9",
        request_context: { scenario: "enterprise-search" },
      },
    });
  });

  it("keeps nested extension keys inside metadata", () => {
    const payload = new ExecuteToolCallResult({
      outcome: {
        status: ToolCallOutcomeStatus.SUCCESS,
        code: "ok",
        extension_data: { code: "provider-code", status: "provider-status" },
      },
      resources: [
        {
          policy: {
            decision: ToolPolicyDecision.ALLOW,
            extension_data: { decision: "conditional-allow" },
          },
        },
      ],
    });

    expect(JSON.parse(serializeToolPayload(payload) as string)).toEqual({
      schema_version: "1.0",
      outcome: {
        status: "success",
        code: "ok",
        metadata: { code: "provider-code", status: "provider-status" },
      },
      resources: [
        {
          policy: {
            decision: "allow",
            metadata: { decision: "conditional-allow" },
          },
        },
      ],
    });
  });

  it("omits nullish declared fields and preserves nulls inside mappings and arrays", () => {
    const payload = new ExecuteToolCallResult({
      outcome: {
        status: ToolCallOutcomeStatus.SUCCESS,
        provider_code: null as any,
        extension_data: { provider_outcome: null, attempts: 0 },
      },
      data: { content: null, matches: [null, 1] },
      extension_data: { provider_result: null, cached: false },
    });

    expect(JSON.parse(serializeToolPayload(payload) as string)).toEqual({
      schema_version: "1.0",
      outcome: {
        status: "success",
        metadata: { provider_outcome: null, attempts: 0 },
      },
      data: { content: null, matches: [null, 1] },
      metadata: { provider_result: null, cached: false },
    });
  });

  it.each([
    ["action", new ExecuteToolCallArguments({ action: "READ" as any })],
    [
      "outcome status",
      new ExecuteToolCallResult({ outcome: { status: "ok" as ToolCallOutcomeStatus } }),
    ],
    [
      "policy decision",
      new ExecuteToolCallResult({
        resources: [{ policy: { decision: "permit" as ToolPolicyDecision } }],
      }),
    ],
  ])("returns the exact fallback for an invalid %s", (_name, payload) => {
    expect(serializeToolPayload(payload)).toBe(serializationError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "returns the exact fallback for non-finite number %s",
    (value) => {
      expect(serializeToolPayload(new ExecuteToolCallResult({ data: { value } }))).toBe(
        serializationError,
      );
    },
  );

  it.each([
    ["undefined", undefined],
    ["function", () => "unsupported"],
    ["symbol", Symbol("unsupported")],
    ["bigint", BigInt(1)],
  ])("returns the exact fallback for unsupported %s mapping values", (_name, value) => {
    expect(
      serializeToolPayload(new ExecuteToolCallArguments({ parameters: { value } })),
    ).toBe(serializationError);
  });

  it("returns the exact fallback when extension data is not a mapping", () => {
    expect(
      serializeToolPayload(
        new ExecuteToolCallArguments({ extension_data: [] as unknown as Record<string, unknown> }),
      ),
    ).toBe(serializationError);
  });

  it("serializes supported JavaScript scalar and collection values", () => {
    const payload = new ExecuteToolCallResult({
      data: {
        timestamp: new Date("2026-01-02T03:04:05.000Z"),
        bytes: new Uint8Array([0, 1, 2, 3]),
        scopes: new Set(["read", "write"]),
      },
    });

    expect(JSON.parse(serializeToolPayload(payload) as string).data).toEqual({
      timestamp: "2026-01-02T03:04:05.000Z",
      bytes: "AAECAw==",
      scopes: ["read", "write"],
    });
  });

  it("serializes repeated references that are not cycles", () => {
    const shared = { value: true };
    const payload = new ExecuteToolCallResult({
      data: { first: shared, second: shared },
    });

    expect(JSON.parse(serializeToolPayload(payload) as string).data).toEqual({
      first: { value: true },
      second: { value: true },
    });
  });

  it("returns the legacy fallback for circular generic payloads", () => {
    const payload: Record<string, unknown> = { a: 1 };
    payload.self = payload;

    expect(serializeToolPayload(payload)).toBe(legacySerializationError);
  });

  it("returns the exact fallback for circular ExecuteToolCallArguments payloads", () => {
    const extension_data: Record<string, unknown> = {};
    const payload = new ExecuteToolCallArguments({
      action: ToolCallAction.READ,
      extension_data,
    });
    extension_data.self = payload;

    expect(serializeToolPayload(payload)).toBe(serializationError);
  });

  it("returns the exact fallback for circular ExecuteToolCallResult payloads", () => {
    const data: Record<string, unknown> = { count: 1 };
    const result = new ExecuteToolCallResult({
      outcome: { status: ToolCallOutcomeStatus.SUCCESS },
      data,
    });
    data.self = data;

    expect(serializeToolPayload(result)).toBe(serializationError);
  });

  it("returns the exact fallback for bigint payloads", () => {
    expect(
      serializeToolPayload(
        new ExecuteToolCallArguments({
          action: ToolCallAction.READ,
          extension_data: { count: BigInt(1) },
        }),
      ),
    ).toBe(serializationError);
  });

  it("returns the exact fallback when payload serialization throws", () => {
    const extension_data = {
      get value(): never {
        throw new Error("boom");
      },
    };
    const payload = new ExecuteToolCallArguments({
      action: ToolCallAction.READ,
      extension_data,
    });

    expect(serializeToolPayload(payload)).toBe(serializationError);
  });
});
