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
  SystemInstructionPart,
  ToolCallContainer,
  ToolCallIdentifier,
  ToolCallResource,
  ToolCallResultOutcome,
  ToolCallResultPagination,
  ToolCallResultPolicy,
  ToolCallResultResource,
  ToolCallResultSecurity,
  ToolCallResultSensitivity,
} from "./contracts.js";
import {
  DEFAULT_FINISH_REASON,
  ExecuteToolCallArguments,
  ExecuteToolCallResult,
  MessageRole,
  ToolCallAction,
  ToolCallOutcomeStatus,
  ToolPolicyDecision,
} from "./contracts.js";
import { EXECUTE_TOOL_PAYLOAD_KIND } from "./tool-call-models.js";

const EXECUTE_TOOL_SERIALIZATION_ERROR =
  '{"serialization_error":"Failed to serialize execute tool payload."}';

function isTypedExecuteToolPayload(
  value: object,
): value is ExecuteToolCallArguments | ExecuteToolCallResult {
  const kind = (value as Partial<Record<typeof EXECUTE_TOOL_PAYLOAD_KIND, unknown>>)[
    EXECUTE_TOOL_PAYLOAD_KIND
  ];
  return kind === "arguments" || kind === "result";
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonRecord;
type JsonRecord = { [key: string]: JsonValue };

const TOOL_CALL_ACTION_VALUES = new Set<string>(Object.values(ToolCallAction));
const TOOL_CALL_OUTCOME_STATUS_VALUES = new Set<string>(Object.values(ToolCallOutcomeStatus));
const TOOL_POLICY_DECISION_VALUES = new Set<string>(Object.values(ToolPolicyDecision));

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
    return serializeTypedToolPayload(value);
  } catch {
    return EXECUTE_TOOL_SERIALIZATION_ERROR;
  }
}

function serializeTypedToolPayload(
  value: ExecuteToolCallArguments | ExecuteToolCallResult,
): string {
  const stack = new Set<object>();
  const serialized =
    value[EXECUTE_TOOL_PAYLOAD_KIND] === "arguments"
      ? serializeArguments(value, stack)
      : serializeResult(value, stack);
  return JSON.stringify(serialized);
}

function serializeArguments(value: ExecuteToolCallArguments, stack: Set<object>): JsonRecord {
  return withActiveContainer(value, stack, () =>
    withMetadata(
      {
        schema_version: toOptionalJsonValue(value.schema_version, stack),
        resources: serializeOptionalSchemaArray(value.resources, serializeResource, stack),
        action: validateOptionalEnum(value.action, TOOL_CALL_ACTION_VALUES, "action"),
        parameters: serializeOptionalRecord(value.parameters, stack),
      },
      value.extension_data,
      stack,
    ),
  );
}

function serializeResult(value: ExecuteToolCallResult, stack: Set<object>): JsonRecord {
  return withActiveContainer(value, stack, () =>
    withMetadata(
      {
        schema_version: toOptionalJsonValue(value.schema_version, stack),
        outcome: serializeOptionalSchemaObject(value.outcome, serializeOutcome, stack),
        resources: serializeOptionalSchemaArray(value.resources, serializeResultResource, stack),
        data: serializeOptionalRecord(value.data, stack),
        pagination: serializeOptionalSchemaObject(value.pagination, serializePagination, stack),
      },
      value.extension_data,
      stack,
    ),
  );
}

function serializeIdentifier(value: ToolCallIdentifier, stack: Set<object>): JsonRecord {
  return serializeSchemaObject(value, stack, () =>
    withMetadata(
      {
        type: toOptionalJsonValue(value.type, stack),
        value: toOptionalJsonValue(value.value, stack),
      },
      value.extension_data,
      stack,
    ),
  );
}

function serializeContainer(value: ToolCallContainer, stack: Set<object>): JsonRecord {
  return serializeSchemaObject(value, stack, () =>
    withMetadata(
      {
        id: toOptionalJsonValue(value.id, stack),
        uri: toOptionalJsonValue(value.uri, stack),
        type: toOptionalJsonValue(value.type, stack),
      },
      value.extension_data,
      stack,
    ),
  );
}

