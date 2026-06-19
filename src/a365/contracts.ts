// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * A365 observability contracts — types for scopes, messages, and telemetry details.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability/src/tracing/contracts.ts
 * following OTel gen-ai semantic conventions.
 */

import type { SpanKind, TimeInput, Link, Context, TraceState } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// Default finish reason (per OTel spec)
// ---------------------------------------------------------------------------

/** Default finish reason applied when none is provided (per OTel spec). */
export const DEFAULT_FINISH_REASON = "stop" as const;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Role of a message participant per OTEL gen-ai semantic conventions. */
export enum MessageRole {
  /** A system / developer instruction message. */
  SYSTEM = "system",
  /** A message authored by the end user. */
  USER = "user",
  /** A message authored by the model/assistant. */
  ASSISTANT = "assistant",
  /** A message containing the result of a tool call. */
  TOOL = "tool",
}

/** Reason a model stopped generating per OTEL gen-ai semantic conventions. */
export enum FinishReason {
  /** The model reached a natural stopping point or a provided stop sequence. */
  STOP = "stop",
  /** Generation stopped because the maximum token limit was reached. */
  LENGTH = "length",
  /** Generation was stopped by a content filter. */
  CONTENT_FILTER = "content_filter",
  /** The model emitted a tool call and is awaiting its result. */
  TOOL_CALL = "tool_call",
  /** Generation stopped because of an error. */
  ERROR = "error",
}

/** Media modality for blob, file, and URI parts. */
export enum Modality {
  /** Image content. */
  IMAGE = "image",
  /** Video content. */
  VIDEO = "video",
  /** Audio content. */
  AUDIO = "audio",
}

/** Represents different roles that can invoke an agent. */
export enum InvocationRole {
  /** The agent was invoked by a human user. */
  Human = "Human",
  /** The agent was invoked by another agent. */
  Agent = "Agent",
  /** The agent was invoked by a system event or trigger. */
  Event = "Event",
  /** The invoking role could not be determined. */
  Unknown = "Unknown",
}

/** Represents different operation types for model inference. */
export enum InferenceOperationType {
  /** A chat-completion request. */
  CHAT = "Chat",
  /** A text-completion request. */
  TEXT_COMPLETION = "TextCompletion",
  /** A multimodal content-generation request. */
  GENERATE_CONTENT = "GenerateContent",
}

// ---------------------------------------------------------------------------
// Message parts (discriminated union on `type`)
// ---------------------------------------------------------------------------

/** Plain text content. */
export interface TextPart {
  /** Discriminator identifying this as a text part. */
  type: "text";
  /** The text content. */
  content: string;
}

/** A tool call requested by the model. */
export interface ToolCallRequestPart {
  /** Discriminator identifying this as a tool-call request part. */
  type: "tool_call";
  /** The name of the tool being called. */
  name: string;
  /** Unique identifier correlating this call with its response. */
  id?: string;
  /** Arguments passed to the tool, as an object or positional array. */
  arguments?: Record<string, unknown> | unknown[];
}

/** Result of a tool call. */
export interface ToolCallResponsePart {
  /** Discriminator identifying this as a tool-call response part. */
  type: "tool_call_response";
  /** Identifier of the originating tool call. */
  id?: string;
  /** The value returned by the tool. */
  response?: unknown;
}

/** Model reasoning / chain-of-thought content. */
export interface ReasoningPart {
  /** Discriminator identifying this as a reasoning part. */
  type: "reasoning";
  /** The reasoning / chain-of-thought text. */
  content: string;
}

/** Inline binary data (base64-encoded). */
export interface BlobPart {
  /** Discriminator identifying this as an inline blob part. */
  type: "blob";
  /** Media modality of the content (e.g. image, audio, video). */
  modality: Modality | string;
  /** MIME type of the content (e.g. `image/png`). */
  mime_type?: string;
  /** Base64-encoded binary content. */
  content: string;
}

/** Reference to a pre-uploaded file. */
export interface FilePart {
  /** Discriminator identifying this as a file-reference part. */
  type: "file";
  /** Media modality of the referenced file. */
  modality: Modality | string;
  /** MIME type of the referenced file. */
  mime_type?: string;
  /** Identifier of the pre-uploaded file. */
  file_id: string;
}

/** External URI reference. */
export interface UriPart {
  /** Discriminator identifying this as a URI-reference part. */
  type: "uri";
  /** Media modality of the referenced content. */
  modality: Modality | string;
  /** MIME type of the referenced content. */
  mime_type?: string;
  /** The external URI of the content. */
  uri: string;
}

