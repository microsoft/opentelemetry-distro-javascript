// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-langchain

import { Run } from "@langchain/core/tracers/base";
import { Span } from "@opentelemetry/api";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
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

// Type guards
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

// Operation type mapping
export function getOperationType(run: Run): string {
  let operation = "unknown";

  if (run.run_type === "chain" && isLangGraphAgentInvoke(run)) {
    operation = GEN_AI_OPERATION_INVOKE_AGENT;
  } else if (run.run_type === "tool") {
    operation = GEN_AI_OPERATION_EXECUTE_TOOL;
  } else if (run.run_type === "llm") {
    operation = GEN_AI_OPERATION_CHAT;
  }
  return operation;
}

// Operation type mapping
export function setOperationTypeAttribute(operation: string, span: Span) {
  span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, operation);
}

// Agent attributes
export function setAgentAttributes(run: Run, span: Span) {
  if (isLangGraphAgentInvoke(run)) {
    const agentName = run.name;
    if (isString(agentName)) {
      span.setAttribute(ATTR_GEN_AI_AGENT_NAME, agentName);
    }
  }
}

// Tool attributes
export function setToolAttributes(run: Run, span: Span) {
  if (run.run_type !== "tool") {
    return;
  }
  if (!run.serialized || typeof run.serialized !== "object" || Array.isArray(run.serialized)) {
    return;
  }

  if (isString(run.name)) {
    span.setAttribute(ATTR_GEN_AI_TOOL_NAME, run.name);
  }
  if (run.inputs) {
    const argsValue = run.inputs?.input ?? run.inputs;
    span.setAttribute(
      ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
      safeSerializeToJson(
        typeof argsValue === "object" ? (argsValue as Record<string, unknown>) : String(argsValue),
        "arguments",
      ),
    );
  }

  // Tool result: v0 uses output.kwargs.content, v1 returns output as a plain string or has content directly
  const toolResult =
    run.outputs?.output?.kwargs?.content ??
    (isString(run.outputs?.output) ? run.outputs.output : null) ??
    run.outputs?.output?.content;
  if (toolResult != null) {
    span.setAttribute(
      ATTR_GEN_AI_TOOL_CALL_RESULT,
      safeSerializeToJson(
        typeof toolResult === "object"
          ? (toolResult as Record<string, unknown>)
          : String(toolResult),
        "result",
      ),
    );
  }

  span.setAttribute(ATTR_GEN_AI_TOOL_TYPE, "extension");

  // Tool call ID: v0 uses output.tool_call_id, v1 may have it on inputs
  const toolCallId = run.outputs?.output?.tool_call_id ?? run.inputs?.tool_call_id;
  if (toolCallId) span.setAttribute(ATTR_GEN_AI_TOOL_CALL_ID, toolCallId);
}

export function setInputMessagesAttribute(run: Run, span: Span) {
  const messages = run.inputs?.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  // LangChain may provide messages as a direct array or as a single nested array.
  // Normalize both shapes so agent/inference inputs are consistently processed.
  const preprocess =
    getScopeType(run) !== "unknown" && messages.length > 0 && Array.isArray(messages[0])
      ? (messages[0] as unknown[])
      : messages;
  const chatMessages: ChatMessage[] = [];

  for (const msg of preprocess) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;
    const parts = buildPartsFromMessage(msgObj);
    if (parts.length === 0) continue;

    const msgType = getMessageType(msgObj);
    const role = mapLangChainRole(msgType);
    chatMessages.push({ role, parts });
  }

  if (chatMessages.length > 0) {
    const wrapper: InputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
      messages: chatMessages,
    };
    span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, serializeMessages(wrapper));
  }
}

// Helper: Extract string content from a message (used for fallback text extraction and system instructions)
function extractStringContent(msg: Record<string, unknown>): string | null {
  const raw = extractRawContent(msg);
  return isString(raw) ? raw : null;
}

