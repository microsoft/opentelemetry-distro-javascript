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
import { patchOpenTelemetryInstrumentationEnable } from "../azureMonitor/utils/opentelemetryInstrumentationPatcher.js";
import { parseResourceDetectorsFromEnvVar } from "../utils/common.js";
import {
  setupAzureMonitorComponents,
  hasAzureMonitorConnectionString,
  validateAzureMonitorConfig,
} from "../azureMonitor/index.js";
import { isOtlpEnabled, createOtlpComponents } from "../otlp/index.js";
import { A365Configuration, Agent365Exporter, A365SpanProcessor } from "../a365/index.js";
import type {
  MicrosoftOpenTelemetryOptions,
  InstrumentationOptions,
  OpenAIAgentsInstrumentationConfig,
  LangChainInstrumentationConfig,
} from "../types.js";
import { MICROSOFT_OPENTELEMETRY_VERSION } from "../types.js";
import { createInstrumentations, createSampler, createViews } from "./instrumentations.js";
import { Logger } from "../shared/logging/index.js";

process.env["AZURE_MONITOR_DISTRO_VERSION"] = AZURE_MONITOR_OPENTELEMETRY_VERSION;
process.env["MICROSOFT_OPENTELEMETRY_VERSION"] = MICROSOFT_OPENTELEMETRY_VERSION;

let sdk: NodeSDK;
let disposeAzureMonitor: (() => void) | undefined;
let isShutdown = false;

/**
 * Initialize Microsoft OpenTelemetry distribution.
 *
 * This is the primary entry point for the distro. It sets up OpenTelemetry
 * providers and instrumentations, then attaches the configured exporters:
 * - Azure Monitor (when `options.azureMonitor` is provided or the
 *   `APPLICATIONINSIGHTS_CONNECTION_STRING` env var is set; explicitly disable
 *   with `options.azureMonitor.enabled = false`)
 * - OTLP HTTP (when `OTEL_EXPORTER_OTLP_ENDPOINT` is set)
 * - A365 (when `options.a365.enabled` is true or `ENABLE_A365_OBSERVABILITY_EXPORTER=true`)
 *
 * @param options - Microsoft OpenTelemetry configuration options
 */
export function useMicrosoftOpenTelemetry(options?: MicrosoftOpenTelemetryOptions): void {
  const config = new InternalConfig(options);
  patchOpenTelemetryInstrumentationEnable();

  // Azure Monitor is enabled when configured programmatically or via JSON config.
  // An explicit `enabled: false` always wins, even if a connection string is present.
  // Connection-string validation is delegated to the Azure Monitor module.
  const azureMonitorRequested =
    options?.azureMonitor?.enabled !== false &&
    (!!options?.azureMonitor || hasAzureMonitorConnectionString(config));
  const azureMonitorEnabled = azureMonitorRequested && validateAzureMonitorConfig(config);

  // Reset dispose callback to avoid stale references from a previous initialization
  disposeAzureMonitor = undefined;

  // ── Azure Monitor components (statsbeat, browser SDK loader, etc.) ─
  if (azureMonitorEnabled) {
    disposeAzureMonitor = setupAzureMonitorComponents(config);
  }

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
  if (isOtlpEnabled()) {
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

  // ── A365 exporter (enabled via options.a365 or env vars) ──────────
  const a365Config = new A365Configuration(options?.a365);
  const a365ConsoleExportFallback = !a365Config.enabled && !!options?.a365;
  if (a365Config.enabled) {
    const a365Exporter = new Agent365Exporter({
      clusterCategory: a365Config.clusterCategory,
      domainOverride: a365Config.domainOverride,
      authScopes: a365Config.authScopes,
      tokenResolver: a365Config.tokenResolver,
    });
    // A365SpanProcessor copies baggage (tenant, agent, session, etc.) to span attributes
    if (a365Config.baggage.enrichSpans) {
      spanProcessors.push(new A365SpanProcessor());
    }
    spanProcessors.push(new BatchSpanProcessor(a365Exporter));
  } else if (a365ConsoleExportFallback) {
    // A365 options provided but exporter disabled — fall back to console export
    // so developers can validate spans locally (matches upstream A365 SDK behavior
    // when ENABLE_A365_OBSERVABILITY_EXPORTER=false).
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
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
    (!azureMonitorEnabled && !isOtlpEnabled() && !a365Config.enabled && !hasCustomProcessors);
  if (consoleEnabled) {
    // Skip span console exporter when A365 fallback already added one
    if (!a365ConsoleExportFallback) {
      spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    }
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: config.metricExportIntervalMillis,
      }),
    );
    logRecordProcessors.push(new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()));
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

  // Initialize GenAI instrumentations after providers are registered so any
  // tracer they capture is backed by the active SDK provider.
  initializeGenAIInstrumentations(options?.instrumentationOptions);
}

/**
 * Shutdown Microsoft OpenTelemetry distribution.
 */
export function shutdownMicrosoftOpenTelemetry(): Promise<void> {
  isShutdown = true;
  disposeAzureMonitor?.();
  const sdkShutdown = sdk?.shutdown() ?? Promise.resolve();
  return sdkShutdown.finally(() => resetGenAIInstrumentations());
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
  if (openAIOptions && openAIOptions.enabled !== false) {
    void initializeOpenAIAgentsInstrumentation(openAIOptions);
  }

  const langChainOptions = options?.langchain;
  if (langChainOptions && langChainOptions.enabled !== false) {
    void initializeLangChainInstrumentation(langChainOptions);
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
  options: LangChainInstrumentationConfig,
): Promise<void> {
  try {
    const [{ LangChainTraceInstrumentor }, callbackManagerModule] = await Promise.all([
      import("../genai/instrumentations/langchain/langchainTraceInstrumentor.js"),
      import("@langchain/core/callbacks/manager"),
    ]);
    if (isShutdown) return;
    LangChainTraceInstrumentor.instrument(callbackManagerModule, options);
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
