// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to configure Microsoft OpenTelemetry using a connection string.
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
    },
  });

  console.log("Microsoft OpenTelemetry configured successfully!");
  console.log("Telemetry will be sent to Azure Application Insights");
}

main().catch(console.error);