/** Extensible server tool call details. */
export interface GenericServerToolCall {
  /** The server tool-call type discriminator. */
  type: string;
  /** Additional, provider-specific server tool-call fields. */
  [key: string]: unknown;
}

/** Extensible server tool call response. */
export interface GenericServerToolCallResponse {
  /** The server tool-call response type discriminator. */
  type: string;
  /** Additional, provider-specific server tool-call response fields. */
  [key: string]: unknown;
}

/** Server-side tool invocation. */
export interface ServerToolCallPart {
  /** Discriminator identifying this as a server tool-call part. */
  type: "server_tool_call";
  /** The name of the server-side tool being called. */
  name: string;
  /** Unique identifier correlating this call with its response. */
  id?: string;
  /** The server tool-call details. */
  server_tool_call: GenericServerToolCall;
}

/** Server-side tool response. */
export interface ServerToolCallResponsePart {
  /** Discriminator identifying this as a server tool-call response part. */
  type: "server_tool_call_response";
  /** Identifier of the originating server tool call. */
  id?: string;
  /** The server tool-call response details. */
  server_tool_call_response: GenericServerToolCallResponse;
}

/** Extensible part for custom / future types. */
export interface GenericPart {
  /** The part type discriminator. */
  type: string;
  /** Additional, custom part fields. */
  [key: string]: unknown;
}

/** Union of all message part types per OTEL gen-ai semantic conventions. */
export type MessagePart =
  | TextPart
  | ToolCallRequestPart
  | ToolCallResponsePart
  | ReasoningPart
  | BlobPart
  | FilePart
  | UriPart
  | ServerToolCallPart
  | ServerToolCallResponsePart
  | GenericPart;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** An input message sent to a model (OTEL gen-ai semantic conventions). */
export interface ChatMessage {
  /** Role of the message author (e.g. `user`, `assistant`). */
  role: MessageRole | string;
  /** Ordered list of content parts that make up the message. */
  parts: MessagePart[];
  /** Optional display name of the message author. */
  name?: string;
}

/** A structured wrapper around the list of input messages. */
export interface InputMessages {
  /** The input messages, in order. */
  messages: ChatMessage[];
}

/**
 * An output message produced by a model (OTEL gen-ai semantic conventions).
 * `finish_reason` defaults to `"stop"` per OTel spec when not provided.
 */
export interface OutputMessage extends ChatMessage {
  /** Reason the model stopped generating this message. Defaults to `"stop"`. */
  finish_reason?: FinishReason | string;
}

/** A structured wrapper around the list of output messages. */
export interface OutputMessages {
  /** The output messages, in order. */
  messages: OutputMessage[];
}

/** Accepted input for `recordInputMessages`. Supports a single string, an array of strings (backward compat), or the structured wrapper. */
export type InputMessagesParam = string | string[] | InputMessages;

/** Accepted input for `recordOutputMessages`. Supports a single string, an array of strings (backward compat), or the structured wrapper. */
export type OutputMessagesParam = string | string[] | OutputMessages;

/** Accepted input for `OutputResponse.messages`. */
export type ResponseMessagesParam = OutputMessagesParam | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Channel & Request
// ---------------------------------------------------------------------------

/** Represents a channel for an invocation. */
export interface Channel {
  /** Unique identifier of the channel. */
  id?: string;
  /** Display name of the channel (e.g. `Microsoft Teams`). */
  name?: string;
  /** URI of the channel's icon. */
  iconUri?: string;
  /** Role that the channel plays in the invocation. */
  role?: InvocationRole;
  /** Human-readable description or deep link for the channel. */
  description?: string;
}

/** Represents a request with telemetry context. */
export interface Request {
  /** The input content (prompt / messages) for the request. */
  content?: InputMessagesParam;
  /** Identifier of the session this request belongs to. */
  sessionId?: string;
  /** The channel the request originated from. */
  channel?: Channel;
  /** Identifier of the conversation this request belongs to. */
  conversationId?: string;
}

// ---------------------------------------------------------------------------
// Agent, User, Caller details
// ---------------------------------------------------------------------------

