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
// Message schema version
// ---------------------------------------------------------------------------

export const A365_MESSAGE_SCHEMA_VERSION = "0.1.0" as const;

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

/** Versioned wrapper for input messages. */
export interface InputMessages {
  version: typeof A365_MESSAGE_SCHEMA_VERSION;
  messages: ChatMessage[];
}

/** An output message produced by a model (OTEL gen-ai semantic conventions). */
export interface OutputMessage extends ChatMessage {
  finish_reason?: FinishReason | string;
}

/** Versioned wrapper for output messages. */
export interface OutputMessages {
  version: typeof A365_MESSAGE_SCHEMA_VERSION;
  messages: OutputMessage[];
}

/** Accepted input for `recordInputMessages`. */
export type InputMessagesParam = string | string[] | InputMessages;

/** Accepted input for `recordOutputMessages`. */
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
