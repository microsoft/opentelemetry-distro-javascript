// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ClusterCategory } from "../configuration/A365ConfigurationOptions.js";

/**
 * A function that resolves an authentication token for the given agent and tenant.
 * Return null if a token cannot be provided.
 */
export type TokenResolver = (
  agentId: string,
  tenantId: string,
  authScopes?: string[],
) => string | null | Promise<string | null>;

/**
 * Options controlling the behavior of the Agent365 span exporter.
 */
export interface Agent365ExporterOptions {
  /** Cluster category for endpoint resolution. @default "prod" */
  clusterCategory?: ClusterCategory;

  /** Token resolver for authentication. Required for batch export. */
  tokenResolver?: TokenResolver;

  /** When true, use the S2S endpoint path (/observabilityService/...). @default false */
  useS2SEndpoint?: boolean;

  /** Override the A365 observability service domain. */
  domainOverride?: string;

  /** OAuth scopes used during token resolution. */
  authScopes?: string[];

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
}

/** Resolved options with defaults applied. */
export class ResolvedExporterOptions {
  public readonly clusterCategory: ClusterCategory;
  public readonly tokenResolver?: TokenResolver;
  public readonly useS2SEndpoint: boolean;
  public readonly domainOverride?: string;
  public readonly authScopes: string[];
  public readonly maxQueueSize: number;
  public readonly scheduledDelayMilliseconds: number;
  public readonly exporterTimeoutMilliseconds: number;
  public readonly httpRequestTimeoutMilliseconds: number;
  public readonly maxExportBatchSize: number;

  constructor(options?: Agent365ExporterOptions) {
    this.clusterCategory = options?.clusterCategory ?? "prod";
    this.tokenResolver = options?.tokenResolver;
    this.useS2SEndpoint = options?.useS2SEndpoint ?? false;
    this.domainOverride = options?.domainOverride;
    this.authScopes = options?.authScopes ?? ["https://api.powerplatform.com/.default"];
    this.maxQueueSize = options?.maxQueueSize ?? 2048;
    this.scheduledDelayMilliseconds = options?.scheduledDelayMilliseconds ?? 5000;
    this.exporterTimeoutMilliseconds = options?.exporterTimeoutMilliseconds ?? 90000;
    this.httpRequestTimeoutMilliseconds = options?.httpRequestTimeoutMilliseconds ?? 30000;
    this.maxExportBatchSize = options?.maxExportBatchSize ?? 512;
  }
}
