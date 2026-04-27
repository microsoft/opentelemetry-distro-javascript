// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-openai

import { SpanStatusCode } from "@opentelemetry/api";
import type { Span as AgentsSpan, SpanData } from "@openai/agents-core";
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
} from "../../index.js";
import { serializeMessages, safeSerializeToJson } from "../../../a365/message-utils.js";
import { MessageRole, A365_MESSAGE_SCHEMA_VERSION } from "../../../a365/contracts.js";
import type {
  ChatMessage,
  OutputMessage,
  InputMessages,
  OutputMessages,
  MessagePart,
} from "../../../a365/contracts.js";
import { MAX_SPAN_SIZE_BYTES } from "../../../a365/exporter/utils.js";
import {
  GEN_AI_EXECUTION_PAYLOAD_KEY,
  GEN_AI_REQUEST_CONTENT_KEY,
  GEN_AI_RESPONSE_CONTENT_KEY,
  GEN_AI_SPAN_KIND_AGENT,
  GEN_AI_SPAN_KIND_CHAIN,
  GEN_AI_SPAN_KIND_CHAT,
  GEN_AI_SPAN_KIND_TOOL,
} from "./semconv.js";

/**
 * Locate and normalize usage counts across OpenAI API shapes:
 * - Responses API:    { input_tokens, output_tokens }
 * - Chat Completions: { prompt_tokens, completion_tokens }
 * Usage may live directly on the span data, on `.output`, or inside `.output[0]`.
 */
export function extractUsageTokens(data: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
} {
  const candidates: Array<Record<string, unknown> | undefined> = [];
  const direct = data.usage as Record<string, unknown> | undefined;
  candidates.push(direct);
  const output = data.output as unknown;
  if (output && typeof output === "object") {
    if (Array.isArray(output)) {
      const first = output[0];
      if (first && typeof first === "object") {
        candidates.push(
          (first as Record<string, unknown>).usage as Record<string, unknown> | undefined,
        );
      }
    } else {
      candidates.push(
        (output as Record<string, unknown>).usage as Record<string, unknown> | undefined,
      );
    }
  }
  for (const usage of candidates) {
    if (!usage) continue;
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens;
    if (typeof inputTokens === "number" || typeof outputTokens === "number") {
      return {
        inputTokens: typeof inputTokens === "number" ? inputTokens : undefined,
        outputTokens: typeof outputTokens === "number" ? outputTokens : undefined,
      };
    }
  }
  return {};
}

/**
 * Safely stringify an object to JSON.
 */
export function safeJsonDumps(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

/**
 * Get span name from OpenAI Agents SDK span.
 */
export function getSpanName(span: AgentsSpan<SpanData>): string {
  const data = span.spanData;

  const dataWithName = data as { name?: string };
  if (dataWithName?.name && typeof dataWithName.name === "string") {
    return dataWithName.name;
  }

  if (data?.type === "handoff") {
    const handoffData = data as Record<string, unknown>;
    if (handoffData.to_agent) {
      return `handoff to ${handoffData.to_agent}`;
    }
  }

  return data?.type || "unknown";
}

/**
 * Map OpenAI span data type to a GenAI operation kind string.
 */
export function getSpanKind(spanData: SpanData | undefined): string {
  if (!spanData?.type) {
    return GEN_AI_SPAN_KIND_CHAIN;
  }

  switch (spanData.type) {
    case "agent":
      return GEN_AI_SPAN_KIND_AGENT;
    case "function":
      return GEN_AI_SPAN_KIND_TOOL;
    case "generation":
    case "response":
      return GEN_AI_SPAN_KIND_CHAT;
    case "handoff":
    case "custom":
    case "guardrail":
    default:
      return GEN_AI_SPAN_KIND_CHAIN;
  }
}

/**
 * Map OpenAI span data type to a GenAI semantic convention operation name.
 */
export function getOperationName(spanData: SpanData | undefined): string {
  if (!spanData?.type) {
    return GEN_AI_SPAN_KIND_CHAIN;
  }

  switch (spanData.type) {
    case "agent":
      return GEN_AI_OPERATION_INVOKE_AGENT;
    case "function":
      return GEN_AI_OPERATION_EXECUTE_TOOL;
    case "generation":
    case "response":
      return GEN_AI_OPERATION_CHAT;
    case "handoff":
      return GEN_AI_OPERATION_INVOKE_AGENT;
    case "custom":
    case "guardrail":
    default:
      return GEN_AI_SPAN_KIND_CHAIN;
  }
}

/**
 * Derive OTel span status from an OpenAI Agents SDK span.
 */
export function getSpanStatus(span: AgentsSpan<SpanData>): {
  code: SpanStatusCode;
  message?: string;
} {
  if (span.error) {
    const message = span.error.message || span.error.data || "Unknown error";
    return { code: SpanStatusCode.ERROR, message: String(message) };
  }
  return { code: SpanStatusCode.OK };
}

/**
 * Extract attributes from a generation span.
 */
export function getAttributesFromGenerationSpanData(data: SpanData): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    [ATTR_GEN_AI_PROVIDER_NAME]: "openai",
  };

  const genData = data as Record<string, unknown>;

  if (typeof genData.model === "string") {
    attributes[ATTR_GEN_AI_REQUEST_MODEL] = genData.model;
  }

  if (genData.model_config || genData.modelConfig) {
    const config = genData.model_config || genData.modelConfig;
    attributes[GEN_AI_EXECUTION_PAYLOAD_KEY] = safeJsonDumps(config);
  }

  if (genData.input) {
    attributes[GEN_AI_REQUEST_CONTENT_KEY] = serializeMessages(
      wrapRawContentAsInputMessages(genData.input),
    );
  }

  if (genData.output) {
    attributes[GEN_AI_RESPONSE_CONTENT_KEY] = serializeMessages(
      wrapRawContentAsOutputMessages(genData.output),
    );
  }

  const genUsage = extractUsageTokens(genData);
  if (genUsage.inputTokens !== undefined) {
    attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS] = genUsage.inputTokens;
  }
  if (genUsage.outputTokens !== undefined) {
    attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS] = genUsage.outputTokens;
  }

  // Map operation name for generation spans
  attributes[ATTR_GEN_AI_OPERATION_NAME] = GEN_AI_OPERATION_CHAT;

  return attributes;
}

