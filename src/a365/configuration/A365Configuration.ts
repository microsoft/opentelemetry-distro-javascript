// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  A365Options,
  ClusterCategory,
  A365BaggageOptions,
} from "./A365ConfigurationOptions.js";
import { Logger } from "../../shared/logging/index.js";

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

  constructor(options?: A365Options) {
    // 1. Set defaults
    let enabled = false;
    let clusterCategory: ClusterCategory = "prod";
    let domainOverride: string | undefined = options?.domainOverride;
    let authScopes: string[] = options?.authScopes ?? [DEFAULT_AUTH_SCOPE];

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
      Logger.getInstance().warn(
        `Invalid ${A365_ENV_VARS.CLUSTER_CATEGORY} value '${envCluster}'. Using default cluster category.`,
      );
    }

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
      Logger.getInstance().warn(
        "A365 configuration options are set but A365 is not enabled. " +
          "Set `a365.enabled: true` or `ENABLE_A365_OBSERVABILITY_EXPORTER=true` to enable.",
      );
    }
  }
}
