// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { context, ROOT_CONTEXT, SpanKind, trace, TraceFlags } from "@opentelemetry/api";
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
const PROJECT_IDS = {
  "gen_ai.azure_ai_project.id": "/subscriptions/sub/resourceGroups/rg/providers/x/projects/azure",
  "microsoft.foundry.project.id":
    "/subscriptions/sub/resourceGroups/rg/providers/x/projects/foundry",
};
const PROJECT_ID_KEYS = Object.keys(PROJECT_IDS);

describe("GenAIMainAgentSpanProcessor", () => {
  let provider: BasicTracerProvider;
  let memoryExporter: InMemorySpanExporter;
  let processor: GenAIMainAgentSpanProcessor;

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter();
    processor = new GenAIMainAgentSpanProcessor();
    provider = new BasicTracerProvider({
      spanProcessors: [processor, new SimpleSpanProcessor(memoryExporter)],
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

  describe("project ID propagation", () => {
    it.each(PROJECT_ID_KEYS)("copies %s at start without synthesizing the other key", (key) => {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("server", {
        kind: SpanKind.SERVER,
        attributes: { [key]: "parent-project" },
      });
      const child = tracer.startSpan(
        "invoke_agent child",
        { attributes: { [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT } },
        trace.setSpan(ROOT_CONTEXT, parent),
      );

      expect(child).toHaveProperty("attributes", {
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
        [key]: "parent-project",
      });
      child.end();
      parent.end();
      expect(memoryExporter.getFinishedSpans()[0].attributes).toEqual({
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
        [key]: "parent-project",
      });
    });

    it("propagates both IDs independently through nested spans alongside main-agent attributes", () => {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("server", {
        attributes: { ...PROJECT_IDS, [ATTR_GEN_AI_AGENT_NAME]: "main" },
      });
      const child = tracer.startSpan(
        "invoke_agent child",
        {
          attributes: {
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
            [ATTR_GEN_AI_AGENT_NAME]: "child",
          },
        },
        trace.setSpan(ROOT_CONTEXT, parent),
      );
      const grandchild = tracer.startSpan("chat", {}, trace.setSpan(ROOT_CONTEXT, child));

      for (const span of [child, grandchild]) {
        expect(span).toHaveProperty(
          "attributes",
          expect.objectContaining({ ...PROJECT_IDS, [GEN_AI_MAIN_AGENT_NAME_KEY]: "main" }),
        );
      }
      grandchild.end();
      child.end();
      parent.end();
      for (const span of memoryExporter.getFinishedSpans().slice(0, 2)) {
        expect(span.attributes).toMatchObject({
          ...PROJECT_IDS,
          [GEN_AI_MAIN_AGENT_NAME_KEY]: "main",
        });
      }
    });

    it.each([GEN_AI_OPERATION_INVOKE_AGENT, "chat", "execute_tool"])(
      "recovers late project IDs for %s even when main-agent attributes are already present",
      (operation) => {
        const tracer = provider.getTracer("test");
        const parent = tracer.startSpan("server", {
          attributes: { [ATTR_GEN_AI_AGENT_NAME]: "main" },
        });
        const child = tracer.startSpan(
          operation,
          { attributes: { [ATTR_GEN_AI_OPERATION_NAME]: operation } },
          trace.setSpan(ROOT_CONTEXT, parent),
        );
        expect(child).toHaveProperty("attributes", {
          [ATTR_GEN_AI_OPERATION_NAME]: operation,
          [GEN_AI_MAIN_AGENT_NAME_KEY]: "main",
        });

        parent.setAttributes(PROJECT_IDS);
        child.end();
        parent.end();

        expect(memoryExporter.getFinishedSpans()[0].attributes).toMatchObject({
          ...PROJECT_IDS,
          [GEN_AI_MAIN_AGENT_NAME_KEY]: "main",
        });
      },
    );

    it.each(PROJECT_ID_KEYS)("recovers only %s when stamped after child start", (key) => {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("server");
      const child = tracer.startSpan("chat", {}, trace.setSpan(ROOT_CONTEXT, parent));
      parent.setAttribute(key, "late-project");
      // The reference must remain usable even if the parent ends first.
      parent.end();
      child.end();

      expect(memoryExporter.getFinishedSpans()[1].attributes).toEqual({
        [key]: "late-project",
      });
    });

    it.each(PROJECT_ID_KEYS)(
      "preserves an existing %s at end while recovering the missing key",
      (key) => {
        const tracer = provider.getTracer("test");
        const parent = tracer.startSpan("server");
        const child = tracer.startSpan(
          "invoke_agent child",
          {
            attributes: {
              [key]: "child-project",
              [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT,
              [ATTR_GEN_AI_AGENT_NAME]: "child",
            },
          },
          trace.setSpan(ROOT_CONTEXT, parent),
        );
        parent.setAttributes(PROJECT_IDS);
        child.end();
        parent.end();

        expect(memoryExporter.getFinishedSpans()[0].attributes).toMatchObject({
          ...PROJECT_IDS,
          [key]: "child-project",
          [GEN_AI_MAIN_AGENT_NAME_KEY]: "child",
        });
      },
    );

    it("matches Python's parent precedence at start and preserves those IDs at end", () => {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("server", { attributes: PROJECT_IDS });
      const child = tracer.startSpan(
        "chat",
        { attributes: Object.fromEntries(PROJECT_ID_KEYS.map((key) => [key, "child-project"])) },
        trace.setSpan(ROOT_CONTEXT, parent),
      );
      parent.setAttributes(Object.fromEntries(PROJECT_ID_KEYS.map((key) => [key, "changed"])));
      child.end();
      parent.end();

      expect(memoryExporter.getFinishedSpans()[0].attributes).toEqual(PROJECT_IDS);
    });

    it("does not derive project IDs from other parent attributes", () => {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("server", {
        attributes: {
          [ATTR_GEN_AI_AGENT_ID]: "agent-id",
          "server.address": "project.services.ai.azure.com",
          "microsoft.foundry.project.name": "project",
        },
      });
      const child = tracer.startSpan("chat", {}, trace.setSpan(ROOT_CONTEXT, parent));
      child.end();
      parent.end();

      for (const key of PROJECT_ID_KEYS) {
        expect(memoryExporter.getFinishedSpans()[0].attributes[key]).toBeUndefined();
      }
    });

    it.each([
      ROOT_CONTEXT,
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      }),
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId: "00000000000000000000000000000000",
        spanId: "0000000000000000",
        traceFlags: TraceFlags.NONE,
      }),
    ])(
      "handles absent, remote, and invalid parents without inventing IDs (%#)",
      (parentContext) => {
        const child = provider.getTracer("test").startSpan("chat", {}, parentContext);
        child.end();

        expect(memoryExporter.getFinishedSpans()[0].attributes).toEqual({});
      },
    );

    it("does not add IDs after the child has already been exported", () => {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("server");
      const child = tracer.startSpan("chat", {}, trace.setSpan(ROOT_CONTEXT, parent));
      child.end();
      parent.setAttributes(PROJECT_IDS);
      parent.end();

      expect(memoryExporter.getFinishedSpans()[0].attributes).toEqual({});
    });

    it("releases pending parent references on shutdown", async () => {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("server");
      const child = tracer.startSpan("chat", {}, trace.setSpan(ROOT_CONTEXT, parent));
      await processor.shutdown();
      parent.setAttributes(PROJECT_IDS);
      child.end();
      parent.end();

      expect(memoryExporter.getFinishedSpans()[0].attributes).toEqual({});
    });

    it("respects SDK attribute limits when recovering late IDs", async () => {
      const exporter = new InMemorySpanExporter();
      const limitedProvider = new BasicTracerProvider({
        spanLimits: { attributeCountLimit: 1 },
        spanProcessors: [new GenAIMainAgentSpanProcessor(), new SimpleSpanProcessor(exporter)],
      });
      try {
        const tracer = limitedProvider.getTracer("test");
        const parent = tracer.startSpan("server");
        const child = tracer.startSpan(
          "chat",
          { attributes: { existing: "keep" } },
          trace.setSpan(ROOT_CONTEXT, parent),
        );
        parent.setAttribute(PROJECT_ID_KEYS[0], "late-project");
        child.end();
        parent.end();

        const [exported] = exporter.getFinishedSpans();
        expect(exported.attributes).toEqual({ existing: "keep" });
        expect(exported.droppedAttributesCount).toBe(1);
      } finally {
        await limitedProvider.shutdown();
      }
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
        new SimpleLogRecordProcessor({ exporter: memoryLogExporter }),
      ],
    });
    logsApi.setGlobalLoggerProvider(logProvider);
    provider = new BasicTracerProvider({ spanProcessors: [new GenAIMainAgentSpanProcessor()] });
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
    for (const key of PROJECT_ID_KEYS) {
      expect(attrs[key]).toBeUndefined();
    }
  });

  it.each(PROJECT_ID_KEYS)("copies only the existing %s to logs", (key) => {
    const span = provider.getTracer("test").startSpan("server", {
      attributes: { [key]: "project-from-span", unrelated: "skip" },
    });
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      logsApi.getLogger("test").emit({
        body: "project log",
        attributes: { existing: "keep", [key]: "project-from-log" },
      });
    });
    span.end();

    expect(memoryLogExporter.getFinishedLogRecords()[0].attributes).toEqual({
      existing: "keep",
      [key]: "project-from-span",
    });
  });

  it.each(["active", "explicit"])(
    "copies both IDs and main-agent attributes from a child span using %s context",
    (contextSource) => {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("server", {
        attributes: { ...PROJECT_IDS, [ATTR_GEN_AI_AGENT_NAME]: "main", unrelated: "skip" },
      });
      const child = tracer.startSpan(
        "invoke_agent child",
        { attributes: { [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_INVOKE_AGENT } },
        trace.setSpan(ROOT_CONTEXT, parent),
      );
      const childContext = trace.setSpan(ROOT_CONTEXT, child);
      const logger = logsApi.getLogger("test");
      if (contextSource === "active") {
        context.with(childContext, () => logger.emit({ body: "child log" }));
      } else {
        const other = tracer.startSpan("other", {
          attributes: Object.fromEntries(PROJECT_ID_KEYS.map((key) => [key, "wrong-project"])),
        });
        context.with(trace.setSpan(ROOT_CONTEXT, other), () => {
          logger.emit({ body: "child log", context: childContext });
        });
        other.end();
      }
      child.end();
      parent.end();

      expect(memoryLogExporter.getFinishedLogRecords()[0].attributes).toEqual({
        ...PROJECT_IDS,
        [GEN_AI_MAIN_AGENT_NAME_KEY]: "main",
      });
    },
  );

  it("does not invent project IDs on logs from an unstamped span", () => {
    const span = provider.getTracer("test").startSpan("server", {
      attributes: { [GEN_AI_MAIN_AGENT_NAME_KEY]: "main" },
    });
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      logsApi.getLogger("test").emit({ body: "no project" });
    });
    span.end();

    expect(memoryLogExporter.getFinishedLogRecords()[0].attributes).toEqual({
      [GEN_AI_MAIN_AGENT_NAME_KEY]: "main",
    });
  });
});
