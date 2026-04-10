// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import * as opentelemetry from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } from "../../../src/index.js";
import type { HttpClient, PipelineRequest } from "@azure/core-rest-pipeline";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";

/**
 * Recorded request from the mock OTLP collector.
 */
interface CollectedRequest {
  url: string;
  method: string;
  body: Buffer;
}

/**
 * Starts a minimal HTTP server that records every incoming POST and responds 200.
 */
function createMockOtlpCollector(): {
  start: () => Promise<number>;
  stop: () => Promise<void>;
  requests: CollectedRequest[];
  clear: () => void;
} {
  const requests: CollectedRequest[] = [];
  let server: Server;

  function handler(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url || "",
        method: req.method || "",
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  }

  return {
    requests,
    clear: () => {
      requests.length = 0;
    },
    start: () =>
      new Promise<number>((resolve, reject) => {
        server = createServer(handler);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            resolve(addr.port);
          } else {
            reject(new Error("Failed to get server port"));
          }
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Mock Azure Monitor HTTP client that responds 200 immediately,
 * preventing the Azure Monitor exporter from blocking flush/shutdown.
 */
const azMonHttpClient: HttpClient = {
  sendRequest: vi.fn().mockImplementation((request: PipelineRequest) => {
    return Promise.resolve({
      headers: request.headers,
      request,
      status: 200,
      bodyAsText: JSON.stringify({ itemsReceived: 1, itemsAccepted: 1, errors: [] }),
    });
  }),
};

/**
 * Wait until at least `minCount` requests matching `path` arrive, or time out.
 */
async function waitForRequests(
  requests: CollectedRequest[],
  path: string,
  minCount: number,
  timeoutMs = 5000,
): Promise<CollectedRequest[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const matched = requests.filter((r) => r.url === path);
    if (matched.length >= minCount) {
      return matched;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return requests.filter((r) => r.url === path);
}

describe("OTLP Integration Tests", () => {
  let originalEnv: NodeJS.ProcessEnv;
  const collector = createMockOtlpCollector();
  let collectorPort: number;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    collectorPort = await collector.start();
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = `http://127.0.0.1:${collectorPort}`;
  });

  afterEach(async () => {
    try {
      await shutdownMicrosoftOpenTelemetry();
    } catch {
      // ignore
    }
    await collector.stop();
    collector.clear();
    process.env = originalEnv;
  });

  function startDistro(): void {
    useMicrosoftOpenTelemetry({
      // Use 100% sampling so all spans are recorded and exported.
      // The default tracesPerSecond (5) uses a RateLimitedSampler that may drop
      // spans with NOT_RECORD, preventing them from reaching any processor.
      samplingRatio: 1,
      tracesPerSecond: 0,
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
          httpClient: azMonHttpClient,
        },
        enableLiveMetrics: false,
      },
    });
  }

  it("should send traces to the OTLP endpoint", async () => {
    startDistro();

    const tracer = opentelemetry.trace.getTracer("otlp-integration-test");
    const span = tracer.startSpan("test-trace-span");
    span.setAttribute("test.key", "test-value");
    span.end();

    // The BatchSpanProcessor requires a full shutdown (not just forceFlush) to
    // reliably drain its buffer via the OTLP HTTP exporter in test environments.
    await shutdownMicrosoftOpenTelemetry();

    const traceRequests = await waitForRequests(collector.requests, "/v1/traces", 1);
    expect(traceRequests.length).toBeGreaterThanOrEqual(1);
    expect(traceRequests[0].method).toBe("POST");
    expect(traceRequests[0].body.length).toBeGreaterThan(0);
  });

  it("should send metrics to the OTLP endpoint", async () => {
    startDistro();

    const meter = opentelemetry.metrics.getMeter("otlp-integration-test");
    const counter = meter.createCounter("test_counter");
    counter.add(42, { "test.key": "test-value" });

    // Force flush the meter provider to trigger export
    const meterProvider = opentelemetry.metrics.getMeterProvider() as MeterProvider;
    await meterProvider.forceFlush();

    const metricRequests = await waitForRequests(collector.requests, "/v1/metrics", 1);
    expect(metricRequests.length).toBeGreaterThanOrEqual(1);
    expect(metricRequests[0].method).toBe("POST");
    expect(metricRequests[0].body.length).toBeGreaterThan(0);
  });

  it("should send logs to the OTLP endpoint", async () => {
    startDistro();

    const logger = logs.getLogger("otlp-integration-test");
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "test log message",
      attributes: { "test.key": "test-value" },
    });

    // Force flush the logger provider to trigger export
    const loggerProvider = logs.getLoggerProvider() as LoggerProvider;
    await loggerProvider.forceFlush();

    const logRequests = await waitForRequests(collector.requests, "/v1/logs", 1);
    expect(logRequests.length).toBeGreaterThanOrEqual(1);
    expect(logRequests[0].method).toBe("POST");
    expect(logRequests[0].body.length).toBeGreaterThan(0);
  });

  it("should send all signals when dual-exporting with Azure Monitor", async () => {
    startDistro();

    // Emit a trace
    const tracer = opentelemetry.trace.getTracer("otlp-dual-export-test");
    const span = tracer.startSpan("dual-export-span");
    span.setAttribute("signal", "trace");
    span.end();

    // Emit a metric
    const meter = opentelemetry.metrics.getMeter("otlp-dual-export-test");
    const counter = meter.createCounter("dual_export_counter");
    counter.add(1);

    // Emit a log
    const logger = logs.getLogger("otlp-dual-export-test");
    logger.emit({
      severityNumber: SeverityNumber.WARN,
      severityText: "WARN",
      body: "dual export test log",
    });

    // Force flush all providers
    const tracerProvider = (
      opentelemetry.trace.getTracerProvider() as opentelemetry.ProxyTracerProvider
    ).getDelegate() as NodeTracerProvider;
    await tracerProvider.forceFlush();
    await (opentelemetry.metrics.getMeterProvider() as MeterProvider).forceFlush();
    await (logs.getLoggerProvider() as LoggerProvider).forceFlush();

    const metricRequests = await waitForRequests(collector.requests, "/v1/metrics", 1);
    const logRequests = await waitForRequests(collector.requests, "/v1/logs", 1);

    // Azure Monitor mock should have received requests too (dual export)
    expect(azMonHttpClient.sendRequest).toHaveBeenCalled();
    // OTLP collector must have received metrics and logs
    expect(metricRequests.length).toBeGreaterThanOrEqual(1);
    expect(logRequests.length).toBeGreaterThanOrEqual(1);
  });

  it("should not send to OTLP when endpoint env var is not set", async () => {
    delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];

    startDistro();

    const tracer = opentelemetry.trace.getTracer("otlp-disabled-test");
    const span = tracer.startSpan("should-not-reach-otlp");
    span.end();

    const tracerProvider = (
      opentelemetry.trace.getTracerProvider() as opentelemetry.ProxyTracerProvider
    ).getDelegate() as NodeTracerProvider;
    await tracerProvider.forceFlush();
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The mock collector should not have received any OTLP requests
    const otlpRequests = collector.requests.filter(
      (r) => r.url === "/v1/traces" || r.url === "/v1/metrics" || r.url === "/v1/logs",
    );
    expect(otlpRequests.length).toBe(0);
  });
});
