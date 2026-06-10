// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, describe, it, vi } from "vitest";
import { Tracer } from "@opentelemetry/api";
import {
  LangChainTraceInstrumentor,
  addTracerToHandlers,
} from "../../../../../src/genai/instrumentations/langchain/langchainTraceInstrumentor.js";
import { LangChainTracer } from "../../../../../src/genai/instrumentations/langchain/tracer.js";

function createMockTracer(): Tracer {
  return {
    startSpan: vi.fn(),
  } as unknown as Tracer;
}

afterEach(() => {
  LangChainTraceInstrumentor.resetInstance();
  vi.restoreAllMocks();
});

describe("LangChainTraceInstrumentor", () => {
  describe("instrument", () => {
    it("patches CallbackManager._configureSync", () => {
      const configureSyncOriginal = vi.fn();
      const mockModule = {
        CallbackManager: {
          _configureSync: configureSyncOriginal,
        },
      };

      LangChainTraceInstrumentor.instrument(mockModule as any);

      // After instrumenting, _configureSync should be wrapped
      assert.notStrictEqual(
        mockModule.CallbackManager._configureSync,
        configureSyncOriginal,
        "_configureSync should be wrapped",
      );
    });

    it("does nothing when CallbackManager is missing", () => {
      const mockModule = {} as any;
      // Should not throw
      LangChainTraceInstrumentor.instrument(mockModule);
    });

    // Regression test for the startup race fixed by binding `_tracerCtor`
    // statically at field-declaration time. Previously the tracer ctor was
    // resolved via a dynamic `import("./tracer.js")` whose `.then(...)`
    // callback ran on a later microtask. Any `_configureSync` call landing
    // in that window (typically the very first compiled-graph `invoke` after
    // distro startup) silently fell through with no tracer attached,
    // dropping the outer wrapper span and fragmenting the trace.
    // This test asserts the wrapped `_configureSync` attaches a
    // `LangChainTracer` on its very first synchronous invocation — i.e.,
    // without awaiting any microtask after `instrument(...)`.
    it("attaches a LangChainTracer synchronously on the first _configureSync call", () => {
      const configureSyncOriginal = vi.fn();
      const mockModule = {
        CallbackManager: {
          _configureSync: configureSyncOriginal,
        },
      };

      LangChainTraceInstrumentor.instrument(mockModule as any);

      // Invoke the wrapped _configureSync immediately — no awaits, no
      // microtask flush. This is the scenario that previously dropped the
      // outer wrapper span.
      mockModule.CallbackManager._configureSync(undefined as any);

      assert.strictEqual(configureSyncOriginal.mock.calls.length, 1);
      const handlersArg = configureSyncOriginal.mock.calls[0][0];
      assert.ok(Array.isArray(handlersArg), "handlers should be coerced into an array");
      assert.strictEqual(handlersArg.length, 1);
      assert.ok(
        handlersArg[0] instanceof LangChainTracer,
        "LangChainTracer should be attached on the first call, not deferred to a later microtask",
      );
    });
  });

  describe("enable / disable", () => {
    it("throws when not initialized", () => {
      assert.throws(() => LangChainTraceInstrumentor.enable(), /must be initialized first/);
    });

    it("throws disable when not initialized", () => {
      assert.throws(() => LangChainTraceInstrumentor.disable(), /must be initialized first/);
    });

    it("enable and disable do not throw after initialization", () => {
      const mockModule = {
        CallbackManager: {
          _configureSync: vi.fn(),
        },
      };
      LangChainTraceInstrumentor.instrument(mockModule as any);

      // Should not throw
      LangChainTraceInstrumentor.enable();
      LangChainTraceInstrumentor.disable();
    });
  });

  describe("resetInstance", () => {
    it("allows re-initialization after reset", () => {
      const mockModule = {
        CallbackManager: {
          _configureSync: vi.fn(),
        },
      };
      LangChainTraceInstrumentor.instrument(mockModule as any);
      LangChainTraceInstrumentor.resetInstance();

      // Should be able to instrument again
      const mockModule2 = {
        CallbackManager: {
          _configureSync: vi.fn(),
        },
      };
      LangChainTraceInstrumentor.instrument(mockModule2 as any);
    });
  });
});

describe("addTracerToHandlers", () => {
  it("creates a new array with LangChainTracer when handlers is null", () => {
    const tracer = createMockTracer();
    const result = addTracerToHandlers(tracer, undefined, LangChainTracer);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 1);
    assert.ok(result[0] instanceof LangChainTracer);
  });

  it("appends LangChainTracer to existing array handlers", () => {
    const tracer = createMockTracer();
    const existingHandler = { handleLLMStart: vi.fn() };
    const handlers = [existingHandler] as any;
    const result = addTracerToHandlers(tracer, handlers, LangChainTracer);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 2);
    assert.ok(result[1] instanceof LangChainTracer);
  });

  it("does not add duplicate LangChainTracer to array handlers", () => {
    const tracer = createMockTracer();
    const existingTracer = new LangChainTracer(tracer);
    const handlers = [existingTracer] as any;
    const result = addTracerToHandlers(tracer, handlers, LangChainTracer);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 1, "should not duplicate");
  });

  it("adds LangChainTracer to CallbackManager-style handlers", () => {
    const tracer = createMockTracer();
    const addHandlerSpy = vi.fn();
    const handlers = {
      inheritableHandlers: [] as any[],
      addHandler: addHandlerSpy,
    } as any;
    addTracerToHandlers(tracer, handlers, LangChainTracer);
    assert.ok(addHandlerSpy.mock.calls.length === 1);
    assert.ok(addHandlerSpy.mock.calls[0][0] instanceof LangChainTracer);
    assert.strictEqual(addHandlerSpy.mock.calls[0][1], true, "should be inheritable");
  });

  it("does not add duplicate to CallbackManager-style handlers", () => {
    const tracer = createMockTracer();
    const existingTracer = new LangChainTracer(tracer);
    const addHandlerSpy = vi.fn();
    const handlers = {
      inheritableHandlers: [existingTracer],
      addHandler: addHandlerSpy,
    } as any;
    addTracerToHandlers(tracer, handlers, LangChainTracer);
    assert.strictEqual(addHandlerSpy.mock.calls.length, 0, "should not add duplicate");
  });

  it("accepts a custom tracer constructor", () => {
    const tracer = createMockTracer();
    const result = addTracerToHandlers(tracer, undefined, LangChainTracer);
    assert.ok(Array.isArray(result));
    assert.ok(result[0] instanceof LangChainTracer);
  });
});
