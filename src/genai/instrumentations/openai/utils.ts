// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-openai
// Adapted: removed A365 observability imports, uses local semconv + truncateValue

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
import { truncateValue } from "../../utils.js";
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
 * Safely stringify an object to JSON, truncating to the attribute limit.
 */
export function safeJsonDumps(obj: unknown): string {
  try {
    return truncateValue(JSON.stringify(obj));
  } catch {
    return truncateValue(String(obj));
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
    attributes[GEN_AI_REQUEST_CONTENT_KEY] = safeJsonDumps(genData.input);
  }

  if (genData.output) {
    attributes[GEN_AI_RESPONSE_CONTENT_KEY] = safeJsonDumps(genData.output);
  }

  if (genData.usage) {
    const usage = genData.usage as Record<string, unknown>;
    if (usage.input_tokens !== undefined) {
      attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS] = usage.input_tokens;
    }
    if (usage.output_tokens !== undefined) {
      attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS] = usage.output_tokens;
    }
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

  if (funcData.input) {
    attributes[GEN_AI_REQUEST_CONTENT_KEY] =
      typeof funcData.input === "string"
        ? truncateValue(funcData.input)
        : safeJsonDumps(funcData.input);
  }

  if (funcData.output !== undefined && funcData.output !== null) {
    const output =
      typeof funcData.output === "object"
        ? safeJsonDumps(funcData.output)
        : truncateValue(String(funcData.output));
    attributes[GEN_AI_RESPONSE_CONTENT_KEY] = output;
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

  if (resp.usage) {
    const usage = resp.usage as Record<string, unknown>;
    if (usage.input_tokens !== undefined) {
      attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS] = usage.input_tokens;
    }
    if (usage.output_tokens !== undefined) {
      attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS] = usage.output_tokens;
    }
  }

  return attributes;
}

/** Content-sensitive attribute keys that should only be recorded when content recording is enabled. */
export const CONTENT_KEYS = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  GEN_AI_REQUEST_CONTENT_KEY,
  GEN_AI_RESPONSE_CONTENT_KEY,
]);

/** Key remapping table: `${spanType}${originalKey}` → target semconv key */
export const KEY_MAPPINGS = new Map<string, string>([
  [`mcp_tools${GEN_AI_RESPONSE_CONTENT_KEY}`, "gen_ai.tool.call.result"],
  [`mcp_tools${GEN_AI_REQUEST_CONTENT_KEY}`, "gen_ai.tool.call.arguments"],
  [`function${GEN_AI_RESPONSE_CONTENT_KEY}`, "gen_ai.tool.call.result"],
  [`function${GEN_AI_REQUEST_CONTENT_KEY}`, "gen_ai.tool.call.arguments"],
  [`generation${GEN_AI_RESPONSE_CONTENT_KEY}`, "gen_ai.output.messages"],
  [`generation${GEN_AI_REQUEST_CONTENT_KEY}`, "gen_ai.input.messages"],
]);

/**
 * Build a JSON string of input messages, extracting user-role content.
 */
export function buildInputMessages(arr: Array<{ role: string; content: string }>): string {
  const userTexts = arr
    .filter((m) => m && m.role === "user" && typeof m.content === "string")
    .map((m) => m.content);
  return JSON.stringify(userTexts.length ? userTexts : arr);
}

/**
 * Build a JSON string of output messages, extracting output_text content.
 */
export function buildOutputMessages(
  arr: Array<{ role: string; content: Array<{ type: string; text: string }> }>,
): string {
  const userTexts: string[] = [];
  for (const { content } of arr) {
    if (!Array.isArray(content)) {
      continue;
    }
    for (const { type, text } of content) {
      if (type === "output_text" && typeof text === "string") {
        userTexts.push(text);
      }
    }
  }
  return JSON.stringify(userTexts.length ? userTexts : arr);
}