function serializeResource(value: ToolCallResource, stack: Set<object>): JsonRecord {
  return serializeSchemaObject(value, stack, () =>
    withMetadata(
      {
        ...serializeResourceFields(value, stack),
      },
      value.extension_data,
      stack,
    ),
  );
}

function serializeResultResource(value: ToolCallResultResource, stack: Set<object>): JsonRecord {
  return serializeSchemaObject(value, stack, () =>
    withMetadata(
      {
        ...serializeResourceFields(value, stack),
        outcome: serializeOptionalSchemaObject(value.outcome, serializeOutcome, stack),
        sensitivity: serializeOptionalSchemaObject(value.sensitivity, serializeSensitivity, stack),
        policy: serializeOptionalSchemaObject(value.policy, serializePolicy, stack),
        security: serializeOptionalSchemaObject(value.security, serializeSecurity, stack),
        data: serializeOptionalRecord(value.data, stack),
      },
      value.extension_data,
      stack,
    ),
  );
}

function serializeResourceFields(
  value: ToolCallResource,
  stack: Set<object>,
): Record<string, JsonValue | undefined> {
  return {
    id: toOptionalJsonValue(value.id, stack),
    uri: toOptionalJsonValue(value.uri, stack),
    name: toOptionalJsonValue(value.name, stack),
    type: toOptionalJsonValue(value.type, stack),
    provider: toOptionalJsonValue(value.provider, stack),
    identifiers: serializeOptionalSchemaArray(value.identifiers, serializeIdentifier, stack),
    container: serializeOptionalSchemaObject(value.container, serializeContainer, stack),
  };
}

function serializeOutcome(value: ToolCallResultOutcome, stack: Set<object>): JsonRecord {
  return serializeSchemaObject(value, stack, () =>
    withMetadata(
      {
        status: validateOptionalEnum(value.status, TOOL_CALL_OUTCOME_STATUS_VALUES, "status"),
        code: toOptionalJsonValue(value.code, stack),
        provider_code: toOptionalJsonValue(value.provider_code, stack),
        message: toOptionalJsonValue(value.message, stack),
      },
      value.extension_data,
      stack,
    ),
  );
}

function serializeSensitivity(value: ToolCallResultSensitivity, stack: Set<object>): JsonRecord {
  return serializeSchemaObject(value, stack, () =>
    withMetadata(
      { label_id: toOptionalJsonValue(value.label_id, stack) },
      value.extension_data,
      stack,
    ),
  );
}

function serializePolicy(value: ToolCallResultPolicy, stack: Set<object>): JsonRecord {
  return serializeSchemaObject(value, stack, () =>
    withMetadata(
      {
        decision: validateOptionalEnum(value.decision, TOOL_POLICY_DECISION_VALUES, "decision"),
        id: toOptionalJsonValue(value.id, stack),
        name: toOptionalJsonValue(value.name, stack),
      },
      value.extension_data,
      stack,
    ),
  );
}

function serializeSecurity(value: ToolCallResultSecurity, stack: Set<object>): JsonRecord {
  return serializeSchemaObject(value, stack, () =>
    withMetadata(
      { xpia_detected: toOptionalJsonValue(value.xpia_detected, stack) },
      value.extension_data,
      stack,
    ),
  );
}

function serializePagination(value: ToolCallResultPagination, stack: Set<object>): JsonRecord {
  return serializeSchemaObject(value, stack, () =>
    withMetadata(
      {
        has_more: toOptionalJsonValue(value.has_more, stack),
        next_cursor: toOptionalJsonValue(value.next_cursor, stack),
        total_count: toOptionalJsonValue(value.total_count, stack),
      },
      value.extension_data,
      stack,
    ),
  );
}

function serializeSchemaObject<T extends object>(
  value: T,
  stack: Set<object>,
  serialize: () => JsonRecord,
): JsonRecord {
  if (!isPlainRecord(value)) {
    throw new TypeError("Execute tool schema values must be plain objects.");
  }
  return withActiveContainer(value, stack, serialize);
}