// Helper: Extract raw content (string or content block array) from various message formats
function extractRawContent(msg: Record<string, unknown>): string | unknown[] | null {
  // Simple format: {role: "user", content: string | array}
  if (msg.content !== undefined && msg.content !== null) {
    if (isString(msg.content)) return msg.content;
    if (Array.isArray(msg.content)) return msg.content;
  }

  // LangChain format: {lc_type: "human", lc_kwargs: {content}}
  if (msg.lc_kwargs && typeof msg.lc_kwargs === "object" && !Array.isArray(msg.lc_kwargs)) {
    const kwargs = msg.lc_kwargs as Record<string, unknown>;
    if (isString(kwargs.content)) return kwargs.content;
    if (Array.isArray(kwargs.content)) return kwargs.content;
  }

  // LangChain v1 serialized class instance format: { lc: 1, type: "constructor", kwargs: {...} }
  if (
    msg.lc === 1 &&
    msg.type === "constructor" &&
    msg.kwargs &&
    typeof msg.kwargs === "object" &&
    !Array.isArray(msg.kwargs)
  ) {
    const kwargs = msg.kwargs as Record<string, unknown>;
    if (isString(kwargs.content)) return kwargs.content;
    if (Array.isArray(kwargs.content)) return kwargs.content;
  }
  return null;
}

// Helper: Map LangChain message type to MessageRole
function mapLangChainRole(msgType: string): MessageRole | string {
  switch (msgType) {
    case "user":
    case "human":
      return MessageRole.USER;
    case "assistant":
    case "ai":
      return MessageRole.ASSISTANT;
    case "system":
      return MessageRole.SYSTEM;
    case "tool":
      return MessageRole.TOOL;
    default:
      return msgType;
  }
}

// Helper: Build MessagePart[] from a LangChain message
function buildPartsFromMessage(msg: Record<string, unknown>): MessagePart[] {
  const parts: MessagePart[] = [];
  const rawContent = extractRawContent(msg);

  const addUnknownBlockPart = (blockType: string, block: Record<string, unknown>) => {
    try {
      parts.push({ type: blockType, content: JSON.stringify(block) } as MessagePart);
    } catch {
      parts.push({ type: blockType, content: "[unserializable]" } as MessagePart);
    }
  };

  const addPartFromContentBlock = (block: unknown) => {
    if (!block || typeof block !== "object") return;

    const contentBlock = block as Record<string, unknown>;
    const blockType = contentBlock.type as string | undefined;
    if (!blockType) return;

    if (blockType === "text" && isString(contentBlock.text)) {
      parts.push({ type: "text", content: contentBlock.text });
      return;
    }

    if (blockType === "reasoning" && isString(contentBlock.reasoning)) {
      parts.push({ type: "reasoning", content: contentBlock.reasoning });
      return;
    }

    if (blockType === "tool_call") {
      parts.push({
        type: "tool_call",
        name: String(contentBlock.name ?? ""),
        id: contentBlock.id != null ? String(contentBlock.id) : undefined,
        arguments:
          contentBlock.args && typeof contentBlock.args === "object"
            ? (contentBlock.args as Record<string, unknown>)
            : undefined,
      });
      return;
    }

    addUnknownBlockPart(blockType, contentBlock);
  };

  if (isString(rawContent)) {
    parts.push({ type: "text", content: rawContent });
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      addPartFromContentBlock(block);
    }
  }

  // Extract tool_calls from the message (AI messages may have a separate tool_calls array)
  // Deduplicate by ID to avoid duplicates when tool_calls appear in both content blocks and tool_calls array
  const seenToolCallIds = new Set<string>();
  for (const part of parts) {
    if (part.type !== "tool_call") continue;
    const partId = (part as Record<string, unknown>).id;
    if (isString(partId)) {
      seenToolCallIds.add(partId);
    }
  }

  for (const toolCall of extractToolCalls(msg)) {
    const toolCallId = (toolCall as Record<string, unknown>).id;
    if (isString(toolCallId) && seenToolCallIds.has(toolCallId)) {
      continue;
    }
    if (isString(toolCallId)) {
      seenToolCallIds.add(toolCallId);
    }
    parts.push(toolCall);
  }

  // Fallback: if no parts were built, use text extraction
  if (parts.length === 0) {
    const textContent = extractStringContent(msg);
    if (textContent) {
      parts.push({ type: "text", content: textContent });
    }
  }

  return parts;
}

