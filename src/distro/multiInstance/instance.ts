// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meter, Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import {
  type SpanProcessor,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  ConsoleLogRecordExporter,
} from "@opentelemetry/sdk-logs";
import type { MetricReader, ViewOptions } from "@opentelemetry/sdk-metrics";
import {
  MeterProvider,
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

import { InternalConfig } from "../../shared/config.js";
import { MetricHandler } from "../../azureMonitor/metrics/index.js";
import { TraceHandler } from "../../azureMonitor/traces/handler.js";
import { LogHandler } from "../../azureMonitor/logs/index.js";
import {
  hasAzureMonitorConnectionString,
  setupAzureMonitorComponents,
  validateAzureMonitorConfig,
} from "../../azureMonitor/index.js";
import type { MicrosoftOpenTelemetryInstance, MicrosoftOpenTelemetryOptions } from "../../types.js";
import { createSampler, createViews } from "../instrumentations.js";
import { ensureGlobalSetup } from "./globalSetup.js";
import {
  registerInstance,
  setDefaultInstance,
  unregisterInstance,
  withInstance,
} from "./instanceRegistry.js";

let instanceCounter = 0;

/**
 * Build the child telemetry pipeline (providers + processors/readers) for a
 * single instance. Unlike the single-instance distro path, this does NOT call
 * `NodeSDK.start()` — the child providers are never registered as the global
 * providers. Instead they are registered with the instance registry and the
 * global parent (delegating) providers route to them.
 */
class MicrosoftOpenTelemetryInstanceImpl implements MicrosoftOpenTelemetryInstance {
  readonly id: string;
  private readonly tracerProvider: NodeTracerProvider;
  private readonly meterProvider: MeterProvider;
  private readonly loggerProvider: LoggerProvider;
  private readonly disposers: Array<() => void | Promise<void>> = [];
  private shutdownPromise?: Promise<void>;

  constructor(id: string, options?: MicrosoftOpenTelemetryOptions) {
    this.id = id;
    const config = new InternalConfig(options);

    const azureMonitorRequested =
      options?.azureMonitor?.enabled !== false &&
      (!!options?.azureMonitor || hasAzureMonitorConnectionString(config));
    const azureMonitorEnabled = azureMonitorRequested && validateAzureMonitorConfig(config);

    if (azureMonitorEnabled) {
      this.disposers.push(setupAzureMonitorComponents(config));
    }

    const sampler = createSampler(config);

    // ── Azure Monitor handlers (only when enabled) ──────────────────
    let metricHandler: MetricHandler | undefined;
    let traceHandler: TraceHandler | undefined;
    let logHandler: LogHandler | undefined;
    if (azureMonitorEnabled) {
      metricHandler = new MetricHandler(config);
      traceHandler = new TraceHandler(config, metricHandler);
      logHandler = new LogHandler(config, metricHandler);
      this.disposers.push(() => metricHandler!.shutdown());
      this.disposers.push(() => traceHandler!.shutdown());
      // LogHandler owns no exporter of its own to dispose; its processors are
      // shut down with the LoggerProvider below.
    }

    // ── Compose pipelines (Azure Monitor + caller-supplied) ─────────
    const spanProcessors: SpanProcessor[] = [
      ...(traceHandler ? [traceHandler.getAzureMonitorSpanProcessor()] : []),
      ...(options?.spanProcessors ?? []),
      ...(traceHandler ? [traceHandler.getBatchSpanProcessor()] : []),
    ];
    const logRecordProcessors: LogRecordProcessor[] = [
      ...(logHandler ? [logHandler.getAzureLogRecordProcessor()] : []),
      ...(options?.logRecordProcessors ?? []),
      ...(logHandler ? [logHandler.getBatchLogRecordProcessor()] : []),
    ];
    const metricReaders: MetricReader[] = [
      ...(metricHandler ? [metricHandler.getMetricReader()] : []),
      ...(options?.metricReaders ?? []),
    ];
    const views: ViewOptions[] = [
      ...(metricHandler ? metricHandler.getViews() : createViews(config)),
      ...(options?.views ?? []),
    ];

    // ── Console fallback when nothing else is configured ────────────
    const hasCustomProcessors =
      (options?.spanProcessors?.length ?? 0) > 0 ||
      (options?.metricReaders?.length ?? 0) > 0 ||
      (options?.logRecordProcessors?.length ?? 0) > 0;
    const consoleEnabled =
      options?.enableConsoleExporters ?? (!azureMonitorEnabled && !hasCustomProcessors);
    if (consoleEnabled) {
      spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
      metricReaders.push(
        new PeriodicExportingMetricReader({
          exporter: new ConsoleMetricExporter(),
          exportIntervalMillis: config.metricExportIntervalMillis,
        }),
      );
      logRecordProcessors.push(new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()));
    }

    // ── Build child providers (NOT registered globally) ─────────────
    this.tracerProvider = new NodeTracerProvider({
      resource: config.resource,
      sampler,
      spanProcessors,
    });
    this.meterProvider = new MeterProvider({
      resource: config.resource,
      views,
      readers: metricReaders,
    });
    this.loggerProvider = new LoggerProvider({
      resource: config.resource,
      processors: logRecordProcessors,
    });

    registerInstance(this.id, {
      tracerProvider: this.tracerProvider,
      meterProvider: this.meterProvider,
      loggerProvider: this.loggerProvider,
    });
  }

  getTracer(name: string, version?: string): Tracer {
    return this.tracerProvider.getTracer(name, version);
  }

  getMeter(name: string, version?: string): Meter {
    return this.meterProvider.getMeter(name, version);
  }

  getLogger(name: string, version?: string): Logger {
    return this.loggerProvider.getLogger(name, version);
  }

  runWithInstance<T>(fn: () => T): T {
    return withInstance(this.id, fn);
  }

  async forceFlush(): Promise<void> {
    await Promise.all([
      this.tracerProvider.forceFlush(),
      this.meterProvider.forceFlush(),
      this.loggerProvider.forceFlush(),
    ]);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    unregisterInstance(this.id);
    this.shutdownPromise = (async () => {
      // Wrap each disposer so a synchronous throw is captured and does not
      // abort the rest of shutdown.
      await Promise.allSettled(this.disposers.map((d) => Promise.resolve().then(d)));
      await Promise.allSettled([
        this.tracerProvider.shutdown(),
        this.meterProvider.shutdown(),
        this.loggerProvider.shutdown(),
      ]);
    })();
    return this.shutdownPromise;
  }
}

/**
 * Create an isolated Microsoft OpenTelemetry SDK instance.
 *
 * Unlike {@link useMicrosoftOpenTelemetry} (single, global default instance),
 * this can be called multiple times in the same Node.js runtime to run
 * independent, isolated pipelines side by side — for example two Azure Monitor
 * resources with different connection strings.
 *
 * The first instance created becomes the default for global API access; pass a
 * truthy `makeDefault` to override.
 */
export function createMicrosoftOpenTelemetryInstance(
  options?: MicrosoftOpenTelemetryOptions,
  config?: { makeDefault?: boolean },
): MicrosoftOpenTelemetryInstance {
  ensureGlobalSetup();
  const id = `microsoft-otel-instance-${++instanceCounter}`;
  const instance = new MicrosoftOpenTelemetryInstanceImpl(id, options);
  if (config?.makeDefault) {
    setDefaultInstance(id);
  }
  return instance;
}
