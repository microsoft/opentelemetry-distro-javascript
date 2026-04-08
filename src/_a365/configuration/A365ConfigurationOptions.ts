// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Cluster categories for A365 service endpoint resolution.
 * Mirrors the ClusterCategory enum from Agent365-nodejs.
 */
export type ClusterCategory =
  | "local"
  | "dev"
  | "test"
  | "preprod"
  | "firstrelease"
  | "prod"
  | "gov"
  | "high"
  | "dod"
  | "mooncake"
  | "ex"
  | "rx";

/**
 * A365 observability configuration options.
 *
 * These are the public-facing options passed via the `a365` scope
 * of {@link MicrosoftOpenTelemetryOptions}.
 */
export interface A365Options {
  /** Enable A365 observability. When false, no A365 components are created. */
  enabled?: boolean;

  /**
   * Token resolver for authenticating with the A365 observability service.
   * Called with (agentId, tenantId) extracted from span attributes.
   * Must return a bearer token string or a promise resolving to one.
   */
  tokenResolver?: (agentId: string, tenantId: string) => string | Promise<string>;

  /** Cluster category for the A365 service endpoint. */
  clusterCategory?: ClusterCategory;

  /** Override the A365 observability service domain. */
  domainOverride?: string;

  /** OAuth scopes for A365 service authentication. */
  authScopes?: string[];

  /**
   * Use per-request export mode (buffer spans per trace, export on root completion).
   * When false, uses standard batch export.
   * @default false
   */
  perRequestExport?: boolean;

  /** Baggage propagation and span enrichment options. */
  baggage?: A365BaggageOptions;

  /** GenAI and agent framework instrumentation toggles. */
  instrumentations?: A365InstrumentationOptions;

  /** Hosting middleware options (requires @microsoft/agents-hosting). */
  hosting?: A365HostingOptions;
}

/** Baggage propagation and span enrichment options. */
export interface A365BaggageOptions {
  /** Enable baggage propagation from request headers to span context. */
  propagationEnabled?: boolean;
  /** Copy baggage items to span attributes. */
  enrichSpans?: boolean;
}

/** A365 instrumentation toggles for GenAI and agent frameworks. */
export interface A365InstrumentationOptions {
  /**
   * Enable OpenAI Agents SDK instrumentation.
   * Pass `true` for defaults or a configuration object.
   * Requires `@openai/agents` as an optional peer dependency.
   */
  openaiAgents?: boolean | OpenAIAgentsInstrumentationConfig;

  /**
   * Enable LangChain instrumentation.
   * Pass `true` for defaults or a configuration object.
   * Requires `@langchain/core` as an optional peer dependency.
   */
  langchain?: boolean | LangChainInstrumentationConfig;

  /**
   * Enable Microsoft Agent Framework instrumentation.
   * Requires `@microsoft/agents-hosting` as an optional peer dependency.
   */
  microsoftAgentFramework?: boolean;
}

/** Configuration for OpenAI Agents SDK instrumentation. */
export interface OpenAIAgentsInstrumentationConfig {
  /** Custom tracer name. */
  tracerName?: string;
  /** Custom tracer version. */
  tracerVersion?: string;
  /**
   * When true, the gen_ai.input.messages attribute will be suppressed
   * on InvokeAgent scope spans.
   * @default false
   */
  suppressInvokeAgentInput?: boolean;
  /**
   * Enable recording of message content (input/output messages, tool args, etc.) in spans.
   * @default false
   */
  isContentRecordingEnabled?: boolean;
}

/** Configuration for LangChain instrumentation. */
export interface LangChainInstrumentationConfig {
  /** Enable recording of message content in spans. */
  isContentRecordingEnabled?: boolean;
}

/** Hosting middleware options. */
export interface A365HostingOptions {
  /**
   * Enable hosting middleware integration (baggage middleware, output logging, etc.).
   * Requires `@microsoft/agents-hosting` as an optional peer dependency.
   */
  enabled?: boolean;
}
