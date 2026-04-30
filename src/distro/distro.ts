// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { MetricReader, ViewOptions } from "@opentelemetry/sdk-metrics";
import {
  type SpanProcessor,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { SimpleLogRecordProcessor, ConsoleLogRecordExporter } from "@opentelemetry/sdk-logs";
import { ConsoleMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import { InternalConfig } from "../shared/config.js";
import { MetricHandler } from "../azureMonitor/metrics/index.js";
import { TraceHandler } from "../azureMonitor/traces/handler.js";
import { LogHandler } from "../azureMonitor/logs/index.js";
import { AZURE_MONITOR_OPENTELEMETRY_VERSION } from "../types.js";
import { patchOpenTelemetryInstrumentationEnable } from "../utils/opentelemetryInstrumentationPatcher.js";
import { parseResourceDetectorsFromEnvVar } from "../utils/common.js";
import { getInstance as getStatsbeatInstance } from "../utils/statsbeat.js";
import {
  setupAzureMonitorComponents,
  hasAzureMonitorConnectionString,
  validateAzureMonitorConfig,
  getAzureMonitorStatsbeatFeatures,
} from "../azureMonitor/index.js";
import { isOtlpEnabled, createOtlpComponents } from "../otlp/index.js";
import { A365Configuration, Agent365Exporter, A365SpanProcessor } from "../a365/index.js";
import { configureA365Logger } from "../a365/logging.js";
import {
  SdkStatsDistroFeature,
  SdkStatsManager,
  setSdkStatsFeature,
} from "../sdkstats/index.js";
import type {
  MicrosoftOpenTelemetryOptions,
  InstrumentationOptions,
  OpenAIAgentsInstrumentationConfig,
  LangChainInstrumentationConfig,
  StatsbeatFeatures,
  StatsbeatInstrumentations,
} from "../types.js";
import {
  MICROSOFT_OPENTELEMETRY_VERSION,
  APPLICATIONINSIGHTS_SDKSTATS_DISABLED,
  StatsbeatFeature,
} from "../types.js";
import { createInstrumentations, createSampler, createViews } from "./instrumentations.js";
import { Logger } from "../shared/logging/index.js";

process.env["AZURE_MONITOR_DISTRO_VERSION"] = AZURE_MONITOR_OPENTELEMETRY_VERSION;
process.env["MICROSOFT_OPENTELEMETRY_VERSION"] = MICROSOFT_OPENTELEMETRY_VERSION;

let sdk: NodeSDK;
let disposeAzureMonitor: (() => void) | undefined;
let isShutdown = false;

const A365_DISABLED_INSTRUMENTATIONS_BY_DEFAULT: ReadonlyArray<keyof InstrumentationOptions> = [
  "http",
  "azureSdk",
  "mongoDb",
  "mySql",
  "postgreSql",
  "redis",
  "redis4",
  "bunyan",
  "winston",
];

/**
 * Redis and redis4 share the same underlying instrumentation. If a caller
 * explicitly configures either key, treat both as explicitly configured so
 * the other is not inadvertently disabled.
 */
const REDIS_LINKED_KEYS: ReadonlyArray<keyof InstrumentationOptions> = ["redis", "redis4"];

/**
 * When A365 export is enabled, default to GenAI-focused telemetry by disabling
 * non-GenAI instrumentations unless callers explicitly configure them.
 *
 * @internal
 */
export function _applyA365InstrumentationDefaults(
  instrumentationOptions: InstrumentationOptions,
  userInstrumentationOptions: unknown,
  a365Enabled: boolean,
): void {
  if (!a365Enabled) {
    return;
  }

  const userOptionsRecord =
    userInstrumentationOptions && typeof userInstrumentationOptions === "object"
      ? (userInstrumentationOptions as Record<string, unknown>)
      : undefined;

  // Pre-compute whether any Redis-linked key was explicitly configured so
  // that configuring `redis4` alone does not inadvertently disable `redis`
  // (and vice-versa), which would break the underlying shared instrumentation.
  const redisLinkedExplicit =
    !!userOptionsRecord &&
    REDIS_LINKED_KEYS.some((k) => Object.prototype.hasOwnProperty.call(userOptionsRecord, k));

  for (const instrumentationKey of A365_DISABLED_INSTRUMENTATIONS_BY_DEFAULT) {
    const isExplicitlyConfigured =
      !!userOptionsRecord &&
      Object.prototype.hasOwnProperty.call(userOptionsRecord, instrumentationKey);

    // Treat redis/redis4 as a linked pair: if either was set by the caller,
    // skip disabling both keys.
    if (
      isExplicitlyConfigured ||
      (redisLinkedExplicit &&
        REDIS_LINKED_KEYS.includes(instrumentationKey as (typeof REDIS_LINKED_KEYS)[number]))
    ) {
      continue;
    }

    const currentValue = instrumentationOptions[instrumentationKey];
    if (currentValue && typeof currentValue === "object") {
      (currentValue as Record<string, unknown>).enabled = false;
    } else {
      instrumentationOptions[instrumentationKey] = { enabled: false };
    }
  }
}

/**
 * Initialize Microsoft OpenTelemetry distribution.
 *
 * This is the primary entry point for the distro. It sets up OpenTelemetry
 * providers and instrumentations, then attaches the configured exporters:
 * - Azure Monitor (when `options.azureMonitor` is provided or the
 *   `APPLICATIONINSIGHTS_CONNECTION_STRING` env var is set; explicitly disable
 *   with `options.azureMonitor.enabled = false`)
 * - OTLP HTTP (when `OTEL_EXPORTER_OTLP_ENDPOINT` is set)
 * - A365 (when the resolved A365 config has `enabled=true`; the
 *   `ENABLE_A365_OBSERVABILITY_EXPORTER` env var is only considered when
 *   `options.a365` is provided)
 *
 * @param options - Microsoft OpenTelemetry configuration options
 */
export function useMicrosoftOpenTelemetry(options?: MicrosoftOpenTelemetryOptions): void {
  const config = new InternalConfig(options);
  patchOpenTelemetryInstrumentationEnable();
  const a365Config = new A365Configuration(options?.a365);

  // Apply the resolved A365 log level (programmatic option > env var) so the
  // A365 logger filter reflects user-supplied configuration instead of being
  // pinned to whatever the env var was at module-load time.
  if (a365Config.logLevel !== undefined) {
    configureA365Logger({ logLevel: a365Config.logLevel });
  }

  // Azure Monitor is enabled when configured programmatically or via JSON config.
  // An explicit `enabled: false` always wins, even if a connection string is present.
  // Connection-string validation is delegated to the Azure Monitor module.
  const azureMonitorRequested =
    options?.azureMonitor?.enabled !== false &&
    (!!options?.azureMonitor || hasAzureMonitorConnectionString(config));
  const azureMonitorEnabled = azureMonitorRequested && validateAzureMonitorConfig(config);

  // ── SDKStats: record distro feature bits for ALL paths ──────────────────
  // ── SDKStats: record distro feature bits for ALL paths ──────────────────
  // These bits are emitted via SDKStats regardless of which exporter is
  // active. When Azure Monitor is enabled the exporter package's own
  // Statsbeat picks them up via `AZURE_MONITOR_STATSBEAT_FEATURES`; when
  // it is not, the standalone `SdkStatsManager` initialised below carries
  // them to the well-known Statsbeat ingestion endpoint.
  const otlpActive = isOtlpEnabled();
  setSdkStatsFeature(StatsbeatFeature.DISTRO);
  if (a365Config.enabled) {
    setSdkStatsFeature(SdkStatsDistroFeature.A365_EXPORT);
  }
  if (otlpActive) {
    setSdkStatsFeature(SdkStatsDistroFeature.OTLP_EXPORT);
  }

  // Reset dispose callback to avoid stale references from a previous initialization
  disposeAzureMonitor = undefined;

  // ── Azure Monitor components (statsbeat, browser SDK loader, etc.) ─
  if (azureMonitorEnabled) {
    disposeAzureMonitor = setupAzureMonitorComponents(config);
  }

  // ── Statsbeat (feature & instrumentation tracking for all paths) ──
  const statsbeatInstrumentations: StatsbeatInstrumentations = {
    azureSdk: config.instrumentationOptions?.azureSdk?.enabled,
    mongoDb: config.instrumentationOptions?.mongoDb?.enabled,
    mySql: config.instrumentationOptions?.mySql?.enabled,
    postgreSql: config.instrumentationOptions?.postgreSql?.enabled,
    redis: config.instrumentationOptions?.redis?.enabled,
    bunyan: config.instrumentationOptions?.bunyan?.enabled,
    winston: config.instrumentationOptions?.winston?.enabled,
  };
  const statsbeatFeatures: StatsbeatFeatures = {
    ...(azureMonitorEnabled
      ? getAzureMonitorStatsbeatFeatures(config)
      : {
          browserSdkLoader: false,
          aadHandling: false,
          diskRetry: false,
          aksResourceDetectorPopulation: false,
        }),
    a365: a365Config.enabled,
    otlp: otlpActive,
    customerSdkStats: process.env[APPLICATIONINSIGHTS_SDKSTATS_DISABLED]?.toLowerCase() === "true",
  };
  getStatsbeatInstance().setStatsbeatFeatures(statsbeatInstrumentations, statsbeatFeatures);

  // ── Register global providers ─────────────────────────────────────
  // Remove global providers in OpenTelemetry, these would be overridden if present
  metrics.disable();
  trace.disable();
  logs.disable();

  // Clear the entire OpenTelemetry API global state to avoid version conflicts.
  // The disable() calls above remove individual providers but leave the `version` field
  // on the global object intact. If a different version of @opentelemetry/api was loaded
  // first (e.g. by a VS Code extension host or another extension), the stale version
  // causes registerGlobal() in sdk.start() to fail with "All API registration versions
  // must match", resulting in Noop providers. Deleting the global object forces
  // registerGlobal() to create a fresh one with the correct version.
  const globalOpentelemetryApiKey = Symbol.for("opentelemetry.js.api.1");
  delete (globalThis as Record<symbol, unknown>)[globalOpentelemetryApiKey];

  // Apply A365 instrumentation defaults (disable non-GenAI instrumentations)
  // when A365 is enabled and Azure Monitor is not. When both A365 and Azure
  // Monitor are active, infra instrumentations must remain enabled so Azure
  // Monitor receives the telemetry it expects.
  const applyA365Defaults = a365Config.enabled && !azureMonitorEnabled;
  _applyA365InstrumentationDefaults(
    config.instrumentationOptions,
    options?.instrumentationOptions,
    applyA365Defaults,
  );

  // ── Instrumentations, sampler, and views (always created) ─────────
  const instrumentations = createInstrumentations(config, {
    filterAzureMonitorRequests: azureMonitorEnabled,
  });
  const sampler = createSampler(config);
  const views: ViewOptions[] = createViews(config);

  // ── Azure Monitor handlers (only when configured) ─────────────────
  let metricHandler: MetricHandler | undefined;
  let traceHandler: TraceHandler | undefined;
  let logHandler: LogHandler | undefined;

  if (azureMonitorEnabled) {
    metricHandler = new MetricHandler(config);
    traceHandler = new TraceHandler(config, metricHandler);
    logHandler = new LogHandler(config, metricHandler);
  }

  const resourceDetectorsList = parseResourceDetectorsFromEnvVar();

  // ── Merge user-provided processors / readers / views ──────────────
  // Clone caller-provided arrays to avoid mutating them when OTLP components are appended.
  const spanProcessors: SpanProcessor[] = [...(options?.spanProcessors || [])];
  const logRecordProcessors: LogRecordProcessor[] = [...(options?.logRecordProcessors || [])];
  const customViews: ViewOptions[] = [...(options?.views || [])];

  const metricReaders: MetricReader[] = [
    ...(metricHandler ? [metricHandler.getMetricReader()] : []),
    ...(options?.metricReaders || []),
  ];

  // ── OTLP HTTP exporters (enabled via OTEL_EXPORTER_OTLP_ENDPOINT) ─
  if (otlpActive) {
    const otlp = createOtlpComponents();
    if (otlp.spanProcessor) {
      spanProcessors.push(otlp.spanProcessor);
    }
    if (otlp.metricReader) {
      metricReaders.push(otlp.metricReader);
    }
    if (otlp.logRecordProcessor) {
      logRecordProcessors.push(otlp.logRecordProcessor);
    }
  }

  // ── A365 exporter (enabled when the resolved A365 config has enabled=true;
  //    ENABLE_A365_OBSERVABILITY_EXPORTER is only considered when options.a365
  //    is provided) ───────────────────────────────────────────────────────────
  if (a365Config.enabled) {
    // A365SpanProcessor copies baggage (tenant, agent, session, etc.) and
    // telemetry.sdk.* attributes to span attributes. Always registered when
    // A365 is enabled, even if the HTTP exporter is suppressed, so downstream
    // exporters (Azure Monitor, OTLP, …) still receive the enriched spans.
    spanProcessors.push(new A365SpanProcessor());
    if (a365Config.enableObservabilityExporter) {
      const a365Exporter = new Agent365Exporter({
        clusterCategory: a365Config.clusterCategory,
        domainOverride: a365Config.domainOverride,
        authScopes: a365Config.authScopes,
        tokenResolver: a365Config.tokenResolver,
        useS2SEndpoint: a365Config.useS2SEndpoint,
        ...(a365Config.maxQueueSize !== undefined && {
          maxQueueSize: a365Config.maxQueueSize,
        }),
        ...(a365Config.scheduledDelayMilliseconds !== undefined && {
          scheduledDelayMilliseconds: a365Config.scheduledDelayMilliseconds,
        }),
        ...(a365Config.exporterTimeoutMilliseconds !== undefined && {
          exporterTimeoutMilliseconds: a365Config.exporterTimeoutMilliseconds,
        }),
        ...(a365Config.httpRequestTimeoutMilliseconds !== undefined && {
          httpRequestTimeoutMilliseconds: a365Config.httpRequestTimeoutMilliseconds,
        }),
        ...(a365Config.maxExportBatchSize !== undefined && {
          maxExportBatchSize: a365Config.maxExportBatchSize,
        }),
        ...(a365Config.maxPayloadBytes !== undefined && {
          maxPayloadBytes: a365Config.maxPayloadBytes,
        }),
      });
      spanProcessors.push(new BatchSpanProcessor(a365Exporter));
    }
  }

  // Merge views: use Azure Monitor views when available (they cover the same
  // instrumentations as createViews), otherwise fall back to the standalone views.
  const allViews: ViewOptions[] = [
    ...(metricHandler ? metricHandler.getViews() : views),
    ...customViews,
  ];
  // ── Console exporters (auto-enabled when no other exporter is active, or explicitly) ─
  const hasCustomProcessors =
    (options?.spanProcessors?.length ?? 0) > 0 ||
    (options?.metricReaders?.length ?? 0) > 0 ||
    (options?.logRecordProcessors?.length ?? 0) > 0;
  const consoleEnabled =
    options?.enableConsoleExporters ??
    (!azureMonitorEnabled &&
      !otlpActive &&
      !(a365Config.enabled && a365Config.enableObservabilityExporter) &&
      !hasCustomProcessors);
  if (consoleEnabled) {
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: config.metricExportIntervalMillis,
      }),
    );
    logRecordProcessors.push(new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()));
    setSdkStatsFeature(SdkStatsDistroFeature.CONSOLE_EXPORT);
  }

  // ── Create and start NodeSDK ──────────────────────────────────────
  const sdkConfig: Partial<NodeSDKConfiguration> = {
    autoDetectResources: true,
    metricReaders: metricReaders,
    views: allViews,
    instrumentations: instrumentations,
    logRecordProcessors: [
      ...(logHandler ? [logHandler.getAzureLogRecordProcessor()] : []),
      ...logRecordProcessors,
      ...(logHandler ? [logHandler.getBatchLogRecordProcessor()] : []),
    ],
    resource: config.resource,
    sampler,
    spanProcessors: [
      ...(traceHandler ? [traceHandler.getAzureMonitorSpanProcessor()] : []),
      ...spanProcessors,
      ...(traceHandler ? [traceHandler.getBatchSpanProcessor()] : []),
    ],
    resourceDetectors: resourceDetectorsList,
  };
  sdk = new NodeSDK(sdkConfig);
  // TODO: Enable auto-attach warning — see autoAttach.ts
  isShutdown = false;
  sdk.start();

  // ── SDKStats: standalone pipeline for non-Azure-Monitor paths ─────
  // When Azure Monitor is enabled the exporter package emits SDKStats
  // itself (reading bits set above via `AZURE_MONITOR_STATSBEAT_FEATURES`).
  // For A365-only / OTLP-only / Console-only customers we spin up our
  // own MeterProvider + AzureMonitorStatsbeatExporter pipeline so the
  // distro feature/instrumentation bits still reach the well-known
  // statsbeat endpoint.
  if (!azureMonitorEnabled) {
    void SdkStatsManager.getInstance().initialize();
  }

  // Initialize GenAI instrumentations after providers are registered so any
  // tracer they capture is backed by the active SDK provider.
  // When A365 defaults were applied, use the resolved config so GenAI
  // instrumentations honour any A365-specific overrides. Otherwise pass the
  // caller's original options (GenAI instrumentations are enabled by default
  // unless explicitly disabled).
  initializeGenAIInstrumentations(
    applyA365Defaults ? config.instrumentationOptions : options?.instrumentationOptions,
  );
}