function serializeOptionalSchemaObject<T extends object>(
  value: T | null | undefined,
  serialize: (item: T, stack: Set<object>) => JsonRecord,
  stack: Set<object>,
): JsonRecord | undefined {
  return value == null ? undefined : serialize(value, stack);
}

function serializeOptionalSchemaArray<T extends object>(
  value: T[] | null | undefined,
  serialize: (item: T, stack: Set<object>) => JsonRecord,
  stack: Set<object>,
): JsonValue[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Execute tool schema collections must be arrays.");
  }
  return serializeArray(value, stack, (item) => serialize(item, stack));
}

function serializeOptionalRecord(
  value: Record<string, unknown> | null | undefined,
  stack: Set<object>,
): JsonRecord | undefined {
  return value == null ? undefined : toJsonRecord(value, stack);
}

function withMetadata(
  declared: Record<string, JsonValue | undefined>,
  extensionData: Record<string, unknown> | null | undefined,
  stack: Set<object>,
): JsonRecord {
  const serialized: JsonRecord = {};
  for (const [key, value] of Object.entries(declared)) {
    if (value !== undefined) {
      serialized[key] = value;
    }
  }
  if (extensionData != null) {
    if (!isPlainRecord(extensionData)) {
      throw new TypeError("Execute tool extension data must be a plain object.");
    }
    const metadata = toJsonRecord(extensionData, stack);
    if (Object.keys(metadata).length > 0) {
      serialized.metadata = metadata;
    }
  }
  return serialized;
}

function validateOptionalEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TypeError(`Invalid execute tool ${field}.`);
  }
  return value;
}

function toOptionalJsonValue(value: unknown, stack: Set<object>): JsonValue | undefined {
  return value == null ? undefined : toJsonValue(value, stack);
}

function toJsonValue(value: unknown, stack: Set<object>): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Execute tool payload numbers must be finite.");
    }
    return value;
  }
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError(`Unsupported execute tool payload value: ${typeof value}.`);
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError("Execute tool payload dates must be valid.");
    }
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return serializeArray(value, stack, (item) => toJsonValue(item, stack));
  }
  if (value instanceof Set) {
    return withActiveContainer(value, stack, () =>
      Array.from(value, (item) => toJsonValue(item, stack)),
    );
  }
  if (isPlainRecord(value)) {
    return toJsonRecord(value, stack);
  }
  throw new TypeError(
    `Unsupported execute tool payload object: ${value.constructor?.name ?? "unknown"}.`,
  );
}

function toJsonRecord(value: Record<string, unknown>, stack: Set<object>): JsonRecord {
  if (!isPlainRecord(value)) {
    throw new TypeError("Execute tool payload mappings must be plain objects.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Execute tool payload mappings must use string keys.");
  }
  return withActiveContainer(value, stack, () => {
    const serialized = Object.create(null) as JsonRecord;
    for (const [key, item] of Object.entries(value)) {
      serialized[key] = toJsonValue(item, stack);
    }
    return serialized;
  });
}

function serializeArray<T>(
  value: T[],
  stack: Set<object>,
  serialize: (item: T) => JsonValue,
): JsonValue[] {
  return withActiveContainer(value, stack, () => {
    const serialized: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new TypeError("Execute tool payload arrays must not be sparse.");
      }
      serialized.push(serialize(value[index]));
    }
    return serialized;
  });
}

function withActiveContainer<T>(value: object, stack: Set<object>, serialize: () => T): T {
  if (stack.has(value)) {
    throw new TypeError("Circular reference detected in execute tool payload.");
  }
  stack.add(value);
  try {
    return serialize();
  } finally {
    stack.delete(value);
  }
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Serializes system instruction parts to a JSON array.
 *
 * The fallback keeps telemetry recording non-throwing when a part contains
 * non-JSON-serializable values.
 */
export function serializeSystemInstructions(parts: SystemInstructionPart[]): string {
  try {
    return JSON.stringify(parts);
  } catch {
    return JSON.stringify([
      {
        type: "text",
        content: `[serialization failed: ${parts.length} ${parts.length === 1 ? "instruction" : "instructions"}]`,
      },
    ]);
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
