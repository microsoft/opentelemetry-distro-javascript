// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to enable or disable Live Metrics for real-time monitoring.
 */

import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";
import "dotenv/config";

async function main(): Promise<void> {
  useMicrosoftOpenTelemetry({
    azureMonitor: {
      azureMonitorExporterOptions: {
        connectionString:
          process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || "<your connection string>",
      },
      enableLiveMetrics: true,
    },
  });

  console.log("Microsoft OpenTelemetry configured with Live Metrics:");
  console.log("  Live Metrics: ENABLED");
  console.log("  Check Azure Portal > Application Insights > Live Metrics Stream");
}

main().catch(console.error);
