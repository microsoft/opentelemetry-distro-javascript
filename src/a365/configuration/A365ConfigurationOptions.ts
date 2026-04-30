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
   * Called with (agentId, tenantId, authScopes) extracted from span attributes/config.
   * Must return a bearer token string or a promise resolving to one.
   */
  tokenResolver?: (
    agentId: string,
    tenantId: string,
    authScopes?: string[],
  ) => string | Promise<string>;

  /** Cluster category for the A365 service endpoint. */
  clusterCategory?: ClusterCategory;

  /** Override the A365 observability service domain. */
  domainOverride?: string;

  /** OAuth scopes for A365 service authentication. */
  authScopes?: string[];

  /**
   * Single-string override for the A365 observability authentication scope.
   *
   * Equivalent to the `A365_OBSERVABILITY_SCOPES_OVERRIDE` environment
   * variable; when supplied, it becomes the sole entry of the resolved
   * {@link authScopes} array. Mirrors the Python distro's
   * `a365_observability_scope_override` kwarg
   * (microsoft/opentelemetry-distro-python#87).
   *
   * Precedence (highest to lowest): this option > env var > {@link authScopes}.
   */
  observabilityScopeOverride?: string;

  /**
   * Enable the A365 HTTP observability exporter (`Agent365Exporter`).
   *
   * Defaults to `false`. When `false` (and {@link enabled} is `true`), the
   * `A365SpanProcessor` is still registered for baggage/attribute enrichment
   * of downstream exporters (Azure Monitor, OTLP, console, …) but no data is
   * sent to the A365 observability service.
   *
   * Equivalent to the `ENABLE_A365_OBSERVABILITY_EXPORTER` environment
   * variable. The programmatic value wins when both are set.
   *
   * Has no effect when {@link enabled} is `false`.
   */
  enableObservabilityExporter?: boolean;

  /**
   * Log level for A365 observability components.
   *
   * Accepts `none`, `info`, `warn`, `error`, or a `|`-separated combination
   * (e.g. `"warn|error"`). Defaults to `none` when neither this option nor
   * the `A365_OBSERVABILITY_LOG_LEVEL` environment variable is set. When set,
   * this option overrides the environment variable.
   */
  logLevel?: string;

  /** When true, use the S2S endpoint path for export. @default false */
  useS2SEndpoint?: boolean;

  /** Maximum span queue size before drops occur. */
  maxQueueSize?: number;

  /** Delay (ms) between automatic batch flush attempts. */
  scheduledDelayMilliseconds?: number;

  /** Maximum time (ms) for the entire export() call. */
  exporterTimeoutMilliseconds?: number;

  /** Timeout (ms) per individual HTTP request. Each retry gets a fresh timeout. */
  httpRequestTimeoutMilliseconds?: number;

  /** Maximum number of spans per export batch. */
  maxExportBatchSize?: number;

  /** Maximum estimated payload size (bytes) per HTTP chunk. */
  maxPayloadBytes?: number;
}