// Helper: Extract tool_calls from a LangChain message
function extractToolCalls(msg: Record<string, unknown>): MessagePart[] {
  const parts: MessagePart[] = [];

  // Standard format: message.tool_calls[] — check direct, lc_kwargs, and kwargs paths
  const directToolCalls =
    getNestedValue(msg, "tool_calls") ??
    getNestedValue(msg, "lc_kwargs", "tool_calls") ??
    getNestedValue(msg, "kwargs", "tool_calls");
  if (Array.isArray(directToolCalls)) {
    for (const tc of directToolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      parts.push({
        type: "tool_call",
        name: String(call.name ?? ""),
        id: call.id != null ? String(call.id) : undefined,
        arguments:
          call.args && typeof call.args === "object"
            ? (call.args as Record<string, unknown>)
            : undefined,
      });
    }
  }

  return parts;
}

// Helper: Safely get a nested value from a message object
function getNestedValue(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// Helper: Determine message type
function getMessageType(msg: Record<string, unknown>): string {
  // Simple format
  if (isString(msg.role)) return msg.role;
  // LangChain old format
  if (isString(msg.lc_type)) return msg.lc_type;
  // Skip v1 constructor type marker — fall through to id array check
  if (isString(msg.type) && msg.type !== "constructor") return msg.type;
  // LangChain v1 format - check id array for message type (e.g., ["langchain_core", "messages", "HumanMessage"])
  if (Array.isArray(msg.id)) {
    const lastId = msg.id[msg.id.length - 1];
    if (isString(lastId)) {
      if (lastId.includes("Human")) return "human";
      if (lastId.includes("AI")) return "ai";
      if (lastId.includes("System")) return "system";
      if (lastId.includes("Tool")) return "tool";
    }
  }
  return "unknown";
}

// Helper: Determine scope type from run
function getScopeType(run: Run): "agent" | "tool" | "inference" | "unknown" {
  if (run.run_type === "chain" && isLangGraphAgentInvoke(run)) {
    return "agent";
  } else if (run.run_type === "tool") {
    return "tool";
  } else if (run.run_type === "llm") {
    return "inference";
  }
  return "unknown";
}

// Helper: Check if output message should be included based on scope and message type
function shouldIncludeOutputMessage(scopeType: string, msgType: string): boolean {
  if (scopeType === "agent" || scopeType === "inference") {
    // Agent and Inference scopes want assistant/AI messages only
    return msgType === "ai" || msgType === "assistant";
  } else if (scopeType === "tool") {
    // Tool scope wants all output messages
    return true;
  }
  // Default: all messages
  return true;
}

export function setOutputMessagesAttribute(run: Run, span: Span) {
  const outputs = run.outputs;
  if (!outputs) {
    return;
  }

  const scopeType = getScopeType(run);
  const outputMessages: OutputMessage[] = [];

  // Helper: process a single message object into an OutputMessage
  const processMessage = (msg: Record<string, unknown>) => {
    const msgType = getMessageType(msg);
    if (!shouldIncludeOutputMessage(scopeType, msgType)) return;

    const parts = buildPartsFromMessage(msg);
    if (parts.length === 0) return;

    const role = mapLangChainRole(msgType);
    outputMessages.push({ role, parts });
  };

  // Direct messages array (used in agent/chain outputs)
  if (Array.isArray(outputs.messages)) {
    for (const msg of outputs.messages as Record<string, unknown>[]) {
      processMessage(msg);
    }
  }

  // LangChain generations format (used in LLM/inference outputs)
  if (Array.isArray(outputs.generations)) {
    outputs.generations.forEach((gen: unknown) => {
      if (Array.isArray(gen)) {
        gen.forEach((item: Record<string, unknown>) => {
          // Try message property
          if (item.message && typeof item.message === "object" && !Array.isArray(item.message)) {
            processMessage(item.message as Record<string, unknown>);
          }
          // Try direct text property (for generation items)
          else if (isString(item.text) && scopeType === "inference") {
            outputMessages.push({
              role: MessageRole.ASSISTANT,
              parts: [{ type: "text", content: item.text }],
            });
          }
        });
      }
    });
  }

  // Check for direct message object (some models return this)
  if (outputs.message && typeof outputs.message === "object" && !Array.isArray(outputs.message)) {
    processMessage(outputs.message as Record<string, unknown>);
  }

  if (outputMessages.length > 0) {
    const wrapper: OutputMessages = {
      version: A365_MESSAGE_SCHEMA_VERSION,
      messages: outputMessages,
    };
    span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, serializeMessages(wrapper));
  }
}

