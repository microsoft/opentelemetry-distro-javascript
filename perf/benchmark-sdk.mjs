// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const scenarios = [
  { name: "span", test: "span_creation", category: "span" },
  {
    name: "span_with_attribute",
    test: "span_creation_with_attribute",
    category: "span",
  },
  { name: "counter_add", test: "metric_counter_add", category: "metric" },
  { name: "logger_emit", test: "log_emit", category: "log" },
];

export async function startBenchmarkSdk(packageRoot) {
  // This helper runs only in dedicated benchmark processes, never in the library.
  for (const key of Object.keys(process.env)) {
    if (
      /^(OTEL_|APPLICATIONINSIGHTS_|AZURE_MONITOR_|MICROSOFT_OTEL_|A365_|ENABLE_A365_)/i.test(key)
    ) {
      delete process.env[key];
    }
  }
  process.env.MICROSOFT_OTEL_SDKSTATS_DISABLED = "true";
  process.env.APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL = "true";
  process.env.OTEL_NODE_RESOURCE_DETECTORS = "none";
  process.env.OTEL_TRACES_SAMPLER = "always_on";

  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  const { metrics, trace } = requireFromPackage("@opentelemetry/api");
  const { logs } = requireFromPackage("@opentelemetry/api-logs");
  const { MetricReader } = requireFromPackage("@opentelemetry/sdk-metrics");
  const { azureVmDetector } = requireFromPackage("@opentelemetry/resource-detector-azure");
  // InternalConfig invokes this detector even with OTEL_NODE_RESOURCE_DETECTORS=none.
  // Resource discovery/startup is not measured; suppress its metadata HTTP request.
  const originalDetect = azureVmDetector.detect;
  azureVmDetector.detect = () => ({ attributes: {} });

  class NonExportingMetricReader extends MetricReader {
    async onForceFlush() {}
    async onShutdown() {}
  }
  const metricReader = new NonExportingMetricReader();
  const logRecordProcessor = {
    enabled: () => true,
    forceFlush: async () => {},
    onEmit: () => {},
    shutdown: async () => {},
  };
  const spanProcessor = {
    forceFlush: async () => {},
    onStart: () => {},
    onEnd: () => {},
    shutdown: async () => {},
  };
  let shutdown;
  try {
    const sdk = await import(pathToFileURL(join(packageRoot, "dist", "esm", "index.js")).href);
    shutdown = sdk.shutdownMicrosoftOpenTelemetry;
    sdk.useMicrosoftOpenTelemetry({
      azureMonitor: { enabled: false },
      a365: { enabled: false },
      enableConsoleExporters: false,
      instrumentationOptions: Object.fromEntries(
        [
          "azureSdk",
          "bunyan",
          "console",
          "http",
          "langchain",
          "mongoDb",
          "mySql",
          "openaiAgents",
          "postgreSql",
          "redis",
          "redis4",
          "winston",
        ].map((name) => [name, { enabled: false }]),
      ),
      logRecordProcessors: [logRecordProcessor],
      metricReaders: [metricReader],
      samplingRatio: 1,
      spanProcessors: [spanProcessor],
      tracesPerSecond: 0,
    });
    const tracer = trace.getTracer("performance-test");
    const logger = logs.getLogger("performance-test");
    const counter = metrics.getMeter("performance-test").createCounter("benchmark-counter");
    const probe = tracer.startSpan("benchmark-probe");
    assert(probe.isRecording(), "Benchmark requires a recording tracer");
    probe.end();
    let emitted = false;
    logRecordProcessor.onEmit = () => {
      emitted = true;
    };
    logger.emit({ body: "benchmark-probe" });
    logRecordProcessor.onEmit = () => {};
    assert(emitted, "Benchmark requires a recording logger");
    counter.add(1);
    const collected = await metricReader.collect();
    assert.equal(collected.errors.length, 0, "Benchmark metric collection failed");
    assert(
      collected.resourceMetrics.scopeMetrics.some((scope) =>
        scope.metrics.some(
          (metric) =>
            metric.descriptor.name === "benchmark-counter" &&
            metric.dataPoints.some((point) => point.value === 1),
        ),
      ),
      "Benchmark requires an aggregating counter",
    );
    const operations = [
      () => {
        tracer.startSpan("benchmark-span").end();
      },
      () => {
        const span = tracer.startSpan("benchmark-span");
        span.setAttribute("benchmark.attribute", 1);
        span.end();
      },
      () => {
        counter.add(1);
      },
      () => {
        logger.emit({ body: "benchmark-log" });
      },
    ];
    return {
      scenarios: scenarios.map((scenario, index) => ({
        ...scenario,
        operation: operations[index],
      })),
      shutdown,
    };
  } catch (error) {
    await shutdown?.();
    throw error;
  } finally {
    azureVmDetector.detect = originalDetect;
  }
}
