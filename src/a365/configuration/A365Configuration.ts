// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { A365Options, ClusterCategory } from "./A365ConfigurationOptions.js";
import { getA365Logger } from "../logging.js";

/**
 * Parse an environment variable as a boolean.
 * Recognizes 'true', '1', 'yes', 'on' (case-insensitive) as true and
 * 'false', '0', 'no', 'off' as false. Unset, empty, or unrecognized values
 * are ignored and return undefined so they do not override an existing
 * configuration value.
 */
function parseEnvBoolean(envValue: string | undefined): boolean | undefined {
  if (!envValue) return undefined;
  const normalized = envValue.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

/**
 * Environment variable names for A365 configuration.
 * These match the upstream Agent365-nodejs conventions.
 */
export const A365_ENV_VARS = {
  EXPORTER_ENABLED: "ENABLE_A365_OBSERVABILITY_EXPORTER",
  AUTH_SCOPES: "A365_OBSERVABILITY_SCOPES_OVERRIDE",
  DOMAIN: "A365_OBSERVABILITY_DOMAIN_OVERRIDE",
  CLUSTER_CATEGORY: "CLUSTER_CATEGORY",
  LOG_LEVEL: "A365_OBSERVABILITY_LOG_LEVEL",
} as const;

const DEFAULT_AUTH_SCOPE = "api://9b975845-388f-4429-889e-eab1ef63949c/.default";

const VALID_CLUSTER_CATEGORIES: ReadonlySet<string> = new Set([
  "local",
  "dev",
  "test",
  "preprod",
  "firstrelease",
  "prod",
  "gov",
  "high",
  "dod",
  "mooncake",
  "ex",
  "rx",
]);

/**
 * Resolved A365 configuration.
 *
 * Merges values from three sources (lowest to highest precedence):
 *   1. Defaults
 *   2. Programmatic options (`A365Options`)
 *   3. Environment variables (see `A365_ENV_VARS`)
 */
export class A365Configuration {
  /** Whether A365 observability is enabled. */
  public readonly enabled: boolean;

  /** Token resolver callback for A365 service authentication. */
  public readonly tokenResolver?: (
    agentId: string,
    tenantId: string,
    authScopes?: string[],
  ) => string | Promise<string>;

  /** Cluster category. */
  public readonly clusterCategory: ClusterCategory;

  /** Domain override for the A365 observability service. */
  public readonly domainOverride?: string;

  /** OAuth scopes for A365 service authentication. */
  public readonly authScopes: string[];

  /**
   * Whether the A365 HTTP exporter (`Agent365Exporter`) should be added to
   * the pipeline. The `A365SpanProcessor` is still registered when
   * {@link enabled} is `true`, regardless of this flag.
   *
   * Resolved from {@link A365Options.enableObservabilityExporter} (programmatic)
   * or the `ENABLE_A365_OBSERVABILITY_EXPORTER` environment variable; defaults
   * to `false`.
   */
  public readonly enableObservabilityExporter: boolean;

  /**
   * Resolved log level for A365 observability components.
   *
   * `undefined` when neither the `logLevel` option nor the
   * `A365_OBSERVABILITY_LOG_LEVEL` environment variable is set; in that case
   * the A365 logger keeps its default ("none").
   */
  public readonly logLevel?: string;

  /** When true, use the S2S endpoint path for export. */
  public readonly useS2SEndpoint: boolean;

  /** Maximum span queue size before drops occur. */
  public readonly maxQueueSize?: number;

  /** Delay (ms) between automatic batch flush attempts. */
  public readonly scheduledDelayMilliseconds?: number;

  /** Maximum time (ms) for the entire export() call. */
  public readonly exporterTimeoutMilliseconds?: number;

  /** Timeout (ms) per individual HTTP request. */
  public readonly httpRequestTimeoutMilliseconds?: number;

  /** Maximum number of spans per export batch. */
  public readonly maxExportBatchSize?: number;

  /** Maximum estimated payload size (bytes) per HTTP chunk. */
  public readonly maxPayloadBytes?: number;

  constructor(options?: A365Options) {
    // 1. Set defaults
    let enabled = false;
    let enableObservabilityExporter = false;
    let clusterCategory: ClusterCategory = "prod";
    let domainOverride: string | undefined = options?.domainOverride;
    let authScopes: string[] = options?.authScopes ?? [DEFAULT_AUTH_SCOPE];

    // 2. Apply programmatic options
    if (options) {
      enabled = options.enabled ?? enabled;
      enableObservabilityExporter =
        options.enableObservabilityExporter ?? enableObservabilityExporter;
      clusterCategory = options.clusterCategory ?? clusterCategory;
    }

    // 3. Apply environment variable overrides (highest precedence)
    // ENABLE_A365_OBSERVABILITY_EXPORTER controls just the HTTP exporter, not
    // the master `enabled` toggle. It is a secondary toggle that only takes
    // effect when A365 is configured in code (options provided), matching the
    // Python distro behavior (see microsoft/opentelemetry-distro-python#87).
    const envExporter = parseEnvBoolean(process.env[A365_ENV_VARS.EXPORTER_ENABLED]);
    if (
      envExporter !== undefined &&
      options !== undefined &&
      options.enableObservabilityExporter === undefined
    ) {
      enableObservabilityExporter = envExporter;
    }

    const envScopes = process.env[A365_ENV_VARS.AUTH_SCOPES]?.trim();
    if (envScopes) {
      authScopes = envScopes.split(/\s+/).filter(Boolean);
    }

    // observabilityScopeOverride wins over authScopes / env var so callers can
    // narrow the resolved scope set to a single explicit value (mirrors the
    // Python distro's a365_observability_scope_override kwarg).
    const scopeOverride = options?.observabilityScopeOverride?.trim();
    if (scopeOverride) {
      authScopes = [scopeOverride];
    }

    const envDomain = process.env[A365_ENV_VARS.DOMAIN]?.trim();
    if (envDomain) {
      domainOverride = envDomain.replace(/\/+$/, "");
    }

    const envCluster = process.env[A365_ENV_VARS.CLUSTER_CATEGORY]?.toLowerCase();
    if (envCluster && VALID_CLUSTER_CATEGORIES.has(envCluster)) {
      clusterCategory = envCluster as ClusterCategory;
    } else if (envCluster) {
      getA365Logger().warn(
        `Invalid ${A365_ENV_VARS.CLUSTER_CATEGORY} value '${envCluster}'. Using default cluster category.`,
      );
    }

    // Log level: programmatic option wins over the env var so callers can
    // explicitly opt out of (or override) host-level configuration. The
    // default ("none") is applied inside the A365 logger module when no
    // value is supplied here, so leave `logLevel` undefined in that case.
    let logLevel: string | undefined = options?.logLevel?.trim() || undefined;
    if (logLevel === undefined) {
      const envLogLevel = process.env[A365_ENV_VARS.LOG_LEVEL]?.trim();
      if (envLogLevel) {
        logLevel = envLogLevel;
      }
    }

    // Assign resolved values
    this.enabled = enabled;
    this.enableObservabilityExporter = enableObservabilityExporter;
    this.tokenResolver = options?.tokenResolver;
    this.clusterCategory = clusterCategory;
    this.domainOverride = domainOverride;
    this.authScopes = authScopes;
    this.logLevel = logLevel;
    this.useS2SEndpoint = options?.useS2SEndpoint ?? false;
    this.maxQueueSize = options?.maxQueueSize;
    this.scheduledDelayMilliseconds = options?.scheduledDelayMilliseconds;
    this.exporterTimeoutMilliseconds = options?.exporterTimeoutMilliseconds;
    this.httpRequestTimeoutMilliseconds = options?.httpRequestTimeoutMilliseconds;
    this.maxExportBatchSize = options?.maxExportBatchSize;
    this.maxPayloadBytes = options?.maxPayloadBytes;

    // Warn when A365-scoped options are set but A365 is not enabled
    if (!this.enabled) {
      this._warnIfOptionsSetButDisabled(options);
    }
  }

  private _warnIfOptionsSetButDisabled(options?: A365Options): void {
    if (!options) return;

    const hasNonTrivialOptions =
      options.tokenResolver !== undefined || options.domainOverride !== undefined;

    if (hasNonTrivialOptions) {
      getA365Logger().warn(
        "A365 configuration options are set but A365 is not enabled. " +
          "Set `a365.enabled: true` or set `ENABLE_A365_OBSERVABILITY_EXPORTER=true` " +
          "(the env var only takes effect when a365 options are provided in code).",
      );
    }
  }
}
