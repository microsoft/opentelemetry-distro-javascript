// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to enable OpenAI Agents SDK instrumentation to trace GenAI operations.
 */

import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
} from "@microsoft/opentelemetry";
import { Agent, run } from "@openai/agents";
import "dotenv/config";

async function main(): Promise<void> {
  useMicrosoftOpenTelemetry({
    azureMonitor: {
      azureMonitorExporterOptions: {
        connectionString:
          process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || "<your connection string>",
      },
    },
    instrumentationOptions: {
      openaiAgents: {
        enabled: true,
        isContentRecordingEnabled: true,
      },
    },
  });

  // Create an OpenAI agent
  const agent = new Agent({
    name: "Assistant",
    instructions: "You are a helpful assistant that answers questions concisely.",
    model: process.env.OPENAI_MODEL || "gpt-4o",
  });

  // Run the agent — this call is automatically traced
  const result = await run(agent, "What is OpenTelemetry?");

  console.log("Response:", result.finalOutput);
  console.log("OpenAI Agents traces sent to Azure Monitor");

  await shutdownMicrosoftOpenTelemetry();
}

main().catch(console.error);
