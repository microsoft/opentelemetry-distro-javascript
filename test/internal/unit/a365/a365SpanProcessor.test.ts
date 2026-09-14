// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { context, propagation, SpanKind } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import {
  A365SpanProcessor,
  OpenTelemetryConstants,
  GENERIC_ATTRIBUTES,
  INVOKE_AGENT_ATTRIBUTES,
} from "../../../../src/a365/index.js";

const INTERNAL_CUSTOM_KEYS_METADATA_KEY = "_internal.custom_keys";

/**
 * Helper: creates a baggage instance with the given entries.
 */
function createBaggage(entries: Record<string, string>) {
  let baggage = propagation.createBaggage();
  for (const [key, value] of Object.entries(entries)) {
    baggage = baggage.setEntry(key, { value });
  }
  return baggage;
}

/**
 * Helper: starts a GenAI span with `gen_ai.operation.name` as a span attribute
 * and the given baggage entries in context.
 */
function startGenAiSpan(
  provider: BasicTracerProvider,
  operationName: string,
  baggage: Record<string, string> = {},
  spanName?: string,
  attributes: Record<string, string> = {},
) {
  const bag = createBaggage(baggage);
  const ctx = propagation.setBaggage(context.active(), bag);
  const tracer = provider.getTracer("test");
  return tracer.startSpan(
    spanName ?? `${operationName} span`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY]: operationName,
        ...attributes,
      },
    },
    ctx,
  );
}

