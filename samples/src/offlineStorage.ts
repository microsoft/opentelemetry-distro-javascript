// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to configure offline storage and automatic retries for telemetry.
 */

import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";
import "dotenv/config";

async function main(): Promise<void> {
  useMicrosoftOpenTelemetry({
    azureMonitor: {
      azureMonitorExporterOptions: {
        connectionString:
          process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || "<your connection string>",
        storageDirectory: "path/to/storage/directory",
        disableOfflineStorage: false,
      },
    },
  });

  console.log("Microsoft OpenTelemetry configured with offline storage:");
  console.log("  Offline Storage: ENABLED");
  console.log("  Telemetry will be cached locally when disconnected");
}

main().catch(console.error);
