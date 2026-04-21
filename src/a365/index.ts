// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { A365Configuration, A365_ENV_VARS } from "./configuration/index.js";
export type {
  A365Options,
  ClusterCategory,
  A365BaggageOptions,
  A365HostingOptions,
} from "./configuration/index.js";

export { Agent365Exporter } from "./exporter/index.js";
export type { Agent365ExporterOptions, TokenResolver } from "./exporter/index.js";
export { ResolvedExporterOptions } from "./exporter/index.js";

// ── Scopes (manual telemetry API) ───────────────────────────────────────────
export {
  OpenTelemetryScope,
  InvokeAgentScope,
  ExecuteToolScope,
  InferenceScope,
  OutputScope,
} from "./scopes/index.js";

// ── Constants ───────────────────────────────────────────────────────────────
export { OpenTelemetryConstants } from "./constants.js";

// ── Contracts (types & enums) ───────────────────────────────────────────────
export {
  MessageRole,
  FinishReason,
  Modality,
  InvocationRole,
  InferenceOperationType,
  A365_MESSAGE_SCHEMA_VERSION,
} from "./contracts.js";
export type {
  ChatMessage,
  InputMessages,
  OutputMessage,
  OutputMessages,
  InputMessagesParam,
  OutputMessagesParam,
  ResponseMessagesParam,
  MessagePart,
  TextPart,
  ToolCallRequestPart,
  ToolCallResponsePart,
  ReasoningPart,
  AgentDetails,
  UserDetails,
  CallerDetails,
  Request,
  Channel,
  ServiceEndpoint,
  InvokeAgentScopeDetails,
  ToolCallDetails,
  InferenceDetails,
  InferenceResponse,
  OutputResponse,
  SpanDetails,
  ParentSpanRef,
  ParentContext,
} from "./contracts.js";

// ── Context propagation ─────────────────────────────────────────────────────
export {
  isParentSpanRef,
  createContextWithParentSpanRef,
  runWithParentSpanRef,
  injectContextToHeaders,
  extractContextFromHeaders,
  runWithExtractedTraceContext,
} from "./context.js";
export type { HeadersCarrier } from "./context.js";

// ── Middleware (BaggageBuilder) ──────────────────────────────────────────────
export { BaggageBuilder, BaggageScope } from "./middleware/index.js";

// ── Processors ──────────────────────────────────────────────────────────────
export {
  A365SpanProcessor,
  PerRequestSpanProcessor,
  GENERIC_ATTRIBUTES,
  INVOKE_AGENT_ATTRIBUTES,
} from "./processors/index.js";
export type { PerRequestSpanProcessorOptions } from "./processors/index.js";

// ── Token context ───────────────────────────────────────────────────────────
export { runWithExportToken, updateExportToken, getExportToken } from "./context/tokenContext.js";
