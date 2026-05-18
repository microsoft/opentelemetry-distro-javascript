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

/**
 * Helper: creates baggage with gen_ai.operation.name set plus any additional entries.
 */
function createGenAiBaggage(
  operationName: string,
  extra?: Record<string, string>,
) {
  let baggage = propagation.createBaggage();
  baggage = baggage.setEntry(OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY, {
    value: operationName,
  });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      baggage = baggage.setEntry(key, { value });
    }
  }
  return baggage;
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

    it("should process spans from any tracer source when gen_ai.operation.name is present in baggage", () => {
      const baggage = createGenAiBaggage("chat", {
        [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
      });
      const ctx = propagation.setBaggage(context.active(), baggage);

      // Use a non-A365 tracer name (e.g. LangChain instrumentor)
      const tracer = provider.getTracer("microsoft-otel-langchain");
      const testSpan = tracer.startSpan("chat span", { kind: SpanKind.CLIENT }, ctx);
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
      expect(attrs[OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY]).toBe(
        OpenTelemetryConstants.TELEMETRY_SDK_NAME_VALUE,
      );
    });
  });

  describe("baggage to span attribute enrichment", () => {
    it("should copy generic attributes from baggage to span", () => {
      const baggage = createGenAiBaggage("chat", {
        [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
        [OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]: "agent-789",
      });

      const ctx = propagation.setBaggage(context.active(), baggage);

      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan("test-span", { kind: SpanKind.CLIENT }, ctx);
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
      expect(attrs[OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]).toBe("agent-789");
    });

    it("should copy sessionId from baggage to span", () => {
      const baggage = createGenAiBaggage("chat", {
        [OpenTelemetryConstants.SESSION_ID_KEY]: "session-abc",
      });

      const ctx = propagation.setBaggage(context.active(), baggage);
      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan("test-span", { kind: SpanKind.CLIENT }, ctx);
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.SESSION_ID_KEY]).toBe("session-abc");
    });

    it("should copy sessionDescription from baggage to span", () => {
      const baggage = createGenAiBaggage("chat", {
        [OpenTelemetryConstants.SESSION_DESCRIPTION_KEY]: "Test session description",
      });

      const ctx = propagation.setBaggage(context.active(), baggage);
      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan("test-span", { kind: SpanKind.CLIENT }, ctx);
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.SESSION_DESCRIPTION_KEY]).toBe(
        "Test session description",
      );
    });

    it("should copy invoke agent attributes for invoke_agent operations", () => {
      const baggage = createGenAiBaggage(
        OpenTelemetryConstants.INVOKE_AGENT_OPERATION_NAME,
        {
          [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
          [OpenTelemetryConstants.USER_ID_KEY]: "caller-456",
        },
      );

      const ctx = propagation.setBaggage(context.active(), baggage);

      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan("invoke_agent test", { kind: SpanKind.CLIENT }, ctx);
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
      expect(attrs[OpenTelemetryConstants.USER_ID_KEY]).toBe("caller-456");
    });

    it("should not overwrite existing span attributes", () => {
      const baggage = createGenAiBaggage("chat", {
        [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-from-baggage",
      });

      const ctx = propagation.setBaggage(context.active(), baggage);

      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan(
        "test-span",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-existing",
          },
        },
        ctx,
      );
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-existing");
    });

    it("should ignore empty baggage values", () => {
      let baggage = propagation.createBaggage();
      baggage = baggage.setEntry(OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY, {
        value: "chat",
      });
      baggage = baggage.setEntry(OpenTelemetryConstants.TENANT_ID_KEY, { value: "" });

      const ctx = propagation.setBaggage(context.active(), baggage);

      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan("test-span", { kind: SpanKind.CLIENT }, ctx);
      testSpan.end();

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0].attributes;
      expect(attrs[OpenTelemetryConstants.TENANT_ID_KEY]).toBeUndefined();
    });

    it("should set telemetry SDK attributes on GenAI spans", () => {
      const baggage = createGenAiBaggage("chat");
      const ctx = propagation.setBaggage(context.active(), baggage);
      const tracer = provider.getTracer("test");
      const testSpan = tracer.startSpan("test-span", { kind: SpanKind.CLIENT }, ctx);
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
        const baggage = createGenAiBaggage(op, {
          [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
          [OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]: "agent-abc",
        });
        const ctx = propagation.setBaggage(context.active(), baggage);
        const tracer = provider.getTracer("test");
        const span = tracer.startSpan(`${op} span`, { kind: SpanKind.CLIENT }, ctx);
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
