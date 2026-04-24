// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  A365Options,
  ClusterCategory,
  A365BaggageOptions,
} from "./A365ConfigurationOptions.js";
import { getA365Logger } from "../logging.js";

type InternalPerRequestOptions = {
  enabled: boolean;
  maxTraces: number;
  maxSpansPerTrace: number;
  maxConcurrentExports: number;
  flushGraceMs: number;
  maxTraceAgeMs: number;
};

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

function parsePositiveInt(envValue: string | undefined): number | undefined {
  if (!envValue) return undefined;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * Environment variable names for A365 configuration.
 * These match the upstream Agent365-nodejs conventions.
 */
export const A365_ENV_VARS = {
  EXPORTER_ENABLED: "ENABLE_A365_OBSERVABILITY_EXPORTER",
  PER_REQUEST_EXPORT_ENABLED: "ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT",
  AUTH_SCOPES: "A365_OBSERVABILITY_SCOPES_OVERRIDE",
  DOMAIN: "A365_OBSERVABILITY_DOMAIN_OVERRIDE",
  CLUSTER_CATEGORY: "CLUSTER_CATEGORY",
  LOG_LEVEL: "A365_OBSERVABILITY_LOG_LEVEL",
  PER_REQUEST_MAX_TRACES: "A365_PER_REQUEST_MAX_TRACES",
  PER_REQUEST_MAX_SPANS_PER_TRACE: "A365_PER_REQUEST_MAX_SPANS_PER_TRACE",
  PER_REQUEST_MAX_CONCURRENT_EXPORTS: "A365_PER_REQUEST_MAX_CONCURRENT_EXPORTS",
  PER_REQUEST_FLUSH_GRACE_MS: "A365_PER_REQUEST_FLUSH_GRACE_MS",
  PER_REQUEST_MAX_TRACE_AGE_MS: "A365_PER_REQUEST_MAX_TRACE_AGE_MS",
} as const;

const DEFAULT_AUTH_SCOPE = "https://api.powerplatform.com/.default";
const DEFAULT_PER_REQUEST_MAX_TRACES = 1000;
const DEFAULT_PER_REQUEST_MAX_SPANS_PER_TRACE = 5000;
const DEFAULT_PER_REQUEST_MAX_CONCURRENT_EXPORTS = 20;
const DEFAULT_PER_REQUEST_FLUSH_GRACE_MS = 250;
const DEFAULT_PER_REQUEST_MAX_TRACE_AGE_MS = 30 * 60 * 1000;

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

  /** Baggage options. */
  public readonly baggage: Required<A365BaggageOptions>;

  /** Hosting options. */
  public readonly hosting: {
    enabled: boolean;
    adapter?: { use(...middlewares: unknown[]): void };
    enableOutputLogging: boolean;
  };

  /** Internal per-request export options. */
  private readonly _perRequest: InternalPerRequestOptions;

  constructor(options?: A365Options) {
    // 1. Set defaults
    let enabled = false;
    let clusterCategory: ClusterCategory = "prod";
    let domainOverride: string | undefined = options?.domainOverride;
    let authScopes: string[] = options?.authScopes ?? [DEFAULT_AUTH_SCOPE];
    let perRequestEnabled = false;
    let perRequestMaxTraces = DEFAULT_PER_REQUEST_MAX_TRACES;
    let perRequestMaxSpansPerTrace = DEFAULT_PER_REQUEST_MAX_SPANS_PER_TRACE;
    let perRequestMaxConcurrentExports = DEFAULT_PER_REQUEST_MAX_CONCURRENT_EXPORTS;
    let perRequestFlushGraceMs = DEFAULT_PER_REQUEST_FLUSH_GRACE_MS;
    let perRequestMaxTraceAgeMs = DEFAULT_PER_REQUEST_MAX_TRACE_AGE_MS;

    // 2. Apply programmatic options
    if (options) {
      enabled = options.enabled ?? enabled;
      clusterCategory = options.clusterCategory ?? clusterCategory;
    }

    // 3. Apply environment variable overrides (highest precedence)
    const envEnabled = parseEnvBoolean(process.env[A365_ENV_VARS.EXPORTER_ENABLED]);
    if (envEnabled !== undefined) {
      enabled = envEnabled;
    }

    const envPerRequestEnabled = parseEnvBoolean(
      process.env[A365_ENV_VARS.PER_REQUEST_EXPORT_ENABLED],
    );
    if (envPerRequestEnabled !== undefined) {
      perRequestEnabled = envPerRequestEnabled;
    }

    const envScopes = process.env[A365_ENV_VARS.AUTH_SCOPES]?.trim();
    if (envScopes) {
      authScopes = envScopes.split(/\s+/).filter(Boolean);
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

    perRequestMaxTraces =
      parsePositiveInt(process.env[A365_ENV_VARS.PER_REQUEST_MAX_TRACES]) ?? perRequestMaxTraces;
    perRequestMaxSpansPerTrace =
      parsePositiveInt(process.env[A365_ENV_VARS.PER_REQUEST_MAX_SPANS_PER_TRACE]) ??
      perRequestMaxSpansPerTrace;
    perRequestMaxConcurrentExports =
      parsePositiveInt(process.env[A365_ENV_VARS.PER_REQUEST_MAX_CONCURRENT_EXPORTS]) ??
      perRequestMaxConcurrentExports;
    perRequestFlushGraceMs =
      parsePositiveInt(process.env[A365_ENV_VARS.PER_REQUEST_FLUSH_GRACE_MS]) ??
      perRequestFlushGraceMs;
    perRequestMaxTraceAgeMs =
      parsePositiveInt(process.env[A365_ENV_VARS.PER_REQUEST_MAX_TRACE_AGE_MS]) ??
      perRequestMaxTraceAgeMs;

    // Assign resolved values
    this.enabled = enabled;
    this.tokenResolver = options?.tokenResolver;
    this.clusterCategory = clusterCategory;
    this.domainOverride = domainOverride;
    this.authScopes = authScopes;

    this.baggage = {
      propagationEnabled: options?.baggage?.propagationEnabled ?? true,
      enrichSpans: options?.baggage?.enrichSpans ?? true,
    };

    this.hosting = {
      enabled: options?.hosting?.enabled ?? false,
      adapter: options?.hosting?.adapter,
      enableOutputLogging: options?.hosting?.enableOutputLogging ?? true,
    };

    this._perRequest = {
      enabled: perRequestEnabled,
      maxTraces: perRequestMaxTraces,
      maxSpansPerTrace: perRequestMaxSpansPerTrace,
      maxConcurrentExports: perRequestMaxConcurrentExports,
      flushGraceMs: perRequestFlushGraceMs,
      maxTraceAgeMs: perRequestMaxTraceAgeMs,
    };

    // Warn when A365-scoped options are set but A365 is not enabled
    if (!this.enabled) {
      this._warnIfOptionsSetButDisabled(options);
    }
  }

  private _warnIfOptionsSetButDisabled(options?: A365Options): void {
    if (!options) return;

    const hasNonTrivialOptions =
      options.tokenResolver !== undefined ||
      options.domainOverride !== undefined ||
      options.hosting?.enabled === true;

    if (hasNonTrivialOptions) {
      getA365Logger().warn(
        "A365 configuration options are set but A365 is not enabled. " +
          "Set `a365.enabled: true` or `ENABLE_A365_OBSERVABILITY_EXPORTER=true` to enable.",
      );
    }
  }

  /** @internal Internal-only toggle for partner-specific per-request export behavior. */
  public isPerRequestExportEnabled(): boolean {
    return this._perRequest.enabled;
  }

  /** @internal Internal-only per-request processor guardrails. */
  public getPerRequestOptions(): InternalPerRequestOptions {
    return this._perRequest;
  }
}
