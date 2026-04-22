// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to enable LangChain instrumentation to trace GenAI operations.
 */

import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
} from "@microsoft/opentelemetry";
import { AzureChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
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
      langchain: {
        isContentRecordingEnabled: true,
      },
    },
  });

  // Create a LangChain chat model
  const model = new AzureChatOpenAI({
    model: "gpt-4o",
    temperature: 0,
    azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
    azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_INSTANCE_NAME,
    azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
    azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-06-01",
  });

  // Invoke the model — this call is automatically traced
  const response = await model.invoke([new HumanMessage("What is OpenTelemetry?")]);

  console.log("Response:", response.content);
  console.log("LangChain traces sent to Azure Monitor");

  await shutdownMicrosoftOpenTelemetry();
}

main().catch(console.error);
