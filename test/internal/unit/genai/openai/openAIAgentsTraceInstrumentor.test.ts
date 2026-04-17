// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, describe, it, vi } from "vitest";
import { OpenAIAgentsTraceInstrumentor } from "../../../../../src/genai/instrumentations/openai/openAIAgentsTraceInstrumentor.js";

// vi.mock is hoisted above imports by Vitest
vi.mock("@openai/agents", () => ({
  setTraceProcessors: vi.fn(),
  setTracingDisabled: vi.fn(),
}));

afterEach(() => {
  OpenAIAgentsTraceInstrumentor.resetInstance();
  vi.restoreAllMocks();
});

describe("OpenAIAgentsTraceInstrumentor", () => {
  describe("instrument", () => {
    it("does not throw when called", () => {
      // Should not throw
      OpenAIAgentsTraceInstrumentor.instrument();
    });

    it("accepts configuration options", () => {
      OpenAIAgentsTraceInstrumentor.instrument({
        isContentRecordingEnabled: true,
        suppressInvokeAgentInput: true,
      });
    });
  });

  describe("enable / disable", () => {
    it("throws when not initialized", () => {
      assert.throws(() => OpenAIAgentsTraceInstrumentor.enable(), /must be initialized first/);
    });

    it("throws disable when not initialized", () => {
      assert.throws(() => OpenAIAgentsTraceInstrumentor.disable(), /must be initialized first/);
    });

    it("enable and disable do not throw after initialization", () => {
      OpenAIAgentsTraceInstrumentor.instrument();

      // Should not throw
      OpenAIAgentsTraceInstrumentor.enable();
      OpenAIAgentsTraceInstrumentor.disable();
    });
  });

  describe("resetInstance", () => {
    it("allows re-initialization after reset", () => {
      OpenAIAgentsTraceInstrumentor.instrument();
      OpenAIAgentsTraceInstrumentor.resetInstance();

      // Should be able to instrument again
      OpenAIAgentsTraceInstrumentor.instrument();
    });
  });
});
