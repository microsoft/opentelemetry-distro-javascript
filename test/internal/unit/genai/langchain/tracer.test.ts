// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, describe, it, vi } from "vitest";
import {
  Span,
  SpanContext,
  SpanKind,
  SpanStatusCode,
  Tracer,
  TraceFlags,
} from "@opentelemetry/api";
import type { Run } from "@langchain/core/tracers/base";
import { LangChainTracer } from "../../../../../src/genai/instrumentations/langchain/tracer.js";
import {
  ATTR_ERROR_MESSAGE,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
} from "../../../../../src/genai/index.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    name: "test-run",
    run_type: "llm",
    start_time: Date.now(),
    end_time: Date.now() + 100,
    serialized: {},
    inputs: {},
    outputs: {},
    execution_order: 1,
    child_execution_order: 1,
    child_runs: [],
    tags: [],
    events: [],
    ...overrides,
  } as unknown as Run;
}

function makeLangGraphRun(overrides: Partial<Run> = {}): Run {
  return makeRun({
    run_type: "chain",
    name: "MyAgent",
    serialized: {
      id: ["langchain", "langgraph", "pregel", "CompiledStateGraph"],
    },
    ...overrides,
  });
}

function createMockSpan(): Span & {
  attrs: Record<string, unknown>;
  ended: boolean;
  endTime?: unknown;
  statusObj?: { code: SpanStatusCode };
} {
  const spanCtx: SpanContext = {
    traceId: "aaaa0000bbbb0000cccc0000dddd0000",
    spanId: "1111000022220000",
    traceFlags: TraceFlags.SAMPLED,
  };
  const mockSpan = {
    attrs: {} as Record<string, unknown>,
    ended: false,
    endTime: undefined as unknown,
    statusObj: undefined as { code: SpanStatusCode } | undefined,
    setAttribute: vi.fn(function (this: typeof mockSpan, key: string, val: unknown) {
      this.attrs[key] = val;
      return this;
    }),
    setStatus: vi.fn(function (this: typeof mockSpan, status: { code: SpanStatusCode }) {
      this.statusObj = status;
    }),
    end: vi.fn(function (this: typeof mockSpan, endTime?: unknown) {
      this.ended = true;
      this.endTime = endTime;
    }),
    spanContext: vi.fn(() => spanCtx),
    recordException: vi.fn(),
    addEvent: vi.fn(),
    isRecording: vi.fn(() => true),
    updateName: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
  };
  return mockSpan as unknown as Span & {
    attrs: Record<string, unknown>;
    ended: boolean;
    endTime?: unknown;
    statusObj?: { code: SpanStatusCode };
  };
}

