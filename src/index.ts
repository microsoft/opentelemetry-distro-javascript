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
  InferenceOperationType,
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
  HeadersCarrier,
} from "./a365/index.js";
export type { PerRequestSpanProcessorOptions } from "./a365/index.js";

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
