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
  SYSTEM = "system",
  USER = "user",
  ASSISTANT = "assistant",
  TOOL = "tool",
}

/** Reason a model stopped generating per OTEL gen-ai semantic conventions. */
export enum FinishReason {
  STOP = "stop",
  LENGTH = "length",
  CONTENT_FILTER = "content_filter",
  TOOL_CALL = "tool_call",
  ERROR = "error",
}

/** Media modality for blob, file, and URI parts. */
export enum Modality {
  IMAGE = "image",
  VIDEO = "video",
  AUDIO = "audio",
}

/** Represents different roles that can invoke an agent. */
export enum InvocationRole {
  Human = "Human",
  Agent = "Agent",
  Event = "Event",
  Unknown = "Unknown",
}

/** Represents different operation types for model inference. */
export enum InferenceOperationType {
  CHAT = "Chat",
  TEXT_COMPLETION = "TextCompletion",
  GENERATE_CONTENT = "GenerateContent",
}

// ---------------------------------------------------------------------------
// Message parts (discriminated union on `type`)
// ---------------------------------------------------------------------------

/** Plain text content. */
export interface TextPart {
  type: "text";
  content: string;
}

/** A tool call requested by the model. */
export interface ToolCallRequestPart {
  type: "tool_call";
  name: string;
  id?: string;
  arguments?: Record<string, unknown> | unknown[];
}

/** Result of a tool call. */
export interface ToolCallResponsePart {
  type: "tool_call_response";
  id?: string;
  response?: unknown;
}

/** Model reasoning / chain-of-thought content. */
export interface ReasoningPart {
  type: "reasoning";
  content: string;
}

/** Inline binary data (base64-encoded). */
export interface BlobPart {
  type: "blob";
  modality: Modality | string;
  mime_type?: string;
  content: string;
}

/** Reference to a pre-uploaded file. */
export interface FilePart {
  type: "file";
  modality: Modality | string;
  mime_type?: string;
  file_id: string;
}

/** External URI reference. */
export interface UriPart {
  type: "uri";
  modality: Modality | string;
  mime_type?: string;
  uri: string;
}

/** Extensible server tool call details. */
export interface GenericServerToolCall {
  type: string;
  [key: string]: unknown;
}

/** Extensible server tool call response. */
export interface GenericServerToolCallResponse {
  type: string;
  [key: string]: unknown;
}

/** Server-side tool invocation. */
export interface ServerToolCallPart {
  type: "server_tool_call";
  name: string;
  id?: string;
  server_tool_call: GenericServerToolCall;
}

/** Server-side tool response. */
export interface ServerToolCallResponsePart {
  type: "server_tool_call_response";
  id?: string;
  server_tool_call_response: GenericServerToolCallResponse;
}

/** Extensible part for custom / future types. */
export interface GenericPart {
  type: string;
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
  role: MessageRole | string;
  parts: MessagePart[];
  name?: string;
}

export interface InputMessages {
  messages: ChatMessage[];
}

/**
 * An output message produced by a model (OTEL gen-ai semantic conventions).
 * `finish_reason` defaults to `"stop"` per OTel spec when not provided.
 */
export interface OutputMessage extends ChatMessage {
  finish_reason?: FinishReason | string;
}

export interface OutputMessages {
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
  id?: string;
  name?: string;
  iconUri?: string;
  role?: InvocationRole;
  description?: string;
}

/** Represents a request with telemetry context. */
export interface Request {
  content?: InputMessagesParam;
  sessionId?: string;
  channel?: Channel;
  conversationId?: string;
}

// ---------------------------------------------------------------------------
// Agent, User, Caller details
// ---------------------------------------------------------------------------

/** Details about an AI agent. */
export interface AgentDetails {
  agentId: string;
  agentName?: string;
  agentDescription?: string;
  iconUri?: string;
  platformId?: string;
  agentAUID?: string;
  agentEmail?: string;
  agentBlueprintId?: string;
  tenantId?: string;
  providerName?: string;
  agentVersion?: string;
}

/** Details about the human user caller. */
export interface UserDetails {
  userId?: string;
  userEmail?: string;
  userName?: string;
  tenantId?: string;
  callerClientIp?: string;
}

/**
 * Caller details for scope creation.
 * Supports human callers, agent callers, or both (A2A with a human in the chain).
 */
export interface CallerDetails {
  userDetails?: UserDetails;
  callerAgentDetails?: AgentDetails;
}

// ---------------------------------------------------------------------------
// Service endpoint
// ---------------------------------------------------------------------------

/** Represents an endpoint for agent invocation. */
export interface ServiceEndpoint {
  host: string;
  port?: number;
  protocol?: string;
}

// ---------------------------------------------------------------------------
// Scope detail types
// ---------------------------------------------------------------------------

/** Details for invoking agent scope. */
export interface InvokeAgentScopeDetails {
  endpoint?: ServiceEndpoint;
}

/** Details of a tool call made by an agent. */
export interface ToolCallDetails {
  toolName: string;
  arguments?: Record<string, unknown> | string;
  toolCallId?: string;
  description?: string;
  toolType?: string;
  endpoint?: ServiceEndpoint;
}

/** Details for an inference call. */
export interface InferenceDetails {
  operationName: InferenceOperationType;
  model: string;
  providerName?: string;
  inputTokens?: number;
  outputTokens?: number;
  finishReasons?: string[];
  thoughtProcess?: string;
  endpoint?: ServiceEndpoint;
}

/** Details for recording the response from an inference call. */
export interface InferenceResponse {
  content: string;
  responseId?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Represents a response containing output messages from an agent. */
export interface OutputResponse {
  messages: ResponseMessagesParam;
}

// ---------------------------------------------------------------------------
// Span details
// ---------------------------------------------------------------------------

/** Parent context — either an OTel Context or a manual ParentSpanRef. */
export type ParentContext = Context | ParentSpanRef;

/** Manual parent span reference for cross-async-boundary tracing. */
export interface ParentSpanRef {
  traceId: string;
  spanId: string;
  traceFlags?: number;
  traceState?: TraceState;
  isRemote?: boolean;
}

/**
 * Span configuration details for scope creation.
 */
export interface SpanDetails {
  parentContext?: ParentContext;
  startTime?: TimeInput;
  endTime?: TimeInput;
  spanKind?: SpanKind;
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
  None: "none",
  Low: "low",
  Medium: "medium",
  High: "high",
  Critical: "critical",
} as const;

/**
 * Well-known values for the type of content or action a guardrail is applied to.
 * Custom strings are also accepted.
 */
export const GuardrailTargetType = {
  LlmInput: "llm_input",
  LlmOutput: "llm_output",
  ToolCall: "tool_call",
  ToolDefinition: "tool_definition",
  MemoryStore: "memory_store",
  MemoryRetrieve: "memory_retrieve",
  KnowledgeQuery: "knowledge_query",
  KnowledgeResult: "knowledge_result",
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
