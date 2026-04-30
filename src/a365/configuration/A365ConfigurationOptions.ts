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

  /** When true, use the S2S endpoint path for export. @default false */
  useS2SEndpoint?: boolean;

  /** Maximum span queue size before drops occur. @default 2048 */
  maxQueueSize?: number;

  /** Delay (ms) between automatic batch flush attempts. @default 5000 */
  scheduledDelayMilliseconds?: number;

  /** Maximum time (ms) for the entire export() call. @default 90000 */
  exporterTimeoutMilliseconds?: number;

  /** Timeout (ms) per individual HTTP request. Each retry gets a fresh timeout. @default 30000 */
  httpRequestTimeoutMilliseconds?: number;

  /** Maximum number of spans per export batch. @default 512 */
  maxExportBatchSize?: number;

  /** Maximum estimated payload size (bytes) per HTTP chunk. @default 900 * 1024 (900KB) */
  maxPayloadBytes?: number;
}
