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
    const result = addTracerToHandlers(tracer, undefined);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 1);
    assert.ok(result[0] instanceof LangChainTracer);
  });

  it("appends LangChainTracer to existing array handlers", () => {
    const tracer = createMockTracer();
    const existingHandler = { handleLLMStart: vi.fn() };
    const handlers = [existingHandler] as any;
    const result = addTracerToHandlers(tracer, handlers);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 2);
    assert.ok(result[1] instanceof LangChainTracer);
  });

  it("does not add duplicate LangChainTracer to array handlers", () => {
    const tracer = createMockTracer();
    const existingTracer = new LangChainTracer(tracer);
    const handlers = [existingTracer] as any;
    const result = addTracerToHandlers(tracer, handlers);
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
    addTracerToHandlers(tracer, handlers);
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
    addTracerToHandlers(tracer, handlers);
    assert.strictEqual(addHandlerSpy.mock.calls.length, 0, "should not add duplicate");
  });

  it("passes content recording option through", () => {
    const tracer = createMockTracer();
    const result = addTracerToHandlers(tracer, undefined, { isContentRecordingEnabled: true });
    assert.ok(Array.isArray(result));
    assert.ok(result[0] instanceof LangChainTracer);
  });
});