/**
 * Shutdown Microsoft OpenTelemetry distribution.
 */
export function shutdownMicrosoftOpenTelemetry(): Promise<void> {
  isShutdown = true;
  disposeAzureMonitor?.();
  const sdkShutdown = sdk?.shutdown() ?? Promise.resolve();
  return sdkShutdown
    .finally(() => SdkStatsManager.getInstance().shutdown())
    .finally(() => resetGenAIInstrumentations());
}

/**
 * Get the internal SDK instance for testing purposes
 * @internal
 */

export function _getSdkInstance(): NodeSDK | undefined {
  return sdk;
}

function initializeGenAIInstrumentations(options?: InstrumentationOptions): void {
  const openAIOptions = options?.openaiAgents;
  if (openAIOptions?.enabled !== false) {
    void initializeOpenAIAgentsInstrumentation(openAIOptions ?? {});
  }

  const langChainOptions = options?.langchain;
  if (langChainOptions?.enabled !== false) {
    void initializeLangChainInstrumentation(langChainOptions ?? {});
  }
}

/**
 * @internal Exposed for testing — true after shutdown, false after init.
 */
export function _isShutdown(): boolean {
  return isShutdown;
}

async function initializeOpenAIAgentsInstrumentation(
  options: OpenAIAgentsInstrumentationConfig,
): Promise<void> {
  try {
    const { OpenAIAgentsTraceInstrumentor } =
      await import("../genai/instrumentations/openai/openAIAgentsTraceInstrumentor.js");
    if (isShutdown) return;
    OpenAIAgentsTraceInstrumentor.instrument(options);
  } catch (error) {
    Logger.getInstance().warn(
      "[GenAI] Failed to initialize OpenAI Agents instrumentation. " +
        "Ensure @openai/agents is installed when openaiAgents config is enabled.",
      error,
    );
  }
}

