// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  BasicTracerProvider,
} from "@opentelemetry/sdk-trace-base";
import { trace, type ProxyTracerProvider } from "@opentelemetry/api";
import { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } from "../../../src/index.js";
import { LangChainTraceInstrumentor } from "../../../src/genai/instrumentations/langchain/langchainTraceInstrumentor.js";
import { ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_CHAT } from "../../../src/genai/index.js";

function makeLangChainRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "llm-1",
    name: "ChatOpenAI",
    run_type: "llm",
    start_time: Date.now(),
    end_time: Date.now() + 50,
    serialized: {},
    inputs: {
      messages: [[{ role: "user", content: "hello" }]],
    },
    outputs: {
      generations: [
        [
          {
            message: {
              role: "assistant",
              content: "hi",
              usage_metadata: { input_tokens: 10, output_tokens: 5 },
              kwargs: { response_metadata: { model_name: "gpt-4o" } },
            },
          },
        ],
      ],
    },
    extra: {
      metadata: { ls_model_name: "gpt-4o", ls_provider: "OpenAI" },
    },
    execution_order: 1,
    child_execution_order: 1,
    child_runs: [],
    tags: [],
    events: [],
    ...overrides,
  };
}

async function flushGlobalTracerProvider(): Promise<void> {
  const provider = (
    trace.getTracerProvider() as ProxyTracerProvider
  ).getDelegate() as BasicTracerProvider;
  await provider.forceFlush();
}

describe("GenAI distro integration", () => {
  const exporter = new InMemorySpanExporter();
  const originalConfigureSync = (CallbackManager as any)._configureSync;

  afterEach(async () => {
    await shutdownMicrosoftOpenTelemetry().catch(() => {});
    exporter.reset();
    (CallbackManager as any)._configureSync = originalConfigureSync;
    // Explicit reset keeps singleton instrumentors from leaking across tests.
    LangChainTraceInstrumentor.resetInstance();
    vi.restoreAllMocks();
  });

  it("wires LangChain via distro init and emits spans with microsoft-otel-langchain scope", async () => {
    useMicrosoftOpenTelemetry({
      tracesPerSecond: 0,
      samplingRatio: 1,
      azureMonitor: { enabled: false },
      enableConsoleExporters: false,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      instrumentationOptions: {
        openaiAgents: { enabled: false },
        langchain: { enabled: true, isContentRecordingEnabled: true },
      },
    });

    await vi.waitFor(() => {
      const manager = CallbackManager.configure([], []);
      const hasLangChainTracer = manager.inheritableHandlers.some(
        (h: any) => h?.name === "OpenTelemetryLangChainTracer",
      );
      expect(hasLangChainTracer).toBe(true);
    });

    const manager = CallbackManager.configure([], []);
    const langChainTracer = manager.inheritableHandlers.find(
      (h: any) => h?.name === "OpenTelemetryLangChainTracer",
    ) as any;

    const run = makeLangChainRun();
    await langChainTracer.onRunCreate(run);
    await langChainTracer._endTrace(run);
    await flushGlobalTracerProvider();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const chatSpan = spans.find(
      (s) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === GEN_AI_OPERATION_CHAT,
    );
    expect(chatSpan).toBeDefined();
    expect(chatSpan?.instrumentationScope.name).toBe("microsoft-otel-langchain");
  });
});
