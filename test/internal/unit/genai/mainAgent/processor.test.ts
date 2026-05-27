// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { logs as logsApi } from "@opentelemetry/api-logs";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";

import {
  GEN_AI_MAIN_AGENT_CONVERSATION_ID_KEY,
  GEN_AI_MAIN_AGENT_ID_KEY,
  GEN_AI_MAIN_AGENT_NAME_KEY,
  GEN_AI_MAIN_AGENT_VERSION_KEY,
  GenAIMainAgentLogRecordProcessor,
  GenAIMainAgentSpanProcessor,
} from "../../../../../src/genai/mainAgent/index.js";
import {
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  GEN_AI_OPERATION_INVOKE_AGENT,
} from "../../../../../src/genai/semconv.js";

const ATTR_GEN_AI_AGENT_VERSION = "gen_ai.agent.version";

describe("GenAIMainAgentSpanProcessor", () => {
  let provider: BasicTracerProvider;
  let memoryExporter: InMemorySpanExporter;

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new GenAIMainAgentSpanProcessor(), new SimpleSpanProcessor(memoryExporter)],
    });
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  describe("onStart propagation from parent", () => {
    it("does nothing when there is no parent span", () => {
      const tracer = provider.getTracer("test");
      const span = tracer.startSpan("chat", { kind: SpanKind.CLIENT });
      span.end();

      const finished = memoryExporter.getFinishedSpans();
      expect(finished).toHaveLength(1);
      const attrs = finished[0].attributes;
      expect(attrs[GEN_AI_MAIN_AGENT_NAME_KEY]).toBeUndefined();
      expect(attrs[GEN_AI_MAIN_AGENT_ID_KEY]).toBeUndefined();
    });

    it("falls back to gen_ai.agent.* and gen_ai.conversation.id on the parent", () => {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("invoke_agent main", {
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
          [ATTR_GEN_AI_AGENT_NAME]: "main",
          [ATTR_GEN_AI_AGENT_ID]: "id-1",
          [ATTR_GEN_AI_AGENT_VERSION]: "v1",
          [ATTR_GEN_AI_CONVERSATION_ID]: "conv-1",
        },
      });
      const parentCtx = trace.setSpan(context.active(), parent);
      const child = tracer.startSpan("chat sub", { kind: SpanKind.CLIENT }, parentCtx);
      child.end();
      parent.end();

      const finished = memoryExporter.getFinishedSpans();
      const childSpan = finished.find((s) => s.name === "chat sub")!;
      expect(childSpan.attributes[GEN_AI_MAIN_AGENT_NAME_KEY]).toBe("main");
      expect(childSpan.attributes[GEN_AI_MAIN_AGENT_ID_KEY]).toBe("id-1");
      expect(childSpan.attributes[GEN_AI_MAIN_AGENT_VERSION_KEY]).toBe("v1");
      expect(childSpan.attributes[GEN_AI_MAIN_AGENT_CONVERSATION_ID_KEY]).toBe("conv-1");
    });

    it("primary microsoft.gen_ai.main_agent.* attrs on parent win over fallback gen_ai.agent.*", () => {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("invoke_agent middle", {
        attributes: {
          [GEN_AI_MAIN_AGENT_NAME_KEY]: "primary",
          [ATTR_GEN_AI_AGENT_NAME]: "middle-fallback",
        },
      });
      const parentCtx = trace.setSpan(context.active(), parent);
      const child = tracer.startSpan("execute_tool sub", {}, parentCtx);
      child.end();
      parent.end();

      const finished = memoryExporter.getFinishedSpans();
      const childSpan = finished.find((s) => s.name === "execute_tool sub")!;
      expect(childSpan.attributes[GEN_AI_MAIN_AGENT_NAME_KEY]).toBe("primary");
    });

    it("propagates across multiple span levels (main -> sub-agent -> chat)", () => {
      const tracer = provider.getTracer("test");
      const main = tracer.startSpan("invoke_agent main", {
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
          [ATTR_GEN_AI_AGENT_NAME]: "main",
          [ATTR_GEN_AI_AGENT_ID]: "id-main",
        },
      });
      const ctxMain = trace.setSpan(context.active(), main);
      const sub = tracer.startSpan(
        "invoke_agent sub",
        {
          attributes: {
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
            [ATTR_GEN_AI_AGENT_NAME]: "sub",
          },
        },
        ctxMain,
      );
      const ctxSub = trace.setSpan(context.active(), sub);
      const chat = tracer.startSpan("chat gpt", {}, ctxSub);
      chat.end();
      sub.end();
      main.end();

      const finished = memoryExporter.getFinishedSpans();
      const subSpan = finished.find((s) => s.name === "invoke_agent sub")!;
      const chatSpan = finished.find((s) => s.name === "chat gpt")!;
      expect(subSpan.attributes[GEN_AI_MAIN_AGENT_NAME_KEY]).toBe("main");
      expect(subSpan.attributes[GEN_AI_MAIN_AGENT_ID_KEY]).toBe("id-main");
      expect(chatSpan.attributes[GEN_AI_MAIN_AGENT_NAME_KEY]).toBe("main");
      expect(chatSpan.attributes[GEN_AI_MAIN_AGENT_ID_KEY]).toBe("id-main");
    });
  });

  describe("onEnd self-copy for top-level invoke_agent", () => {
    it("copies own gen_ai.agent.* onto microsoft.gen_ai.main_agent.* when no parent enriched it", () => {
      const tracer = provider.getTracer("test");
      const span = tracer.startSpan("invoke_agent root", {
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
          [ATTR_GEN_AI_AGENT_NAME]: "root-name",
          [ATTR_GEN_AI_AGENT_ID]: "root-id",
          [ATTR_GEN_AI_AGENT_VERSION]: "root-v",
          [ATTR_GEN_AI_CONVERSATION_ID]: "root-conv",
        },
      });
      span.end();

      const finished = memoryExporter.getFinishedSpans();
      const attrs = finished[0].attributes;
      expect(attrs[GEN_AI_MAIN_AGENT_NAME_KEY]).toBe("root-name");
      expect(attrs[GEN_AI_MAIN_AGENT_ID_KEY]).toBe("root-id");
      expect(attrs[GEN_AI_MAIN_AGENT_VERSION_KEY]).toBe("root-v");
      expect(attrs[GEN_AI_MAIN_AGENT_CONVERSATION_ID_KEY]).toBe("root-conv");
    });

    it("does not self-copy when operation is not invoke_agent", () => {
      const tracer = provider.getTracer("test");
      const span = tracer.startSpan("chat top", {
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: "chat",
          [ATTR_GEN_AI_AGENT_NAME]: "shouldnt-copy",
        },
      });
      span.end();

      const attrs = memoryExporter.getFinishedSpans()[0].attributes;
      expect(attrs[GEN_AI_MAIN_AGENT_NAME_KEY]).toBeUndefined();
    });

    it("skips self-copy when a main_agent.* attribute is already present", () => {
      const tracer = provider.getTracer("test");
      const span = tracer.startSpan("invoke_agent already-set", {
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
          [GEN_AI_MAIN_AGENT_NAME_KEY]: "already",
          [ATTR_GEN_AI_AGENT_NAME]: "self",
        },
      });
      span.end();

      const attrs = memoryExporter.getFinishedSpans()[0].attributes;
      expect(attrs[GEN_AI_MAIN_AGENT_NAME_KEY]).toBe("already");
    });
  });
});

