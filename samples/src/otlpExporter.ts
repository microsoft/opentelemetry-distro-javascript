// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to enable the OTLP exporter alongside Azure Monitor to send telemetry to two locations.
 */

import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
} from "@microsoft/opentelemetry";
import { trace } from "@opentelemetry/api";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import "dotenv/config";

async function main(): Promise<void> {
  const otlpExporter = new OTLPTraceExporter({
    url: "http://localhost:4318/v1/traces",
  });

  useMicrosoftOpenTelemetry({
    azureMonitor: {
      azureMonitorExporterOptions: {
        connectionString:
          process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || "<your connection string>",
      },
    },
    spanProcessors: [new BatchSpanProcessor(otlpExporter)],
  });

  // Generate a sample span to demonstrate dual export
  const tracer = trace.getTracer("otlpSampleTracer");
  const span = tracer.startSpan("sample-operation");
  span.setAttribute("sample.key", "sample-value");
  span.end();

  console.log("Microsoft OpenTelemetry configured with dual export:");
  console.log("  Azure Monitor: Enabled");
  console.log("  OTLP Exporter: Enabled (http://localhost:4318/v1/traces)");

  await shutdownMicrosoftOpenTelemetry();
}

main().catch(console.error);
