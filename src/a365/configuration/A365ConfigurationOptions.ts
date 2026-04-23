// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Agent365ExporterOptions } from "../exporter/Agent365ExporterOptions.js";
import type { ILogger } from "../logging.js";

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

  /** Optional OTel service.namespace override applied when A365 is enabled. */
  serviceNamespace?: string;

  /**
   * Use per-request export mode (buffer spans per trace, export on root completion).
   * When false, uses standard batch export.
   * @default false
   */
  perRequestExport?: boolean;

  /** Exporter tuning options (queue sizes, timeouts, batch sizing, endpoint shape). */
  exporterOptions?: Partial<
    Pick<
      Agent365ExporterOptions,
      | "useS2SEndpoint"
      | "maxQueueSize"
      | "scheduledDelayMilliseconds"
      | "exporterTimeoutMilliseconds"
      | "httpRequestTimeoutMilliseconds"
      | "maxExportBatchSize"
    >
  >;

  /** A365 internal logger filter level (none|info|warn|error, pipe-delimited). */
  observabilityLogLevel?: string;

  /** Optional custom logger used by A365 internals. */
  logger?: ILogger;

  /** Baggage propagation and span enrichment options. */
  baggage?: A365BaggageOptions;

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

/** Hosting middleware options. */
export interface A365HostingOptions {
  /**
   * Enable hosting middleware integration (baggage middleware, output logging, etc.).
   * Requires `@microsoft/agents-hosting` as an optional peer dependency.
   */
  enabled?: boolean;
}