function createMockTracer(): Tracer & {
  lastSpan: ReturnType<typeof createMockSpan> | undefined;
  spans: ReturnType<typeof createMockSpan>[];
} {
  const mockTracer = {
    lastSpan: undefined as ReturnType<typeof createMockSpan> | undefined,
    spans: [] as ReturnType<typeof createMockSpan>[],
    startSpan: vi.fn(function (
      this: typeof mockTracer,
      _name: string,
      _options?: unknown,
      _ctx?: unknown,
    ) {
      const span = createMockSpan();
      this.lastSpan = span;
      this.spans.push(span);
      return span;
    }),
  };
  return mockTracer as unknown as Tracer & {
    lastSpan: ReturnType<typeof createMockSpan> | undefined;
    spans: ReturnType<typeof createMockSpan>[];
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LangChainTracer", () => {
  describe("constructor", () => {
    it("creates a tracer with default options", () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      assert.strictEqual(lct.name, "OpenTelemetryLangChainTracer");
    });
  });

  describe("onRunCreate / startTracing", () => {
    it("creates a span for an LLM run", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun({ name: "gpt-4o" });
      await lct.onRunCreate(run);
      assert.ok(tracer.lastSpan, "should have created a span");
      assert.ok(
        (tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls[0][0].includes("chat"),
        "span name should include operation type",
      );
    });

    it("creates a span for a tool run", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun({ run_type: "tool", name: "search", serialized: { name: "search" } });
      await lct.onRunCreate(run);
      const spanName = (tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls[0][0];
      assert.ok(spanName.includes("execute_tool"), "span name should include execute_tool");
      assert.ok(spanName.includes("search"), "span name should include tool name");
    });

    it("creates a span for a LangGraph agent run", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeLangGraphRun({ name: "WeatherBot" });
      await lct.onRunCreate(run);
      const spanName = (tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls[0][0];
      assert.ok(spanName.includes("invoke_agent"), "span name should include invoke_agent");
      assert.ok(spanName.includes("WeatherBot"), "span name should include agent name");
    });

    it("skips internal runs tagged langsmith:hidden", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun({ tags: ["langsmith:hidden"] });
      await lct.onRunCreate(run);
      assert.strictEqual(tracer.lastSpan, undefined);
    });

    it("skips Branch-prefixed runs", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun({ name: "BranchDecision", run_type: "chain", serialized: {} });
      await lct.onRunCreate(run);
      assert.strictEqual(tracer.lastSpan, undefined);
    });

    it("skips unknown operation types", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun({ run_type: "retriever" as Run["run_type"] });
      await lct.onRunCreate(run);
      assert.strictEqual(tracer.lastSpan, undefined);
    });

    it("sets langchain as provider name attribute", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun();
      await lct.onRunCreate(run);
      const attrs = (tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls[0][1]?.attributes;
      assert.strictEqual(attrs?.[ATTR_GEN_AI_PROVIDER_NAME], "langchain");
    });

    it("sets span kind to INTERNAL", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun();
      await lct.onRunCreate(run);
      const kind = (tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls[0][1]?.kind;
      assert.strictEqual(kind, SpanKind.INTERNAL);
    });
  });

  describe("_endTrace", () => {
    it("ends the span with OK status on success", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun();
      await lct.onRunCreate(run);
      const span = tracer.lastSpan!;
      await (lct as unknown as { _endTrace(run: Run): Promise<void> })._endTrace(run);
      assert.strictEqual(span.ended, true);
      assert.strictEqual(span.statusObj?.code, SpanStatusCode.OK);
    });

    it("sets ERROR status when run has an error", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun({ error: "Something went wrong" });
      await lct.onRunCreate(run);
      const span = tracer.lastSpan!;
      await (lct as unknown as { _endTrace(run: Run): Promise<void> })._endTrace(run);
      assert.strictEqual(span.statusObj?.code, SpanStatusCode.ERROR);
      assert.ok(
        (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
          (c: unknown[]) => c[0] === ATTR_ERROR_MESSAGE && c[1] === "Something went wrong",
        ),
      );
    });

    it("sets operation type attribute", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun({ run_type: "llm" });
      await lct.onRunCreate(run);
      const span = tracer.lastSpan!;
      await (lct as unknown as { _endTrace(run: Run): Promise<void> })._endTrace(run);
      assert.ok(
        (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.some(
          (c: unknown[]) => c[0] === ATTR_GEN_AI_OPERATION_NAME && c[1] === "chat",
        ),
      );
    });

    it("does not set content attributes when content recording is disabled", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer, { isContentRecordingEnabled: false });
      const run = makeRun({
        run_type: "tool",
        name: "my_tool",
        serialized: { name: "my_tool" },
        inputs: { input: "test" },
      });
      await lct.onRunCreate(run);
      const span = tracer.lastSpan!;
      await (lct as unknown as { _endTrace(run: Run): Promise<void> })._endTrace(run);
      const attrKeys = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0],
      );
      assert.ok(!attrKeys.includes("gen_ai.tool.call.arguments"), "should not set tool arguments");
      assert.ok(!attrKeys.includes("gen_ai.input.messages"), "should not set input messages");
    });

    it("sets content attributes when content recording is enabled", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer, { isContentRecordingEnabled: true });
      const run = makeRun({
        run_type: "tool",
        name: "my_tool",
        serialized: { name: "my_tool" },
        inputs: { input: "test-input" },
      });
      await lct.onRunCreate(run);
      const span = tracer.lastSpan!;
      await (lct as unknown as { _endTrace(run: Run): Promise<void> })._endTrace(run);
      const attrKeys = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0],
      );
      assert.ok(attrKeys.includes("gen_ai.tool.name"), "should set tool name");
    });

    it("cleans up run from tracking after end", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);
      const run = makeRun();
      await lct.onRunCreate(run);
      await (lct as unknown as { _endTrace(run: Run): Promise<void> })._endTrace(run);
      // A second _endTrace should be a no-op (no span found)
      const spanCount = tracer.spans.length;
      await (lct as unknown as { _endTrace(run: Run): Promise<void> })._endTrace(run);
      // Should not end any additional spans
      assert.strictEqual(tracer.spans.length, spanCount);
    });
  });

  describe("parent-child span linking", () => {
    it("links child spans to parent spans", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);

      const parentRun = makeLangGraphRun({ id: "parent-1" });
      await lct.onRunCreate(parentRun);

      const childRun = makeRun({ id: "child-1", parent_run_id: "parent-1" });
      await lct.onRunCreate(childRun);

      // The child span should have been started with a context that includes the parent span
      const startSpanCalls = (tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls;
      assert.strictEqual(startSpanCalls.length, 2);
      // The 3rd argument to startSpan is the context — it should not be the bare active context
      const childCtxArg = startSpanCalls[1][2];
      assert.ok(childCtxArg, "child span should receive a parent context");
    });
  });

  describe("MAX_RUNS cap", () => {
    it("stops creating spans after MAX_RUNS is reached", async () => {
      const tracer = createMockTracer();
      const lct = new LangChainTracer(tracer);

      // Access the private MAX_RUNS value — it's 10_000 but we can't create that many.
      // Instead, fill the runs map directly and test the guard.
      const runsMap = (lct as unknown as { runs: Map<string, unknown> }).runs;
      for (let i = 0; i < 10_000; i++) {
        runsMap.set(`fill-${i}`, {});
      }

      const run = makeRun({ id: "overflow-run" });
      await lct.onRunCreate(run);

      // After reaching MAX_RUNS, startSpan should not be called for the overflow run
      const startSpanCalls = (tracer.startSpan as ReturnType<typeof vi.fn>).mock.calls;
      assert.strictEqual(startSpanCalls.length, 0, "should not create span when MAX_RUNS exceeded");
    });
  });
});