describe("GenAIMainAgentLogRecordProcessor", () => {
  let provider: BasicTracerProvider;
  let logProvider: LoggerProvider;
  let memoryLogExporter: InMemoryLogRecordExporter;

  let ctxManager: AsyncLocalStorageContextManager;

  beforeEach(() => {
    ctxManager = new AsyncLocalStorageContextManager();
    ctxManager.enable();
    context.setGlobalContextManager(ctxManager);

    memoryLogExporter = new InMemoryLogRecordExporter();
    logProvider = new LoggerProvider({
      processors: [
        new GenAIMainAgentLogRecordProcessor(),
        new SimpleLogRecordProcessor(memoryLogExporter),
      ],
    });
    logsApi.setGlobalLoggerProvider(logProvider);
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await logProvider.shutdown();
    await provider.shutdown();
    logsApi.disable();
    trace.disable();
    context.disable();
  });

  it("copies main_agent.* attributes from the active span onto emitted log records", () => {
    const tracer = provider.getTracer("test");
    const span = tracer.startSpan("invoke_agent root", {
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
        [GEN_AI_MAIN_AGENT_NAME_KEY]: "main-from-span",
        [GEN_AI_MAIN_AGENT_ID_KEY]: "id-from-span",
      },
    });

    context.with(trace.setSpan(context.active(), span), () => {
      const logger = logsApi.getLogger("test");
      logger.emit({ body: "hello" });
    });
    span.end();

    const records = memoryLogExporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const attrs = records[0].attributes ?? {};
    expect(attrs[GEN_AI_MAIN_AGENT_NAME_KEY]).toBe("main-from-span");
    expect(attrs[GEN_AI_MAIN_AGENT_ID_KEY]).toBe("id-from-span");
  });

  it("does nothing when no active span", () => {
    const logger = logsApi.getLogger("test");
    logger.emit({ body: "no span" });

    const records = memoryLogExporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const attrs = records[0].attributes ?? {};
    expect(attrs[GEN_AI_MAIN_AGENT_NAME_KEY]).toBeUndefined();
  });
});
