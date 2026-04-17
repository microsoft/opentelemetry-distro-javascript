// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";

import {
  MessageRole,
  A365_MESSAGE_SCHEMA_VERSION,
  Modality,
} from "../../../../src/a365/contracts.js";
import type { InputMessages, OutputMessages } from "../../../../src/a365/contracts.js";
import {
  isWrappedMessages,
  toInputMessages,
  toOutputMessages,
  normalizeInputMessages,
  normalizeOutputMessages,
  serializeMessages,
} from "../../../../src/a365/message-utils.js";

describe("isWrappedMessages", () => {
  it("returns true for InputMessages wrapper", () => {
    const wrapper: InputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
      messages: [{ role: MessageRole.USER, parts: [{ type: "text", content: "hi" }] }],
    };
    expect(isWrappedMessages(wrapper)).toBe(true);
  });

  it("returns true for OutputMessages wrapper", () => {
    const wrapper: OutputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
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
    expect(isWrappedMessages({ version: "0.1.0" } as unknown as any)).toBe(false);
  });

  it("returns false for object missing version property", () => {
    expect(isWrappedMessages({ messages: [] } as unknown as any)).toBe(false);
  });

  it("returns false for arbitrary non-matching object", () => {
    expect(isWrappedMessages({ foo: "bar" } as unknown as any)).toBe(false);
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
  it("wraps strings as OutputMessage with role=assistant and TextPart", () => {
    const result = toOutputMessages(["response 1", "response 2"]);
    expect(result).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "response 1" }] },
      { role: "assistant", parts: [{ type: "text", content: "response 2" }] },
    ]);
  });

  it("handles empty array", () => {
    expect(toOutputMessages([])).toEqual([]);
  });
});

describe("normalizeInputMessages", () => {
  it("wraps string[] into versioned InputMessages", () => {
    const result = normalizeInputMessages(["hello"]);
    expect(result).toEqual({
      version: A365_MESSAGE_SCHEMA_VERSION,
      messages: [{ role: "user", parts: [{ type: "text", content: "hello" }] }],
    });
  });

  it("returns InputMessages wrapper as-is", () => {
    const wrapper: InputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
      messages: [{ role: MessageRole.SYSTEM, parts: [{ type: "text", content: "system prompt" }] }],
    };
    expect(normalizeInputMessages(wrapper)).toBe(wrapper);
  });

  it("wraps empty string[] into versioned wrapper with empty messages", () => {
    const result = normalizeInputMessages([]);
    expect(result).toEqual({ version: A365_MESSAGE_SCHEMA_VERSION, messages: [] });
  });
});

describe("normalizeOutputMessages", () => {
  it("wraps string[] into versioned OutputMessages", () => {
    const result = normalizeOutputMessages(["response"]);
    expect(result).toEqual({
      version: A365_MESSAGE_SCHEMA_VERSION,
      messages: [{ role: "assistant", parts: [{ type: "text", content: "response" }] }],
    });
  });

  it("returns OutputMessages wrapper as-is", () => {
    const wrapper: OutputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
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
  it("returns JSON for versioned wrapper", () => {
    const wrapper: InputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
      messages: [{ role: MessageRole.USER, parts: [{ type: "text", content: "hello" }] }],
    };
    const result = serializeMessages(wrapper);
    const parsed = JSON.parse(result);
    expect(parsed.version).toBe(A365_MESSAGE_SCHEMA_VERSION);
    expect(parsed.messages).toEqual(wrapper.messages);
  });

  it("serializes empty messages wrapper", () => {
    const wrapper: InputMessages = { version: A365_MESSAGE_SCHEMA_VERSION, messages: [] };
    const parsed = JSON.parse(serializeMessages(wrapper));
    expect(parsed.version).toBe(A365_MESSAGE_SCHEMA_VERSION);
    expect(parsed.messages).toEqual([]);
  });

  it("serializes large messages without truncation", () => {
    const largeContent = "x".repeat(100_000);
    const wrapper: InputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
      messages: [{ role: MessageRole.USER, parts: [{ type: "text", content: largeContent }] }],
    };

    const result = serializeMessages(wrapper);
    const parsed = JSON.parse(result);
    expect(parsed.messages[0].parts[0].content).toBe(largeContent);
  });

  it("does not mutate the original messages", () => {
    const original = "z".repeat(50_000);
    const wrapper: InputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
      messages: [{ role: MessageRole.USER, parts: [{ type: "text", content: original }] }],
    };

    serializeMessages(wrapper);

    expect((wrapper.messages[0].parts[0] as { content: string }).content).toBe(original);
  });

  it("returns fallback sentinel when messages contain non-serializable values", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const wrapper: InputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
      messages: [
        {
          role: MessageRole.TOOL,
          parts: [{ type: "tool_call_response", id: "tc1", response: circular }],
        },
      ],
    };

    const result = serializeMessages(wrapper);
    const parsed = JSON.parse(result);
    expect(parsed.version).toBe(A365_MESSAGE_SCHEMA_VERSION);
    expect(parsed.messages[0].parts[0].content).toContain("serialization failed");
    expect(parsed.messages[0].parts[0].content).toContain("1 message");
  });

  it("should serialize tool call request and response parts in wrapper", () => {
    const messages: InputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
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

    expect(parsed.version).toBe(A365_MESSAGE_SCHEMA_VERSION);
    expect(parsed.messages[0].parts[1].type).toBe("tool_call");
    expect(parsed.messages[0].parts[1].arguments).toEqual({ query: "test" });
    expect(parsed.messages[1].parts[0].type).toBe("tool_call_response");
    expect(parsed.messages[1].parts[0].response).toEqual({ results: ["item1"] });
  });

  it("should serialize blob, file, and URI parts", () => {
    const wrapper: InputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
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

    expect(parsed.version).toBe(A365_MESSAGE_SCHEMA_VERSION);
    expect(parsed.messages[0].parts[0].modality).toBe("image");
    expect(parsed.messages[0].parts[1].file_id).toBe("file-123");
    expect(parsed.messages[0].parts[2].uri).toBe("https://example.com/audio.mp3");
  });

  it("should serialize server tool call and generic parts", () => {
    const wrapper: InputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
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

    expect(parsed.version).toBe(A365_MESSAGE_SCHEMA_VERSION);
    expect(parsed.messages[0].parts[0].server_tool_call.endpoint).toBe("/api");
    expect(parsed.messages[1].parts[0].server_tool_call_response.status).toBe("ok");
    expect(parsed.messages[2].parts[0].type).toBe("custom_annotation");
  });
});