// Model - Helper to extract the request-side model (deployment alias / configured model)
// from a LangChain run. Prefers fields populated by the caller's configuration
// (e.g. AzureChatOpenAI deployment) over the resolved response model so that the
// Azure deployment alias is preserved for telemetry.
export function getRequestModel(run: Run): string | undefined {
  const invocationParams = run.extra?.invocation_params as Record<string, unknown> | undefined;
  return [
    // Azure-specific deployment aliases used by AzureChatOpenAI / AzureOpenAI.
    // These are checked first because LangChain.js fills invocation_params.model
    // with a default (e.g. "gpt-3.5-turbo") for Azure clients even when the user
    // only configured a deployment name, so the deployment alias is the most
    // accurate request-side identifier when present.
    invocationParams?.azureOpenAIApiDeploymentName,
    invocationParams?.azure_deployment,
    invocationParams?.deployment_name,
    // LangChain-set request-side identifier (both v0 and v1)
    run.extra?.metadata?.ls_model_name,
    // Generic OpenAI-style request model from invocation params
    invocationParams?.model,
    invocationParams?.model_name,
  ]
    .map((v) => (v != null ? String(v).trim() : ""))
    .find((v) => v.length > 0);
}

// Model - Helper to extract the response-side model (the model that actually
// served the request, e.g. the underlying OpenAI model behind an Azure deployment).
export function getResponseModel(run: Run): string | undefined {
  const llmOutput = run.outputs?.llmOutput as Record<string, unknown> | undefined;
  return [
    // v1: response_metadata directly on message
    run.outputs?.generations?.[0]?.[0]?.message?.response_metadata?.model_name,
    // v0: response_metadata nested under kwargs
    run.outputs?.generations?.[0]?.[0]?.message?.kwargs?.response_metadata?.model_name,
    // LLMResult.llmOutput.model_name (common for Chat models)
    llmOutput?.model_name,
    llmOutput?.model,
  ]
    .map((v) => (v != null ? String(v).trim() : ""))
    .find((v) => v.length > 0);
}

// Model - Helper kept for backwards compatibility (e.g. span naming). Prefers the
// request model so the deployment alias is used, falling back to the response model
// only when the request side is not available.
export function getModel(run: Run): string | undefined {
  return getRequestModel(run) ?? getResponseModel(run);
}

// Model - Set request and response model attributes on the span.
export function setModelAttribute(run: Run, span: Span) {
  const requestModel = getRequestModel(run);
  const responseModel = getResponseModel(run);

  if (requestModel) {
    span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, requestModel);
  } else if (responseModel) {
    // Preserve prior behavior of always populating gen_ai.request.model when at
    // least one model identifier is available, so spans aren't left without any
    // model attribution when invocation params are missing.
    span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, responseModel);
  }

  if (responseModel) {
    span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, responseModel);
  }
}

// Provider
export function setProviderNameAttribute(run: Run, span: Span) {
  const provider = (run.extra?.metadata as Record<string, unknown> | undefined)?.ls_provider;
  if (isString(provider)) span.setAttribute(ATTR_GEN_AI_PROVIDER_NAME, provider.toLowerCase());
}

