// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AzureMonitorOpenTelemetryOptions } from "./types.js";

// ── Re-exports from distro ──────────────────────────────────────────────────
export type { AzureMonitorOpenTelemetryOptions };
export {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
  MICROSOFT_OPENTELEMETRY_VERSION,
} from "./distro/index.js";
export type {
  MicrosoftOpenTelemetryOptions,
  InstrumentationOptions,
  BrowserSdkLoaderOptions,
  A365Options,
} from "./distro/index.js";

// ── Re-exports from A365 configuration ──────────────────────────────────────
export { A365Configuration } from "./a365/index.js";
export type { ClusterCategory, A365BaggageOptions, A365HostingOptions } from "./a365/index.js";

// ── Re-exports from A365 scopes (manual telemetry API) ──────────────────────
export {
  OpenTelemetryScope,
  InvokeAgentScope,
  ExecuteToolScope,
  InferenceScope,
  OutputScope,
  OpenTelemetryConstants,
  MessageRole,
  FinishReason,
  Modality,
  InvocationRole,
  InferenceOperationType,
  A365_MESSAGE_SCHEMA_VERSION,
  isParentSpanRef,
  createContextWithParentSpanRef,
  runWithParentSpanRef,
  injectContextToHeaders,
  extractContextFromHeaders,
  runWithExtractedTraceContext,
  BaggageBuilder,
  BaggageScope,
  A365SpanProcessor,
  PerRequestSpanProcessor,
  GENERIC_ATTRIBUTES,
  INVOKE_AGENT_ATTRIBUTES,
  runWithExportToken,
  updateExportToken,
  getExportToken,
} from "./a365/index.js";
export type {
  AgentDetails,
  UserDetails,
  CallerDetails,
  Request as A365Request,
  Channel,
  ServiceEndpoint,
  InvokeAgentScopeDetails,
  ToolCallDetails,
  InferenceDetails,
  InferenceResponse,
  OutputResponse,
  SpanDetails as A365SpanDetails,
  ParentSpanRef,
  ParentContext,
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
  HeadersCarrier,
} from "./a365/index.js";
export type { PerRequestSpanProcessorOptions } from "./a365/index.js";

// ── Re-exports from A365 hosting utilities ──────────────────────────────────
export {
  BaggageBuilderUtils,
  ScopeUtils,
  getCallerBaggagePairs,
  getTargetAgentBaggagePairs,
  getTenantIdPair,
  getChannelBaggagePairs,
  getConversationIdAndItemLinkPairs,
  resolveEmbodiedAgentIds,
  BaggageMiddleware,
  OutputLoggingMiddleware,
  A365_PARENT_SPAN_KEY,
  A365_AUTH_TOKEN_KEY,
  ObservabilityHostingManager,
} from "./a365/index.js";
export type {
  ObservabilityHostingOptions,
  TurnContextLike,
  ActivityLike,
  MiddlewareLike,
  SendActivitiesHandler,
} from "./a365/index.js";

// ── Re-exports from types ───────────────────────────────────────────────────
export type { OpenAIAgentsInstrumentationConfig, LangChainInstrumentationConfig } from "./types.js";
