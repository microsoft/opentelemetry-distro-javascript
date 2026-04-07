// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { MetricReader, ViewOptions } from "@opentelemetry/sdk-metrics";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";

import { InternalConfig } from "../shared/config.js";
import { MetricHandler } from "../metrics/index.js";
import { TraceHandler } from "../traces/handler.js";
import { LogHandler } from "../logs/index.js";
import { AZURE_MONITOR_OPENTELEMETRY_VERSION } from "../types.js";
import { patchOpenTelemetryInstrumentationEnable } from "../utils/opentelemetryInstrumentationPatcher.js";
import { parseResourceDetectorsFromEnvVar } from "../utils/common.js";
import { setupAzureMonitorComponents } from "../azureMonitorSetup.js";
import type { MicrosoftOpenTelemetryOptions } from "./types.js";
import { MICROSOFT_OPENTELEMETRY_VERSION } from "./types.js";

process.env["AZURE_MONITOR_DISTRO_VERSION"] = AZURE_MONITOR_OPENTELEMETRY_VERSION;
process.env["MICROSOFT_OPENTELEMETRY_VERSION"] = MICROSOFT_OPENTELEMETRY_VERSION;

let sdk: NodeSDK;
let disposeAzureMonitor: (() => void) | undefined;

/**
 * Initialize Microsoft OpenTelemetry distribution.
 *
 * This is the primary entry point for the distro. It sets up OpenTelemetry
 * providers and instrumentations, then attaches the configured exporters:
 * - Azure Monitor (when `options.azureMonitor` is provided)
 * - OTLP (future)
 * - A365 (future)
 *
 * @param options - Microsoft OpenTelemetry configuration options
 */
export function useMicrosoftOpenTelemetry(options?: MicrosoftOpenTelemetryOptions): void {
  const config = new InternalConfig(options);
  patchOpenTelemetryInstrumentationEnable();

  // ── Azure Monitor components (statsbeat, browser SDK loader, etc.) ─
  disposeAzureMonitor = setupAzureMonitorComponents(config);

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

  // ── Azure Monitor handlers ────────────────────────────────────────
  const metricHandler = new MetricHandler(config);
  const traceHandler = new TraceHandler(config, metricHandler);
  const logHandler = new LogHandler(config, metricHandler);

  const instrumentations = traceHandler
    .getInstrumentations()
    .concat(logHandler.getInstrumentations());

  const resourceDetectorsList = parseResourceDetectorsFromEnvVar();

  // ── Merge user-provided processors / readers / views ──────────────
  const spanProcessors: SpanProcessor[] = options?.spanProcessors || [];
  const logRecordProcessors: LogRecordProcessor[] = options?.logRecordProcessors || [];
  const customViews: ViewOptions[] = options?.views || [];

  // Always include Azure Monitor metric reader
  const metricReaders: MetricReader[] = [
    metricHandler.getMetricReader(),
    ...(options?.metricReaders || []),
  ];

  const views: ViewOptions[] = metricHandler.getViews().concat(customViews);

  // ── Create and start NodeSDK ──────────────────────────────────────
  const sdkConfig: Partial<NodeSDKConfiguration> = {
    autoDetectResources: true,
    metricReaders: metricReaders,
    views,
    instrumentations: instrumentations,
    logRecordProcessors: [
      logHandler.getAzureLogRecordProcessor(),
      ...logRecordProcessors,
      logHandler.getBatchLogRecordProcessor(),
    ],
    resource: config.resource,
    sampler: traceHandler.getSampler(),
    spanProcessors: [
      traceHandler.getAzureMonitorSpanProcessor(),
      ...spanProcessors,
      traceHandler.getBatchSpanProcessor(),
    ],
    resourceDetectors: resourceDetectorsList,
  };
  sdk = new NodeSDK(sdkConfig);
  // TODO: Enable auto-attach warning — see autoAttach.ts
  sdk.start();
}

/**
 * Shutdown Microsoft OpenTelemetry distribution.
 */
export function shutdownMicrosoftOpenTelemetry(): Promise<void> {
  disposeAzureMonitor?.();
  return sdk?.shutdown();
}

/**
 * Get the internal SDK instance for testing purposes
 * @internal
 */
 
export function _getSdkInstance(): NodeSDK | undefined {
  return sdk;
}
