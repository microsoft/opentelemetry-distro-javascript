// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * E2E validation: Azure Monitor telemetry (traces, metrics, logs) is exported
 * when using the distro with a connection string.
 *
 * This test intercepts the HTTP client used by the Azure Monitor exporters so
 * it never actually sends data to Application Insights — it captures the
 * envelopes and asserts they are well-formed.
 */

import { describe, it, afterEach, expect, vi } from "vitest";
import * as opentelemetry from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { HttpClient, PipelineRequest } from "@azure/core-rest-pipeline";
import type { TelemetryItem as Envelope } from "../../utils/models/index.js";
import { successfulBreezeResponse } from "../../utils/breezeTestUtils.js";

const TEST_IKEY = "1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
const TEST_CONNECTION_STRING = `InstrumentationKey=${TEST_IKEY}`;

/**
 * Create a mock HTTP client that captures Breeze-protocol envelopes.
 */
function createCapturingHttpClient(ingest: Envelope[]): HttpClient {
  return {
    sendRequest: vi.fn().mockImplementation((request: PipelineRequest) => {
      // Only capture requests aimed at the Breeze ingestion endpoint
      if (request.body && typeof request.body === "string") {
        try {
          const items = JSON.parse(request.body) as Envelope[];
          ingest.push(...items);
        } catch {
          // ignore non-JSON requests (e.g. QuickPulse pings)
        }
      }
      return Promise.resolve({
        headers: request.headers,
        request,
        status: 200,
        bodyAsText: JSON.stringify(successfulBreezeResponse(1)),
      });
    }),
  };
}