describe("A365SpanProcessor", () => {
  let provider: BasicTracerProvider;
  let processor: A365SpanProcessor;
  let memoryExporter: InMemorySpanExporter;

  beforeEach(() => {
    processor = new A365SpanProcessor();
    memoryExporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [processor, new SimpleSpanProcessor(memoryExporter)],
    });
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  describe("GenAI span filtering", () => {
    it("should not mutate spans without gen_ai.operation.name", () => {
      const baggageEntries = {
        [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
        [OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]: "agent-789",
      };

      let baggage = propagation.createBaggage();
      for (const [key, value] of Object.entries(baggageEntries)) {
        baggage = baggage.setEntry(key, { value });
      }

      const ctx = propagation.setBaggage(context.active(), baggage);

      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan("HTTP GET /api/data", { kind: SpanKind.CLIENT }, ctx);
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.GEN_AI_AGENT_NAME_KEY]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.SESSION_ID_KEY]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY]).toBeUndefined();
    });

    it("should not mutate spans when baggage has no gen_ai.operation.name even with other A365 baggage", () => {
      let baggage = propagation.createBaggage();
      baggage = baggage.setEntry(OpenTelemetryConstants.TENANT_ID_KEY, { value: "tenant-123" });
      baggage = baggage.setEntry(OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY, {
        value: "agent-abc",
      });
      baggage = baggage.setEntry(OpenTelemetryConstants.SESSION_ID_KEY, {
        value: "session-xyz",
      });

      const ctx = propagation.setBaggage(context.active(), baggage);

      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan("db-query", { kind: SpanKind.CLIENT }, ctx);
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.SESSION_ID_KEY]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_LANGUAGE_KEY]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_VERSION_KEY]).toBeUndefined();
    });

    it("should process spans that have gen_ai.operation.name as a span attribute", () => {
      // Baggage has no gen_ai.operation.name, but the span itself does
      let baggage = propagation.createBaggage();
      baggage = baggage.setEntry(OpenTelemetryConstants.TENANT_ID_KEY, { value: "tenant-123" });

      const ctx = propagation.setBaggage(context.active(), baggage);

      const tracer = provider.getTracer("microsoft-otel-openai-agents");
      const testSpan = tracer.startSpan(
        "invoke_agent test",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            [OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY]: "invoke_agent",
          },
        },
        ctx,
      );
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY]).toBe(
        OpenTelemetryConstants.TELEMETRY_SDK_NAME_VALUE,
      );
    });

    it("should process spans from any tracer source when gen_ai.operation.name span attribute is set", () => {
      const bag = createBaggage({
        [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
      });
      const ctx = propagation.setBaggage(context.active(), bag);

      // Use a non-A365 tracer name (e.g. LangChain instrumentor)
      const tracer = provider.getTracer("microsoft-otel-langchain");
      const testSpan = tracer.startSpan(
        "chat span",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            [OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY]: "chat",
          },
        },
        ctx,
      );
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY]).toBe(
        OpenTelemetryConstants.TELEMETRY_SDK_NAME_VALUE,
      );
    });

    it("should not mutate spans with an unknown gen_ai.operation.name value", () => {
      const bag = createBaggage({
        [INTERNAL_CUSTOM_KEYS_METADATA_KEY]: "custom.one",
        [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
        "custom.one": "value-1",
      });
      const ctx = propagation.setBaggage(context.active(), bag);

      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan(
        "unknown-op span",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            [OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY]: "unknown_operation",
          },
        },
        ctx,
      );
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs["custom.one"]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBeUndefined();
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY]).toBeUndefined();
    });
  });

  describe("baggage to span attribute enrichment", () => {
    it("should copy generic attributes from baggage to span", () => {
      const testSpan = startGenAiSpan(provider, "chat", {
        [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
        [OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]: "agent-789",
      });
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
      expect(attrs[OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]).toBe("agent-789");
    });

    it("should copy sessionId from baggage to span", () => {
      const testSpan = startGenAiSpan(provider, "chat", {
        [OpenTelemetryConstants.SESSION_ID_KEY]: "session-abc",
      });
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes[OpenTelemetryConstants.SESSION_ID_KEY]).toBe("session-abc");
    });

    it("should copy sessionDescription from baggage to span", () => {
      const testSpan = startGenAiSpan(provider, "chat", {
        [OpenTelemetryConstants.SESSION_DESCRIPTION_KEY]: "Test session description",
      });
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes[OpenTelemetryConstants.SESSION_DESCRIPTION_KEY]).toBe(
        "Test session description",
      );
    });

    it("should copy invoke agent attributes for invoke_agent operations", () => {
      const testSpan = startGenAiSpan(
        provider,
        OpenTelemetryConstants.INVOKE_AGENT_OPERATION_NAME,
        {
          [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
          [OpenTelemetryConstants.USER_ID_KEY]: "caller-456",
        },
      );
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
      expect(attrs[OpenTelemetryConstants.USER_ID_KEY]).toBe("caller-456");
    });

    it("should not overwrite existing span attributes", () => {
      const bag = createBaggage({
        [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-from-baggage",
      });
      const ctx = propagation.setBaggage(context.active(), bag);

      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan(
        "test-span",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            [OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY]: "chat",
            [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-existing",
          },
        },
        ctx,
      );
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-existing");
    });

    it("should ignore empty baggage values", () => {
      const bag = createBaggage({
        [OpenTelemetryConstants.TENANT_ID_KEY]: "",
      });
      const ctx = propagation.setBaggage(context.active(), bag);

      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan(
        "test-span",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            [OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY]: "chat",
          },
        },
        ctx,
      );
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes[OpenTelemetryConstants.TENANT_ID_KEY]).toBeUndefined();
    });

    it("should set telemetry SDK attributes on GenAI spans", () => {
      const testSpan = startGenAiSpan(provider, "chat");
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY]).toBe(
        OpenTelemetryConstants.TELEMETRY_SDK_NAME_VALUE,
      );
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_LANGUAGE_KEY]).toBe(
        OpenTelemetryConstants.TELEMETRY_SDK_LANGUAGE_VALUE,
      );
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_VERSION_KEY]).toBe(
        OpenTelemetryConstants.TELEMETRY_SDK_VERSION_VALUE,
      );
    });

    it("should enrich all four GenAI operation types", () => {
      const operations = [
        OpenTelemetryConstants.INVOKE_AGENT_OPERATION_NAME,
        OpenTelemetryConstants.EXECUTE_TOOL_OPERATION_NAME,
        OpenTelemetryConstants.OUTPUT_MESSAGES_OPERATION_NAME,
        OpenTelemetryConstants.CHAT_OPERATION_NAME,
      ];

      for (const op of operations) {
        memoryExporter.reset();
        const span = startGenAiSpan(provider, op, {
          [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
          [OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]: "agent-abc",
        });
        span.end();

        const spans = memoryExporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        const attrs = spans[0].attributes;
        expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
        expect(attrs[OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]).toBe("agent-abc");
        expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY]).toBe(
          OpenTelemetryConstants.TELEMETRY_SDK_NAME_VALUE,
        );
      }
    });
  });

  describe("registered custom baggage propagation", () => {
    it("should copy registered custom baggage attributes from metadata", () => {
      const testSpan = startGenAiSpan(provider, "chat", {
        [INTERNAL_CUSTOM_KEYS_METADATA_KEY]: "custom.one,custom.two",
        "custom.one": "value-1",
        "custom.two": "value-2",
        "custom.three": "value-3",
      });
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs["custom.one"]).toBe("value-1");
      expect(attrs["custom.two"]).toBe("value-2");
      expect(attrs["custom.three"]).toBeUndefined();
      expect(attrs[INTERNAL_CUSTOM_KEYS_METADATA_KEY]).toBeUndefined();
    });

    it("should trim registered custom baggage metadata and ignore empty entries", () => {
      const testSpan = startGenAiSpan(provider, "chat", {
        [INTERNAL_CUSTOM_KEYS_METADATA_KEY]: "  custom.one , , custom.two ,,  ",
        "custom.one": "value-1",
        "custom.two": "value-2",
      });
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs["custom.one"]).toBe("value-1");
      expect(attrs["custom.two"]).toBe("value-2");
    });

    it("should not copy unmarked custom baggage attributes", () => {
      const testSpan = startGenAiSpan(provider, "chat", {
        "custom.one": "value-1",
      });
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes["custom.one"]).toBeUndefined();
    });

    it("should keep existing span attributes when registered custom baggage collides", () => {
      const testSpan = startGenAiSpan(
        provider,
        "chat",
        {
          [INTERNAL_CUSTOM_KEYS_METADATA_KEY]: "custom.one",
          "custom.one": "value-from-baggage",
        },
        undefined,
        {
          "custom.one": "value-existing",
        },
      );
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes["custom.one"]).toBe("value-existing");
    });

    it("should never copy the custom metadata attribute itself", () => {
      const testSpan = startGenAiSpan(provider, "chat", {
        [INTERNAL_CUSTOM_KEYS_METADATA_KEY]:
          `custom.one,${INTERNAL_CUSTOM_KEYS_METADATA_KEY}`,
        "custom.one": "value-1",
      });
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs["custom.one"]).toBe("value-1");
      expect(attrs[INTERNAL_CUSTOM_KEYS_METADATA_KEY]).toBeUndefined();
    });

    it("should not allow registered custom baggage to overwrite telemetry SDK attributes", () => {
      const testSpan = startGenAiSpan(provider, "chat", {
        [INTERNAL_CUSTOM_KEYS_METADATA_KEY]:
          "telemetry.sdk.name,telemetry.sdk.language,telemetry.sdk.version",
        [OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY]: "spoofed-sdk",
        [OpenTelemetryConstants.TELEMETRY_SDK_LANGUAGE_KEY]: "spoofed-language",
        [OpenTelemetryConstants.TELEMETRY_SDK_VERSION_KEY]: "0.0.0",
      });
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY]).toBe(
        OpenTelemetryConstants.TELEMETRY_SDK_NAME_VALUE,
      );
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_LANGUAGE_KEY]).toBe(
        OpenTelemetryConstants.TELEMETRY_SDK_LANGUAGE_VALUE,
      );
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_VERSION_KEY]).toBe(
        OpenTelemetryConstants.TELEMETRY_SDK_VERSION_VALUE,
      );
    });
  });

  describe("attribute registry application", () => {
    it("should apply all generic attributes", () => {
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.TENANT_ID_KEY);
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY);
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.SESSION_ID_KEY);
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.USER_ID_KEY);
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.USER_NAME_KEY);
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.USER_EMAIL_KEY);
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.GEN_AI_CALLER_CLIENT_IP_KEY);
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.GEN_AI_AGENT_EMAIL_KEY);
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.CHANNEL_NAME_KEY);
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.CHANNEL_LINK_KEY);
      expect(GENERIC_ATTRIBUTES).not.toContain("correlation.id");
    });

    it("should apply invoke agent specific attributes", () => {
      expect(INVOKE_AGENT_ATTRIBUTES).toContain(OpenTelemetryConstants.GEN_AI_CALLER_AGENT_ID_KEY);
      expect(INVOKE_AGENT_ATTRIBUTES).toContain(
        OpenTelemetryConstants.GEN_AI_CALLER_AGENT_EMAIL_KEY,
      );
      expect(INVOKE_AGENT_ATTRIBUTES).toContain(
        OpenTelemetryConstants.GEN_AI_CALLER_AGENT_VERSION_KEY,
      );
    });

    it("should include blueprint ID and agent version in generic attributes", () => {
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.GEN_AI_AGENT_BLUEPRINT_ID_KEY);
      expect(GENERIC_ATTRIBUTES).toContain(OpenTelemetryConstants.GEN_AI_AGENT_VERSION_KEY);
    });
  });

  describe("processor lifecycle", () => {
    it("should shutdown gracefully", async () => {
      await expect(processor.shutdown()).resolves.toBeUndefined();
    });

    it("should force flush gracefully", async () => {
      await expect(processor.forceFlush()).resolves.toBeUndefined();
    });
  });
});
