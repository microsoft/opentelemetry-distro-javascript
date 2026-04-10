// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to generate custom traces that will be sent to Azure Monitor.
 */

import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
} from "@microsoft/opentelemetry";
import { context, trace, type Span } from "@opentelemetry/api";
import "dotenv/config";

function doWork(parent: Span): void {
  const ctx = trace.setSpan(context.active(), parent);
  const span = trace.getTracer("testTracer").startSpan("doWork", undefined, ctx);

  try {
    span.setAttribute("key", "value");
    span.addEvent("invoking doWork");
  } finally {
    span.end();
  }
}

async function main(): Promise<void> {
  useMicrosoftOpenTelemetry({
    azureMonitor: {
      azureMonitorExporterOptions: {
        connectionString:
          process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || "<your connection string>",
      },
    },
  });

  const tracer = trace.getTracer("testTracer");
  const parentSpan = tracer.startSpan("main");

  try {
    for (let i = 0; i < 10; i += 1) {
      doWork(parentSpan);
    }
  } finally {
    parentSpan.end();
  }

  console.log("Custom traces sent to Azure Monitor");

  await shutdownMicrosoftOpenTelemetry();
}

main().catch(console.error);