describe("E2E: Azure Monitor telemetry export via distro", () => {
  let ingest: Envelope[] = [];

  afterEach(async () => {
    // Dynamic import so each test can re-initialize the distro cleanly
    const { shutdownMicrosoftOpenTelemetry } = await import("../../../src/distro/distro.js");
    await shutdownMicrosoftOpenTelemetry().catch(() => {});
    opentelemetry.trace.disable();
    opentelemetry.metrics.disable();
    logs.disable();
    ingest = [];
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario 1: New API — useMicrosoftOpenTelemetry with azureMonitor key
  // ────────────────────────────────────────────────────────────────────
  it("useMicrosoftOpenTelemetry sends traces to Azure Monitor when azureMonitor options are provided", async () => {
    const { useMicrosoftOpenTelemetry } = await import("../../../src/distro/distro.js");
    const httpClient = createCapturingHttpClient(ingest);

    useMicrosoftOpenTelemetry({
      tracesPerSecond: 0, // disable rate limiting for deterministic test
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
          httpClient,
        },
        enableLiveMetrics: false,
        enableStandardMetrics: false,
      },
    });

    // Emit a trace
    const tracer = opentelemetry.trace.getTracer("e2e-test");
    const span = tracer.startSpan("test-operation", {
      kind: opentelemetry.SpanKind.SERVER,
    });
    span.end();

    // Force-flush to push data through the BatchSpanProcessor
    const provider = (
      opentelemetry.trace.getTracerProvider() as opentelemetry.ProxyTracerProvider
    ).getDelegate() as { forceFlush(): Promise<void> };
    await provider.forceFlush();

    // Verify at least one Request or RemoteDependency envelope was captured
    const traceEnvelopes = ingest.filter(
      (e) =>
        e.name === "Microsoft.ApplicationInsights.Request" ||
        e.name === "Microsoft.ApplicationInsights.RemoteDependency",
    );
    expect(traceEnvelopes.length).toBeGreaterThanOrEqual(1);
    expect(traceEnvelopes[0]!.iKey).toBe(TEST_IKEY);
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario 2: New API — useMicrosoftOpenTelemetry sends logs
  // ────────────────────────────────────────────────────────────────────
  it("useMicrosoftOpenTelemetry sends logs to Azure Monitor", async () => {
    const { useMicrosoftOpenTelemetry } = await import("../../../src/distro/distro.js");
    const httpClient = createCapturingHttpClient(ingest);

    useMicrosoftOpenTelemetry({
      tracesPerSecond: 0,
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
          httpClient,
        },
        enableLiveMetrics: false,
        enableStandardMetrics: false,
      },
    });

    // Emit a log
    const logger = logs.getLogger("e2e-test");
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "E2E test log message",
      attributes: { testAttr: "value" },
    });

    // Force-flush the logger provider
    const loggerProvider = logs.getLoggerProvider() as { forceFlush(): Promise<void> };
    await loggerProvider.forceFlush();

    const logEnvelopes = ingest.filter((e) => e.name === "Microsoft.ApplicationInsights.Message");
    expect(logEnvelopes.length).toBeGreaterThanOrEqual(1);
    expect(logEnvelopes[0]!.iKey).toBe(TEST_IKEY);
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario 3: New API — useMicrosoftOpenTelemetry sends metrics
  // ────────────────────────────────────────────────────────────────────
  it("useMicrosoftOpenTelemetry sends metrics to Azure Monitor", async () => {
    const { useMicrosoftOpenTelemetry } = await import("../../../src/distro/distro.js");
    const httpClient = createCapturingHttpClient(ingest);

    useMicrosoftOpenTelemetry({
      tracesPerSecond: 0,
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
          httpClient,
        },
        enableLiveMetrics: false,
        enableStandardMetrics: false,
      },
    });

    // Emit a metric
    const meter = opentelemetry.metrics.getMeter("e2e-test");
    const counter = meter.createCounter("e2e-test-counter");
    counter.add(42);

    // Force-flush metrics
    const meterProvider = opentelemetry.metrics.getMeterProvider() as {
      forceFlush(): Promise<void>;
    };
    await meterProvider.forceFlush();

    const metricEnvelopes = ingest.filter((e) => e.name === "Microsoft.ApplicationInsights.Metric");
    expect(metricEnvelopes.length).toBeGreaterThanOrEqual(1);
    // At least one should have our ikey
    const hasOurIkey = metricEnvelopes.some((e) => e.iKey === TEST_IKEY);
    expect(hasOurIkey).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario 4: useMicrosoftOpenTelemetry imported from package root
  // ────────────────────────────────────────────────────────────────────
  it("useMicrosoftOpenTelemetry from index sends traces with nested azureMonitor options", async () => {
    const { useMicrosoftOpenTelemetry: init } = await import("../../../src/index.js");
    const httpClient = createCapturingHttpClient(ingest);

    init({
      tracesPerSecond: 0,
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
          httpClient,
        },
        enableLiveMetrics: false,
        enableStandardMetrics: false,
      },
    });

    const tracer = opentelemetry.trace.getTracer("e2e-compat");
    const span = tracer.startSpan("compat-operation", {
      kind: opentelemetry.SpanKind.SERVER,
    });
    span.end();

    const provider = (
      opentelemetry.trace.getTracerProvider() as opentelemetry.ProxyTracerProvider
    ).getDelegate() as { forceFlush(): Promise<void> };
    await provider.forceFlush();

    const traceEnvelopes = ingest.filter(
      (e) =>
        e.name === "Microsoft.ApplicationInsights.Request" ||
        e.name === "Microsoft.ApplicationInsights.RemoteDependency",
    );
    expect(traceEnvelopes.length).toBeGreaterThanOrEqual(1);
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario 5: Connection string via env var only (no explicit options)
  // Validates that APPLICATIONINSIGHTS_CONNECTION_STRING alone enables
  // Azure Monitor export — this is the pattern many users rely on.
  // ────────────────────────────────────────────────────────────────────
  it("useMicrosoftOpenTelemetry enables Azure Monitor when APPLICATIONINSIGHTS_CONNECTION_STRING env var is set", async () => {
    const { useMicrosoftOpenTelemetry, _getSdkInstance } =
      await import("../../../src/distro/distro.js");
    const { AzureMonitorSpanProcessor } =
      await import("../../../src/azureMonitor/traces/spanProcessor.js");
    const originalEnv = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    try {
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = TEST_CONNECTION_STRING;

      // Call with no azureMonitor key — the env var alone should enable AM
      useMicrosoftOpenTelemetry();

      // The SDK should have been initialized
      const sdk = _getSdkInstance();
      expect(sdk).toBeDefined();

      // Verify that AzureMonitorSpanProcessor is registered — this is the
      // definitive check that Azure Monitor is active, not just console exporters.
      const tracerProvider = (sdk as any)["_tracerProvider"];
      const activeSpanProcessor = tracerProvider["_activeSpanProcessor"];
      const spanProcessors: unknown[] = activeSpanProcessor["_spanProcessors"] || [
        activeSpanProcessor,
      ];
      const hasAzureMonitor = spanProcessors.some((sp) => sp instanceof AzureMonitorSpanProcessor);
      expect(
        hasAzureMonitor,
        "AzureMonitorSpanProcessor should be registered when env var is set",
      ).toBe(true);
    } finally {
      if (originalEnv !== undefined) {
        process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = originalEnv;
      } else {
        delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
      }
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario 6: Verify that without any Azure Monitor config, AM is
  // correctly disabled (no crash, console exporters may activate)
  // ────────────────────────────────────────────────────────────────────
  it("useMicrosoftOpenTelemetry without any config still starts (console fallback)", async () => {
    const { useMicrosoftOpenTelemetry, _getSdkInstance } =
      await import("../../../src/distro/distro.js");
    const originalEnv = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    try {
      delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

      useMicrosoftOpenTelemetry();

      // SDK should still start (console exporters kick in)
      expect(_getSdkInstance()).toBeDefined();

      const tracer = opentelemetry.trace.getTracerProvider().getTracer("no-config-test");
      const span = tracer.startSpan("no-config-span");
      const { traceId } = span.spanContext();
      span.end();
      expect(traceId).toMatch(/^[a-f0-9]{32}$/);
      expect(traceId).not.toBe("00000000000000000000000000000000");
    } finally {
      if (originalEnv !== undefined) {
        process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = originalEnv;
      } else {
        delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
      }
    }
  });
});
