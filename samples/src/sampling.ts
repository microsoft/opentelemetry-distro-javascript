// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to enable sampling to reduce data ingestion volume and control costs.
 */

import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";
import "dotenv/config";

async function main(): Promise<void> {
  // A sampling ratio of 0.1 means approximately 10% of traces are sent
  useMicrosoftOpenTelemetry({
    samplingRatio: 0.1,
    azureMonitor: {
      azureMonitorExporterOptions: {
        connectionString:
          process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || "<your connection string>",
      },
    },
  });

  console.log("Microsoft OpenTelemetry configured with sampling:");
  console.log("  Sampling Ratio: 10% (0.1)");
  console.log("  This reduces data ingestion volume and costs");
}

main().catch(console.error);
