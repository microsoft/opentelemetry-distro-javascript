// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Utilities for normalizing and serializing gen-ai messages.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability/src/tracing/message-utils.ts
 */

import type {
  ChatMessage,
  OutputMessage,
  InputMessages,
  OutputMessages,
  InputMessagesParam,
  OutputMessagesParam,
} from "./contracts.js";
import {
  DEFAULT_FINISH_REASON,
  ExecuteToolCallArguments,
  ExecuteToolCallResult,
  MessageRole,
} from "./contracts.js";

const EXECUTE_TOOL_SERIALIZATION_ERROR =
  '{"serialization_error":"Failed to serialize execute tool payload."}';

function isTypedExecuteToolPayload(
  value: object,
): value is ExecuteToolCallArguments | ExecuteToolCallResult {
  return value instanceof ExecuteToolCallArguments || value instanceof ExecuteToolCallResult;
}

/**
 * Type guard that returns `true` when the input is a structured wrapper
 * object (`InputMessages` or `OutputMessages`).
 */
export function isWrappedMessages(
  input: InputMessagesParam | OutputMessagesParam,
): input is InputMessages | OutputMessages {
  return (
    !Array.isArray(input) &&
    typeof input === "object" &&
    input !== null &&
    "messages" in input &&
    Array.isArray((input as InputMessages).messages)
  );
}

/** Converts plain input strings into OTEL input messages. */
export function toInputMessages(messages: string[]): ChatMessage[] {
  return messages.map((content) => ({
    role: MessageRole.USER,
    parts: [{ type: "text" as const, content }],
  }));
}

/**
 * Converts plain output strings into OTEL output messages.
 * `finish_reason` defaults to `"stop"` per OTel spec.
 */
export function toOutputMessages(messages: string[]): OutputMessage[] {
  return messages.map((content) => ({
    role: MessageRole.ASSISTANT,
    parts: [{ type: "text" as const, content }],
    finish_reason: DEFAULT_FINISH_REASON,
  }));
}

/**
 * Normalizes an `InputMessagesParam` to an `InputMessages` instance.
 * - `string` / `string[]` → converted to `ChatMessage[]` and wrapped
 * - `InputMessages` → returned as-is
 */
export function normalizeInputMessages(param: InputMessagesParam): InputMessages {
  if (typeof param === "string" || Array.isArray(param)) {
    const arr = typeof param === "string" ? [param] : param;
    return { messages: toInputMessages(arr) };
  }
  return param;
}

/**
 * Normalizes an `OutputMessagesParam` to an `OutputMessages` instance.
 * - `string` / `string[]` → converted to `OutputMessage[]` and wrapped
 * - `OutputMessages` → returned as-is
 */
export function normalizeOutputMessages(param: OutputMessagesParam): OutputMessages {
  if (typeof param === "string" || Array.isArray(param)) {
    const arr = typeof param === "string" ? [param] : param;
    return { messages: toOutputMessages(arr) };
  }
  return param;
}

/**
 * Serializes a message wrapper to JSON.
 *
 * The output is a plain JSON array per OTel gen-ai semantic conventions: `[{...}, ...]`.
 *
 * The try/catch ensures telemetry recording is non-throwing even when
 * message parts contain non-JSON-serializable values.
 */
export function serializeMessages(wrapper: InputMessages | OutputMessages): string {
  try {
    return JSON.stringify(wrapper.messages);
  } catch {
    return JSON.stringify([
      {
        role: MessageRole.SYSTEM,
        parts: [
          {
            type: "text",
            content: `[serialization failed: ${wrapper.messages.length} ${wrapper.messages.length === 1 ? "message" : "messages"}]`,
          },
        ],
      },
    ]);
  }
}

/**
 * Serializes execute-tool payload objects while keeping telemetry recording non-throwing.
 * Returns `undefined` for nullish payloads so callers can omit the attribute.
 */
export function serializeToolPayload(value: object | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (!isTypedExecuteToolPayload(value)) {
    return safeSerializeToJson(value as Record<string, unknown>, "payload");
  }

  try {
    return JSON.stringify(value) ?? EXECUTE_TOOL_SERIALIZATION_ERROR;
  } catch {
    return EXECUTE_TOOL_SERIALIZATION_ERROR;
  }
}

/**
 * Ensures the value is always a JSON-parseable string.
 * - Objects are serialized via JSON.stringify.
 * - Strings that are already valid JSON objects/arrays are passed through.
 * - All other strings are wrapped: `{ [key]: value }`.
 */
export function safeSerializeToJson(value: Record<string, unknown> | string, key: string): string {
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return JSON.stringify({ error: "serialization failed" });
    }
  }
  const str = value as string;
  try {
    const parsed = JSON.parse(str) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      return str;
    }
  } catch {
    // not valid JSON — fall through to wrap
  }
  return JSON.stringify({ [key]: str });
}
