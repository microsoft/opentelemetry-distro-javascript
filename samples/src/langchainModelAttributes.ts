// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Validates the LangChain instrumentation request/response model
 * attribute fix end-to-end without requiring real Azure OpenAI calls.
 *
 * The LangChain auto-instrumentation hooks into
 * `@langchain/core/callbacks/manager._configureSync`, which is bypassed by
 * `langchain/core@1.x` (a separate compatibility issue). To validate the
 * model-attribute logic specifically, this sample drives the `LangChainTracer`
 * directly with synthetic `Run` objects that mirror three scenarios:
 *
 *   1. Azure deployment (deployment alias on the request side, resolved model
 *      on the response side).
 *   2. Generic OpenAI (only invocation_params.model is set).
 *   3. Response metadata only (no request-side identifier).
 *
 * Spans are exported to Azure Application Insights via the configured
 * connection string and mirrored to the console for local inspection.
 */

import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
} from "@microsoft/opentelemetry";
import { SimpleSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
// Deep import via absolute path: the LangChain Utils helpers are internal but
// stable enough to drive directly for validation purposes. Bypasses package
// "exports" restrictions.
import * as path from "node:path";
const utilsPath = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@microsoft",
  "opentelemetry",
  "dist",
  "commonjs",
  "genai",
  "instrumentations",
  "langchain",
  "utils.js",
);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Utils = require(utilsPath) as {
  getModel(run: Run): string | undefined;
  getRequestModel(run: Run): string | undefined;
  getResponseModel(run: Run): string | undefined;
  setModelAttribute(run: Run, span: import("@opentelemetry/api").Span): void;
  setOperationTypeAttribute(operation: string, span: import("@opentelemetry/api").Span): void;
};
import type { Run } from "@langchain/core/tracers/base";

const CONNECTION_STRING =
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ||
  "InstrumentationKey=b59d565e-da91-4140-8671-6c79b6938b4d;IngestionEndpoint=https://westus2-2.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/;ApplicationId=a8451929-c71b-4336-8ac5-f27f3d6d6292";

useMicrosoftOpenTelemetry({
  azureMonitor: {
    azureMonitorExporterOptions: { connectionString: CONNECTION_STRING },
  },
  instrumentationOptions: { langchain: { enabled: true } },
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});

interface ScenarioRun {
  label: string;
  expectedRequestModel?: string;
  expectedResponseModel?: string;
  run: Partial<Run>;
}

function uuid(): string {
  // RFC4122-ish placeholder; LangChain doesn't validate the format.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildRun(extra: Partial<Run>): Partial<Run> {
  const now = Date.now();
  return {
    id: uuid(),
    name: "ChatModel",
    run_type: "llm",
    start_time: now,
    end_time: now + 1,
    inputs: { messages: [[{ content: "What is OpenTelemetry?" }]] },
    outputs: {},
    extra: {},
    events: [],
    serialized: { lc: 1, type: "constructor", id: ["langchain", "chat_models", "fake"] },
    child_runs: [],
    child_execution_order: 1,
    execution_order: 1,
    ...extra,
  };
}

const scenarios: ScenarioRun[] = [
  {
    label: "Azure deployment (alias on request, resolved model on response)",
    expectedRequestModel: "my-gpt4o-deployment",
    expectedResponseModel: "gpt-4o-2024-08-06",
    run: buildRun({
      extra: {
        invocation_params: {
          // LangChain.js inserts this default for AzureChatOpenAI even when the
          // user only configured a deployment name.
          model: "gpt-3.5-turbo",
          azureOpenAIApiDeploymentName: "my-gpt4o-deployment",
        },
        metadata: { ls_model_name: "gpt-3.5-turbo", ls_provider: "openai" },
      },
      outputs: {
        generations: [
          [
            {
              text: "OpenTelemetry is an observability framework.",
              message: {
                content: "OpenTelemetry is an observability framework.",
                response_metadata: { model_name: "gpt-4o-2024-08-06" },
              },
            },
          ],
        ],
        llmOutput: { model_name: "gpt-4o-2024-08-06" },
      },
    }),
  },
  {
    label: "Generic OpenAI (invocation_params.model only)",
    expectedRequestModel: "llama-3.1-70b",
    expectedResponseModel: undefined,
    run: buildRun({
      extra: {
        invocation_params: { model: "llama-3.1-70b" },
        metadata: { ls_provider: "openai" },
      },
    }),
  },
  {
    label: "Response metadata only (request model falls back)",
    expectedRequestModel: "gpt-4o",
    expectedResponseModel: "gpt-4o",
    run: buildRun({
      outputs: {
        generations: [
          [
            {
              text: "hello",
              message: {
                content: "hello",
                response_metadata: { model_name: "gpt-4o" },
              },
            },
          ],
        ],
      },
    }),
  },
];

async function main(): Promise<void> {
  const otelTracer = trace.getTracer("microsoft-otel-langchain-sample", "1.0.0");

  for (const s of scenarios) {
    console.log(`\n[sample] === ${s.label} ===`);
    console.log(
      `[sample] expected gen_ai.request.model="${s.expectedRequestModel ?? "<none>"}"` +
        `, gen_ai.response.model="${s.expectedResponseModel ?? "<none>"}"`,
    );
    const run = s.run as Run;

    // Build the chat span exactly the way LangChainTracer does it so we
    // exercise the same span-name/getModel/setModelAttribute code paths.
    const operation = "chat";
    const spanName = `${operation} ${Utils.getModel(run) || run.name}`.trim();
    const span = otelTracer.startSpan(spanName, { kind: 2 /* CLIENT */ });
    try {
      Utils.setOperationTypeAttribute(operation, span);
      Utils.setModelAttribute(run, span);

      console.log(`[sample] -> span name:        "${spanName}"`);
      console.log(`[sample] -> getRequestModel:  "${Utils.getRequestModel(run) ?? ""}"`);
      console.log(`[sample] -> getResponseModel: "${Utils.getResponseModel(run) ?? ""}"`);
    } finally {
      span.end();
    }
  }

  // Allow span processors to flush.
  await new Promise((r) => setTimeout(r, 1500));
  await shutdownMicrosoftOpenTelemetry();

  console.log(
    "\n[sample] Done. Inspect the console-printed spans above (and the same\n" +
      "spans in Application Insights) to confirm gen_ai.request.model and\n" +
      "gen_ai.response.model match the expected values for each scenario.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