/**
 * Extract attributes from a function/tool span.
 */
export function getAttributesFromFunctionSpanData(data: SpanData): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  const funcData = data as Record<string, unknown>;

  if (funcData.name) {
    attributes[ATTR_GEN_AI_TOOL_NAME] = funcData.name;
  }

  if (funcData.input != null) {
    attributes[GEN_AI_REQUEST_CONTENT_KEY] = safeSerializeToJson(
      typeof funcData.input === "object"
        ? (funcData.input as Record<string, unknown>)
        : String(funcData.input),
      "arguments",
    );
  }

  if (funcData.output !== undefined && funcData.output !== null) {
    attributes[GEN_AI_RESPONSE_CONTENT_KEY] = safeSerializeToJson(
      typeof funcData.output === "object"
        ? (funcData.output as Record<string, unknown>)
        : String(funcData.output),
      "result",
    );
  }

  return attributes;
}

/**
 * Extract attributes from an MCP list-tools span.
 */
export function getAttributesFromMCPListToolsSpanData(data: SpanData): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  const mcpData = data as Record<string, unknown>;
  if (mcpData.result) {
    attributes[GEN_AI_RESPONSE_CONTENT_KEY] = safeJsonDumps(mcpData.result);
  }
  return attributes;
}

/**
 * Extract attributes from a response span.
 */
export function getAttributesFromResponse(response: unknown): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  const resp = response as Record<string, unknown>;

  if (resp.model) {
    attributes[ATTR_GEN_AI_REQUEST_MODEL] = resp.model;
  }

  const respUsage = extractUsageTokens(resp);
  if (respUsage.inputTokens !== undefined) {
    attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS] = respUsage.inputTokens;
  }
  if (respUsage.outputTokens !== undefined) {
    attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS] = respUsage.outputTokens;
  }

  return attributes;
}

/** Key remapping table: `${spanType}${originalKey}` → target semconv key */
export const KEY_MAPPINGS = new Map<string, string>([
  [`mcp_tools${GEN_AI_RESPONSE_CONTENT_KEY}`, "gen_ai.tool.call.result"],
  [`mcp_tools${GEN_AI_REQUEST_CONTENT_KEY}`, "gen_ai.tool.call.arguments"],
  [`function${GEN_AI_RESPONSE_CONTENT_KEY}`, "gen_ai.tool.call.result"],
  [`function${GEN_AI_REQUEST_CONTENT_KEY}`, "gen_ai.tool.call.arguments"],
  [`generation${GEN_AI_RESPONSE_CONTENT_KEY}`, "gen_ai.output.messages"],
  [`generation${GEN_AI_REQUEST_CONTENT_KEY}`, "gen_ai.input.messages"],
]);

// ---------------------------------------------------------------------------
// Structured message builders (OTEL gen-ai message format)
// ---------------------------------------------------------------------------

type OpenAIInputMessage = { role: string; content: string | unknown[] | unknown };
type OpenAIOutputItem = {
  role?: string;
  content?: unknown[];
  type?: string;
  text?: string;
  [key: string]: unknown;
};

/**
 * Map an OpenAI role string to a MessageRole value.
 */
function mapOpenAIRole(role: string): MessageRole | string {
  switch (role) {
    case "user":
      return MessageRole.USER;
    case "assistant":
      return MessageRole.ASSISTANT;
    case "system":
      return MessageRole.SYSTEM;
    case "tool":
      return MessageRole.TOOL;
    default:
      return role;
  }
}

function getModalityFromMimeType(mimeType: unknown): string {
  return String(mimeType ?? "file").split("/")[0] || "file";
}

