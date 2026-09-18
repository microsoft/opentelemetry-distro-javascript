// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  BasicTracerProvider,
} from "@opentelemetry/sdk-trace-base";
import { trace, type ProxyTracerProvider } from "@opentelemetry/api";
import * as OpenAIAgents from "@openai/agents";
import {
  BaggageBuilder,
  OpenTelemetryConstants,
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
} from "../../../src/index.js";
import { OpenAIAgentsTraceInstrumentor } from "../../../src/genai/instrumentations/openai/openAIAgentsTraceInstrumentor.js";
import { ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_CHAT } from "../../../src/genai/index.js";

async function flushGlobalTracerProvider(): Promise<void> {
  const provider = (
    trace.getTracerProvider() as ProxyTracerProvider
  ).getDelegate() as BasicTracerProvider;
  await provider.forceFlush();
}

describe("OpenAI Agents distro integration", () => {
  const exporter = new InMemorySpanExporter();

  afterEach(async () => {
    await shutdownMicrosoftOpenTelemetry().catch(() => {});
    exporter.reset();
    try {
      OpenAIAgentsTraceInstrumentor.disable();
    } catch {
      // Best-effort teardown: disable may fail if the instrumentor was never enabled.
    }
    OpenAIAgentsTraceInstrumentor.resetInstance();
    vi.restoreAllMocks();
  });

  it.each(["  custom-openai-scope  "])(
    "wires OpenAI Agents via distro init with exact tracer name %j",
    async (tracerName) => {
      useMicrosoftOpenTelemetry({
        tracesPerSecond: 0,
        samplingRatio: 1,
        a365: {
          enabled: true,
          tokenResolver: () => "token",
        },
        azureMonitor: { enabled: false },
        enableConsoleExporters: false,
        spanProcessors: [new SimpleSpanProcessor(exporter)],
        instrumentationOptions: {
          openaiAgents: {
            enabled: true,
            tracerName,
            isContentRecordingEnabled: true,
          },
          langchain: { enabled: false },
        },
      });

      // OpenAI instrumentor initialization is kicked off asynchronously during distro startup.
      await vi.waitFor(() => {
        expect(() => OpenAIAgentsTraceInstrumentor.enable()).not.toThrow();
      });

      await vi.waitFor(() => {
        expect(OpenAIAgents.getCurrentTrace()).toBeNull();
      });

      exporter.reset();
      OpenAIAgentsTraceInstrumentor.enable();
      const baggageScope = new BaggageBuilder()
        .tenantId("tenant-123")
        .customAttribute("custom.scope", "openai")
        .build();

      await baggageScope.run(async () => {
        await OpenAIAgents.withTrace("genai-openai-integration", async () => {
          await OpenAIAgents.withGenerationSpan(
            async () => {
              return;
            },
            {
              spanData: {
                model: "gpt-4o",
                usage: { input_tokens: 10, output_tokens: 5 },
                input: [{ role: "user", content: "hello" }],
                output: [{ role: "assistant", content: "hi" }],
              },
            } as any,
          );
        });
      });

      await flushGlobalTracerProvider();
      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(0);
      const chatSpan = spans.find(
        (s) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === GEN_AI_OPERATION_CHAT,
      );
      expect(chatSpan).toBeDefined();
      expect(chatSpan?.instrumentationScope.name).toBe(tracerName);
      expect(chatSpan?.attributes[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
      expect(chatSpan?.attributes["custom.scope"]).toBe("openai");
    },
  );
});