/** Details about an AI agent. */
export interface AgentDetails {
  /** Unique identifier of the agent (required). */
  agentId: string;
  /** Display name of the agent. */
  agentName?: string;
  /** Human-readable description of the agent. */
  agentDescription?: string;
  /** URI of the agent's icon. */
  iconUri?: string;
  /** Identifier of the platform hosting the agent. */
  platformId?: string;
  /** Agentic user identifier (AAD Object ID) associated with the agent. */
  agentAUID?: string;
  /** Email address associated with the agentic user. */
  agentEmail?: string;
  /** Identifier of the blueprint the agent was created from. */
  agentBlueprintId?: string;
  /** Identifier of the tenant that owns the agent. */
  tenantId?: string;
  /** Name of the provider that hosts the agent. */
  providerName?: string;
  /** Version of the agent. */
  agentVersion?: string;
}

/** Details about the human user caller. */
export interface UserDetails {
  /** Unique identifier of the user. */
  userId?: string;
  /** Email address of the user. */
  userEmail?: string;
  /** Display name of the user. */
  userName?: string;
  /** Identifier of the tenant the user belongs to. */
  tenantId?: string;
  /** Client IP address of the caller. */
  callerClientIp?: string;
}

/**
 * Caller details for scope creation.
 * Supports human callers, agent callers, or both (A2A with a human in the chain).
 */
export interface CallerDetails {
  /** Identity details of the human user caller. */
  userDetails?: UserDetails;
  /** Identity details of the calling agent (for agent-to-agent scenarios). */
  callerAgentDetails?: AgentDetails;
}

// ---------------------------------------------------------------------------
// Service endpoint
// ---------------------------------------------------------------------------

/** Represents an endpoint for agent invocation. */
export interface ServiceEndpoint {
  /** Host name or IP address of the endpoint. */
  host: string;
  /** Port number of the endpoint. */
  port?: number;
  /** Protocol scheme of the endpoint (e.g. `https`). */
  protocol?: string;
}

// ---------------------------------------------------------------------------
// Scope detail types
// ---------------------------------------------------------------------------

/** Details for invoking agent scope. */
export interface InvokeAgentScopeDetails {
  /** Endpoint the agent is being invoked on. */
  endpoint?: ServiceEndpoint;
}

/** Details of a tool call made by an agent. */
export interface ToolCallDetails {
  /** Name of the tool being called (required). */
  toolName: string;
  /** Arguments passed to the tool, as an object or serialized string. */
  arguments?: Record<string, unknown> | string;
  /** Unique identifier of the tool call. */
  toolCallId?: string;
  /** Human-readable description of the tool. */
  description?: string;
  /** Category/type of the tool (e.g. `function`). */
  toolType?: string;
  /** Endpoint the tool is hosted on. */
  endpoint?: ServiceEndpoint;
}

/** Details for an inference call. */
export interface InferenceDetails {
  /** The inference operation type (e.g. chat, text completion). */
  operationName: InferenceOperationType;
  /** Name of the model used for inference. */
  model: string;
  /** Name of the provider serving the model. */
  providerName?: string;
  /** Number of input (prompt) tokens. */
  inputTokens?: number;
  /** Number of output (completion) tokens. */
  outputTokens?: number;
  /** Finish reasons returned by the model. */
  finishReasons?: string[];
  /** The model's thought process / reasoning trace. */
  thoughtProcess?: string;
  /** Endpoint the model is hosted on. */
  endpoint?: ServiceEndpoint;
}

/** Details for recording the response from an inference call. */
export interface InferenceResponse {
  /** The response content produced by the model. */
  content: string;
  /** Unique identifier of the response. */
  responseId?: string;
  /** Reason the model stopped generating. */
  finishReason?: string;
  /** Number of input (prompt) tokens. */
  inputTokens?: number;
  /** Number of output (completion) tokens. */
  outputTokens?: number;
}

/** Represents a response containing output messages from an agent. */
export interface OutputResponse {
  /** The output messages produced by the agent. */
  messages: ResponseMessagesParam;
}

// ---------------------------------------------------------------------------
// Span details
// ---------------------------------------------------------------------------

/** Parent context — either an OTel Context or a manual ParentSpanRef. */
export type ParentContext = Context | ParentSpanRef;

/** Manual parent span reference for cross-async-boundary tracing. */
export interface ParentSpanRef {
  /** Trace identifier of the parent span. */
  traceId: string;
  /** Span identifier of the parent span. */
  spanId: string;
  /** Trace flags (e.g. sampled bit) of the parent span. */
  traceFlags?: number;
  /** W3C trace state carried from the parent span. */
  traceState?: TraceState;
  /** Whether the parent span originated on a remote system. */
  isRemote?: boolean;
}

