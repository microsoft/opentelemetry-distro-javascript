// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AzureMonitorOpenTelemetryOptions, MicrosoftOpenTelemetryOptions } from "./types.js";
import { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } from "./distro/distro.js";

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

// ── Re-exports from @microsoft/agents-a365-observability ────────────────────
export {
  // Scopes (manual telemetry API)
  OpenTelemetryScope,
  InvokeAgentScope,
  ExecuteToolScope,
  InferenceScope,
  OutputScope,
  // Constants
  OpenTelemetryConstants,
  // Enums
  MessageRole,
  FinishReason,
  InferenceOperationType,
  // Context propagation
  runWithParentSpanRef,
  createContextWithParentSpanRef,
  injectContextToHeaders,
  extractContextFromHeaders,
  runWithExtractedTraceContext,
  // Baggage
  BaggageBuilder,
  BaggageScope,
  // Token context
  runWithExportToken,
  updateExportToken,
  getExportToken,
  // Message utilities
  serializeMessages,
  normalizeInputMessages,
  normalizeOutputMessages,
  safeSerializeToJson,
  // Exporter utilities
  isPerRequestExportEnabled,
  MAX_SPAN_SIZE_BYTES,
  // Builder / Manager
  ObservabilityManager,
} from "@microsoft/agents-a365-observability";
export { Builder as ObservabilityBuilder } from "@microsoft/agents-a365-observability";
export type { BuilderOptions as ObservabilityBuilderOptions } from "@microsoft/agents-a365-observability";
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
  HeadersCarrier,
  Agent365ExporterOptions,
} from "@microsoft/agents-a365-observability";
export type { ILogger as A365Logger } from "@microsoft/agents-a365-observability";

// ── Re-exports from @microsoft/agents-a365-runtime ──────────────────────────
export { ClusterCategory } from "@microsoft/agents-a365-runtime";

// ── Re-exports from types ───────────────────────────────────────────────────
export type { OpenAIAgentsInstrumentationConfig, LangChainInstrumentationConfig } from "./types.js";

// ── Azure Monitor backward-compatible API ───────────────────────────────────

/**
 * Initialize Azure Monitor Distro
 * @param options - Microsoft OpenTelemetry Options
 * @deprecated Use {@link useMicrosoftOpenTelemetry} instead.
 */
export function useAzureMonitor(options?: MicrosoftOpenTelemetryOptions): void {
  useMicrosoftOpenTelemetry(options);
}

/**
 * Shutdown Azure Monitor Open Telemetry Distro
 * @deprecated Use {@link shutdownMicrosoftOpenTelemetry} instead.
 */
export function shutdownAzureMonitor(): Promise<void> {
  return shutdownMicrosoftOpenTelemetry();
}
