// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  A365Options,
  ClusterCategory,
  A365BaggageOptions,
  A365HostingOptions,
} from "./A365ConfigurationOptions.js";
import { getEnv } from "../utils/utils.js";
import { Logger } from "../../shared/logging/index.js";
import { JsonConfig } from "../../shared/jsonConfig.js";

/**
 * Environment variable names for A365 configuration.
 * These follow the MICROSOFT_OTEL_A365_* convention defined in PLANNING.md.
 */
export const A365_ENV_VARS = {
  EXPORTER_ENABLED: "MICROSOFT_OTEL_A365_EXPORTER_ENABLED",
  PER_REQUEST_EXPORT: "MICROSOFT_OTEL_A365_PER_REQUEST_EXPORT",
  AUTH_SCOPES: "MICROSOFT_OTEL_A365_AUTH_SCOPES",
  DOMAIN: "MICROSOFT_OTEL_A365_DOMAIN",
  CLUSTER_CATEGORY: "MICROSOFT_OTEL_A365_CLUSTER_CATEGORY",
} as const;

const DEFAULT_AUTH_SCOPE = "https://api.powerplatform.com/.default";

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
 * Merges values from four sources (lowest to highest precedence):
 *   1. Defaults
 *   2. Programmatic options (`A365Options`)
 *   3. JSON config (`applicationinsights.json` → `a365` key)
 *   4. Environment variables (`MICROSOFT_OTEL_A365_*`)
 */
export class A365Configuration {
  /** Whether A365 observability is enabled. */
  public readonly enabled: boolean;

  /** Token resolver callback for A365 service authentication. */
  public readonly tokenResolver?: (agentId: string, tenantId: string) => string | Promise<string>;

  /** Cluster category. */
  public readonly clusterCategory: ClusterCategory;

  /** Domain override for the A365 observability service. */
  public readonly domainOverride?: string;

  /** OAuth scopes for A365 service authentication. */
  public readonly authScopes: string[];

  /** Whether to use per-request export mode. */
  public readonly perRequestExport: boolean;

  /** Baggage options. */
  public readonly baggage: Required<A365BaggageOptions>;

  /** Hosting options. */
  public readonly hosting: Required<A365HostingOptions>;

  constructor(options?: A365Options) {
    // 1. Set defaults
    let enabled = false;
    let clusterCategory: ClusterCategory = "prod";
    let domainOverride: string | undefined = options?.domainOverride;
    let authScopes: string[] = options?.authScopes ?? [DEFAULT_AUTH_SCOPE];
    let perRequestExport = false;

    // 2. Apply programmatic options
    if (options) {
      enabled = options.enabled ?? enabled;
      clusterCategory = options.clusterCategory ?? clusterCategory;
      perRequestExport = options.perRequestExport ?? perRequestExport;
    }

    // 3. Apply JSON config (takes precedence over programmatic options)
    const jsonA365 = JsonConfig.getInstance().a365;
    if (jsonA365) {
      enabled = jsonA365.enabled ?? enabled;
      clusterCategory = jsonA365.clusterCategory ?? clusterCategory;
      domainOverride = jsonA365.domainOverride ?? domainOverride;
      perRequestExport = jsonA365.perRequestExport ?? perRequestExport;
      if (jsonA365.authScopes) {
        authScopes = jsonA365.authScopes;
      }
    }

    // 4. Apply environment variable overrides (highest precedence)
    if (getEnv(A365_ENV_VARS.EXPORTER_ENABLED) === "true") {
      enabled = true;
    } else if (getEnv(A365_ENV_VARS.EXPORTER_ENABLED) === "false") {
      enabled = false;
    }

    if (getEnv(A365_ENV_VARS.PER_REQUEST_EXPORT) === "true") {
      perRequestExport = true;
    } else if (getEnv(A365_ENV_VARS.PER_REQUEST_EXPORT) === "false") {
      perRequestExport = false;
    }

    const envScopes = getEnv(A365_ENV_VARS.AUTH_SCOPES);
    if (envScopes) {
      authScopes = envScopes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const envDomain = getEnv(A365_ENV_VARS.DOMAIN);
    if (envDomain) {
      domainOverride = envDomain;
    }

    const envCluster = getEnv(A365_ENV_VARS.CLUSTER_CATEGORY);
    if (envCluster && VALID_CLUSTER_CATEGORIES.has(envCluster)) {
      clusterCategory = envCluster as ClusterCategory;
    }

    // Assign resolved values
    this.enabled = enabled;
    this.tokenResolver = options?.tokenResolver;
    this.clusterCategory = clusterCategory;
    this.domainOverride = domainOverride;
    this.authScopes = authScopes;
    this.perRequestExport = perRequestExport;

    this.baggage = {
      propagationEnabled:
        jsonA365?.baggage?.propagationEnabled ?? options?.baggage?.propagationEnabled ?? true,
      enrichSpans: jsonA365?.baggage?.enrichSpans ?? options?.baggage?.enrichSpans ?? true,
    };

    this.hosting = {
      enabled: jsonA365?.hosting?.enabled ?? options?.hosting?.enabled ?? false,
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
      options.perRequestExport !== undefined ||
      options.hosting?.enabled === true;

    if (hasNonTrivialOptions) {
      Logger.getInstance().warn(
        "A365 configuration options are set but A365 is not enabled. " +
          "Set `a365.enabled: true` or `MICROSOFT_OTEL_A365_EXPORTER_ENABLED=true` to enable.",
      );
    }
  }
}