/**
 * Span configuration details for scope creation.
 */
export interface SpanDetails {
  /** Parent context the span should be created under. */
  parentContext?: ParentContext;
  /** Explicit start time for the span. */
  startTime?: TimeInput;
  /** Explicit end time for the span. */
  endTime?: TimeInput;
  /** Kind of span to create (e.g. client, server). */
  spanKind?: SpanKind;
  /** Links to other spans related to this span. */
  spanLinks?: Link[];
}

// ---------------------------------------------------------------------------
// Guardrail / Security Contracts
// ---------------------------------------------------------------------------

/**
 * The decision made by a security guardian during guardrail evaluation.
 */
export enum GuardrailDecisionType {
  /** Content or action is allowed to proceed. */
  Allow = "allow",

  /** Content or action is logged for review but allowed to proceed. */
  Audit = "audit",

  /** Content or action is denied/blocked. */
  Deny = "deny",

  /** Content was modified (e.g., redacted, sanitized, rewritten). */
  Modify = "modify",

  /** Content or action triggered a warning but is allowed to proceed. */
  Warn = "warn",
}

/**
 * Well-known severity levels for security risks detected by guardrails.
 */
export const GuardrailRiskSeverity = {
  /** No risk detected. */
  None: "none",
  /** Low-severity risk. */
  Low: "low",
  /** Medium-severity risk. */
  Medium: "medium",
  /** High-severity risk. */
  High: "high",
  /** Critical-severity risk. */
  Critical: "critical",
} as const;

/**
 * Well-known values for the type of content or action a guardrail is applied to.
 * Custom strings are also accepted.
 */
export const GuardrailTargetType = {
  /** Input sent to an LLM. */
  LlmInput: "llm_input",
  /** Output produced by an LLM. */
  LlmOutput: "llm_output",
  /** A tool invocation. */
  ToolCall: "tool_call",
  /** A tool definition. */
  ToolDefinition: "tool_definition",
  /** A write to a memory store. */
  MemoryStore: "memory_store",
  /** A read from a memory store. */
  MemoryRetrieve: "memory_retrieve",
  /** A query against a knowledge source. */
  KnowledgeQuery: "knowledge_query",
  /** A result returned from a knowledge source. */
  KnowledgeResult: "knowledge_result",
  /** A generic message. */
  Message: "message",
} as const;

/**
 * Details of a guardrail evaluation for security operations tracing.
 */
export interface GuardrailDetails {
  /** The type of content or action the guardrail is applied to (required). */
  targetType: string;

  /** The decision made by the guardian (required). */
  decisionType: GuardrailDecisionType;

  /** Human-readable name of the guardian. */
  guardianName?: string;

  /** Unique identifier of the guardian. */
  guardianId?: string;

  /** Provider of the guardian service (e.g., azure.ai.content_safety). */
  guardianProviderName?: string;

  /** Version of the guardian. */
  guardianVersion?: string;

  /** Identifier of the target being guarded. */
  targetId?: string;

  /** Human-readable explanation for the decision. */
  decisionReason?: string;

  /** Machine-readable decision code. */
  decisionCode?: string;

  /** Identifier of the policy that triggered the decision. */
  policyId?: string;

  /** Human-readable name of the policy. */
  policyName?: string;

  /** Version of the policy. */
  policyVersion?: string;

  /** Hash of the input content for forensic correlation. */
  contentInputHash?: string;

  /** Whether content was modified by the guardrail. */
  contentModified?: boolean;

  /** External correlation identifier for SIEM systems. */
  externalEventId?: string;
}

/**
 * Represents a single security finding detected during guardian evaluation.
 * Multiple findings may be emitted for a single guardrail span.
 */
export interface GuardrailFinding {
  /** The category of security risk detected (required). */
  riskCategory: string;

  /** The severity level of the detected risk (required). */
  riskSeverity: string;

  /** The decision type for this specific policy finding. */
  policyDecisionType?: string;

  /** Identifier of the policy that triggered the finding. */
  policyId?: string;

  /** Human-readable name of the triggered policy. */
  policyName?: string;

  /** Version of the policy. */
  policyVersion?: string;

  /** Numeric risk/confidence score (0.0 to 1.0). */
  riskScore?: number;

  /**
   * Non-content metadata about the detected risk (MUST NOT contain PII).
   * Example values: "field:bcc", "pattern:ssn", "count:3".
   */
  riskMetadata?: string[];
}