export function setSessionIdAttribute(run: Run, span: Span): void {
  const metadata = run.extra?.metadata as Record<string, unknown> | undefined;
  if (!metadata) return;

  const sessionId = metadata.session_id ?? metadata.thread_id;
  if (isString(sessionId) && sessionId.length > 0) {
    span.setAttribute(ATTR_MICROSOFT_SESSION_ID, sessionId);
  }

  const conversationId = metadata.conversation_id;
  if (isString(conversationId) && conversationId.length > 0) {
    span.setAttribute(ATTR_GEN_AI_CONVERSATION_ID, conversationId);
  }
}

// System instructions
export function setSystemInstructionsAttribute(run: Run, span: Span) {
  const inputs = run.inputs as Record<string, unknown> | undefined;
  if (!inputs) {
    return;
  }

  const prompts = Array.isArray(inputs.prompts)
    ? inputs.prompts
        .map((p) => String(p ?? "").trim())
        .filter(Boolean)
        .join("\n")
    : "";
  if (prompts) return span.setAttribute(ATTR_GEN_AI_SYSTEM_INSTRUCTIONS, prompts);

  // Check both flat and nested message arrays
  const rawMessages = Array.isArray(inputs.messages) ? inputs.messages : [];
  const flatMessages =
    rawMessages.length > 0 && Array.isArray(rawMessages[0])
      ? (rawMessages[0] as unknown[])
      : rawMessages;
  const systemText = flatMessages
    .filter((m: unknown) => {
      if (!m || typeof m !== "object") return false;
      const msgType = getMessageType(m as Record<string, unknown>);
      return msgType === "system";
    })
    .map((m: unknown) => extractStringContent(m as Record<string, unknown>) ?? "")
    .map((s: string) => s.trim())
    .filter(Boolean)
    .join("\n");
  if (systemText) span.setAttribute(ATTR_GEN_AI_SYSTEM_INSTRUCTIONS, systemText);
}

// Tokens (input and output)
export function setTokenAttributes(run: Run, span: Span) {
  // Try multiple paths to find usage metadata (LLM direct/kwargs/response_metadata, agent calls, and chain/model_request outputs)
  // v1: usage_metadata is often on the last AI message in outputs.messages
  const lastMsg = Array.isArray(run.outputs?.messages)
    ? run.outputs.messages[run.outputs.messages.length - 1]
    : undefined;
  const usage =
    run.outputs?.generations?.[0]?.[0]?.message?.usage_metadata ||
    run.outputs?.generations?.[0]?.[0]?.message?.kwargs?.usage_metadata ||
    run.outputs?.generations?.[0]?.[0]?.message?.response_metadata?.tokenUsage ||
    run.outputs?.generations?.[0]?.[0]?.message?.kwargs?.response_metadata?.tokenUsage ||
    lastMsg?.usage_metadata ||
    run.outputs?.message?.response_metadata?.usage ||
    run.outputs?.message?.response_metadata?.tokenUsage ||
    run.outputs?.messages
      ?.map(
        (msg: Record<string, unknown>) =>
          (msg.response_metadata as Record<string, unknown> | undefined)?.tokenUsage,
      )
      .filter(Boolean)[0];

  if (!usage || typeof usage !== "object") {
    return;
  }

  const usageObj = usage as Record<string, unknown>;
  // Support both usage_metadata shape (input_tokens/output_tokens) and
  // tokenUsage shape (promptTokens/completionTokens) from LangChain OpenAI provider
  const inputTokens = usageObj.input_tokens ?? usageObj.promptTokens;
  const outputTokens = usageObj.output_tokens ?? usageObj.completionTokens;
  if (typeof inputTokens === "number") {
    span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, inputTokens);
  }
  if (typeof outputTokens === "number") {
    span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, outputTokens);
  }
}

// LangGraph agent check
function isLangGraphAgentInvoke(run: Run): boolean {
  if (run.run_type !== "chain") {
    return false;
  }
  if (!run.serialized || typeof run.serialized !== "object" || Array.isArray(run.serialized)) {
    return false;
  }
  const serialized = run.serialized as Record<string, unknown>;
  const id = serialized.id;
  return Array.isArray(id) && id.includes("langgraph") && id.includes("CompiledStateGraph");
}