async function initializeLangChainInstrumentation(
  _options: LangChainInstrumentationConfig,
): Promise<void> {
  try {
    const [{ LangChainTraceInstrumentor }, callbackManagerModule] = await Promise.all([
      import("../genai/instrumentations/langchain/langchainTraceInstrumentor.js"),
      import("@langchain/core/callbacks/manager"),
    ]);
    if (isShutdown) return;
    LangChainTraceInstrumentor.instrument(callbackManagerModule);
  } catch (error) {
    Logger.getInstance().warn(
      "[GenAI] Failed to initialize LangChain instrumentation. " +
        "Ensure @langchain/core is installed when langchain config is enabled.",
      error,
    );
  }
}

async function resetGenAIInstrumentations(): Promise<void> {
  try {
    const { OpenAIAgentsTraceInstrumentor } =
      await import("../genai/instrumentations/openai/openAIAgentsTraceInstrumentor.js");
    OpenAIAgentsTraceInstrumentor.resetInstance();
  } catch {
    // Ignore when optional dependency is not installed.
  }

  try {
    const { LangChainTraceInstrumentor } =
      await import("../genai/instrumentations/langchain/langchainTraceInstrumentor.js");
    LangChainTraceInstrumentor.resetInstance();
  } catch {
    // Ignore when optional dependency is not installed.
  }
}