function mapGenericBlock(
  blockType: string | undefined,
  block: Record<string, unknown>,
): MessagePart {
  return { type: blockType ?? "unknown", content: safeJsonDumps(block) } as MessagePart;
}

function parseToolCallArguments(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return { raw: args };
    }
  }

  if (args && typeof args === "object") {
    return args as Record<string, unknown>;
  }

  return undefined;
}

function getToolCallId(block: Record<string, unknown>): string | undefined {
  if (block.call_id != null) return String(block.call_id);
  if (block.id != null) return String(block.id);
  return undefined;
}

function wrapRawContentAsMessages(raw: unknown, role: MessageRole): InputMessages | OutputMessages {
  const content = typeof raw === "string" ? raw : safeJsonDumps(raw);
  return {
    version: A365_MESSAGE_SCHEMA_VERSION,
    messages: [{ role, parts: [{ type: "text", content }] }],
  };
}

/**
 * Map an OpenAI input content block to a MessagePart.
 */
function mapInputContentBlock(block: Record<string, unknown>): MessagePart {
  const blockType = block.type as string | undefined;
  switch (blockType) {
    case "input_text":
      return { type: "text", content: String(block.text ?? "") };
    case "input_image":
      return { type: "blob", modality: "image", ...stripBinaryFields(block) } as MessagePart;
    case "input_file":
      return {
        type: "file" as string,
        modality: getModalityFromMimeType(block.mime_type),
        ...stripBinaryFields(block),
      } as MessagePart;
    default:
      return mapGenericBlock(blockType, block);
  }
}

/**
 * Strip large binary fields from a content block for telemetry.
 */
function stripBinaryFields(block: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (key === "type") continue;
    if (typeof value === "string" && value.length > MAX_SPAN_SIZE_BYTES) {
      result[key] = "[truncated]";
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Map an OpenAI output content block to a MessagePart.
 */
function mapOutputContentBlock(block: Record<string, unknown>): MessagePart {
  const blockType = block.type as string | undefined;
  switch (blockType) {
    case "output_text":
      return { type: "text", content: String(block.text ?? "") };
    case "refusal":
      return { type: "text", content: String(block.refusal ?? "") };
    case "tool_call":
    case "function_call": {
      const parsedArgs = parseToolCallArguments(block.arguments ?? block.args);
      return {
        type: "tool_call",
        name: String(block.name ?? block.function ?? ""),
        id: getToolCallId(block),
        arguments: parsedArgs,
      };
    }
    case "reasoning":
      return { type: "reasoning", content: String(block.text ?? block.content ?? "") };
    default:
      return mapGenericBlock(blockType, block);
  }
}

/**
 * Build structured InputMessages from an OpenAI _input message array.
 * Includes all roles (system, user, assistant, tool).
 */
export function buildStructuredInputMessages(arr: OpenAIInputMessage[]): InputMessages {
  const messages: ChatMessage[] = [];

  for (const msg of arr) {
    if (!msg || typeof msg !== "object") continue;

    const role = mapOpenAIRole(msg.role ?? "user");
    let parts: MessagePart[];

    if (typeof msg.content === "string") {
      parts = [{ type: "text", content: msg.content }];
    } else if (Array.isArray(msg.content)) {
      parts = (msg.content as Record<string, unknown>[]).map(mapInputContentBlock);
    } else {
      parts = [{ type: "text", content: safeJsonDumps(msg.content) }];
    }

    messages.push({ role, parts });
  }

  return { version: A365_MESSAGE_SCHEMA_VERSION, messages };
}

/**
 * Build structured OutputMessages from an OpenAI response.output array.
 */
export function buildStructuredOutputMessages(arr: OpenAIOutputItem[]): OutputMessages {
  const messages: OutputMessage[] = [];

  for (const item of arr) {
    if (!item || typeof item !== "object") continue;

    const role = mapOpenAIRole(item.role ?? "assistant");

    // Items with a content array (standard response format)
    if (Array.isArray(item.content)) {
      const parts = (item.content as Record<string, unknown>[]).map(mapOutputContentBlock);
      messages.push({ role, parts });
      continue;
    }

    // Items that are themselves content blocks (e.g., type: 'message' with text)
    if (item.type && typeof item.type === "string") {
      const parts = [mapOutputContentBlock(item as Record<string, unknown>)];
      messages.push({ role, parts });
      continue;
    }

    // Fallback: stringify the item
    messages.push({
      role,
      parts: [{ type: "text", content: safeJsonDumps(item) }],
    });
  }

  return { version: A365_MESSAGE_SCHEMA_VERSION, messages };
}

/**
 * Wrap opaque raw content as InputMessages (for generation span data).
 */
export function wrapRawContentAsInputMessages(raw: unknown): InputMessages {
  return wrapRawContentAsMessages(raw, MessageRole.USER) as InputMessages;
}

/**
 * Wrap opaque raw content as OutputMessages (for generation span data).
 */
export function wrapRawContentAsOutputMessages(raw: unknown): OutputMessages {
  return wrapRawContentAsMessages(raw, MessageRole.ASSISTANT) as OutputMessages;
}
