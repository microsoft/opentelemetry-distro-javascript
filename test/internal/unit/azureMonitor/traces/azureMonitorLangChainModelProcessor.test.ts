// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, describe, it } from "vitest";
import type { Span as ApiSpan } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Run } from "@langchain/core/tracers/base";
import { AzureMonitorLangChainModelProcessor } from "../../../../../src/azureMonitor/traces/azureMonitorLangChainModelProcessor.js";
import {
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
} from "../../../../../src/genai/index.js";
import {
  _resetLangChainSpanEnrichersForTesting,
  _getLangChainSpanEnrichersForTesting,
} from "../../../../../src/genai/instrumentations/langchain/tracer.js";

const enricher = AzureMonitorLangChainModelProcessor._enricherForTesting;
const bridge = AzureMonitorLangChainModelProcessor._bridgeForTesting;

function makeApiSpan(): ApiSpan & { attrs: Record<string, unknown> } {
  // Bridge entries are keyed by object identity, so any unique object works
  // as a span identity for tests.
  const attrs: Record<string, unknown> = {};
  return {
    attrs,
    setAttribute(key: string, value: unknown) {
      attrs[key] = value;
      return this;
    },
  } as unknown as ApiSpan & { attrs: Record<string, unknown> };
}

function makeReadableSpan(
  name: string,
  attributes: Record<string, unknown>,
  identity?: object,
): ReadableSpan & { name: string; attributes: Record<string, unknown> } {
  // The processor mutates `name` and `attributes` directly via a casting
  // pattern, matching how the real SDK Span / ReadableSpan share the same
  // underlying object.
  const span = (identity ?? {}) as ReadableSpan & {
    name: string;
    attributes: Record<string, unknown>;
  };
  span.name = name;
  span.attributes = attributes;
  return span;
}

function makeRun(invocationParams: Record<string, unknown> | undefined): Run {
  return {
    id: "run-1",
    run_type: "llm",
    extra: invocationParams ? { invocation_params: invocationParams } : {},
  } as unknown as Run;
}

afterEach(() => {
  _resetLangChainSpanEnrichersForTesting();
});

describe("AzureMonitorLangChainModelProcessor", () => {
  describe("enricher registration", () => {
    it("constructing the processor registers exactly one enricher", () => {
      _resetLangChainSpanEnrichersForTesting();
      assert.strictEqual(_getLangChainSpanEnrichersForTesting().length, 0);
      new AzureMonitorLangChainModelProcessor();
      assert.strictEqual(_getLangChainSpanEnrichersForTesting().length, 1);
    });

    it("is idempotent across multiple processor instances (single registration by reference)", () => {
      _resetLangChainSpanEnrichersForTesting();
      new AzureMonitorLangChainModelProcessor();
      new AzureMonitorLangChainModelProcessor();
      new AzureMonitorLangChainModelProcessor();
      assert.strictEqual(_getLangChainSpanEnrichersForTesting().length, 1);
    });

    it("shutdown unregisters the enricher", async () => {
      _resetLangChainSpanEnrichersForTesting();
      const proc = new AzureMonitorLangChainModelProcessor();
      assert.strictEqual(_getLangChainSpanEnrichersForTesting().length, 1);
      await proc.shutdown();
      assert.strictEqual(_getLangChainSpanEnrichersForTesting().length, 0);
    });
  });

  describe("enricher (Azure deployment-alias extraction)", () => {
    it("captures azureOpenAIApiDeploymentName into the WeakMap bridge", () => {
      const span = makeApiSpan();
      enricher(
        makeRun({
          model: "gpt-3.5-turbo",
          azureOpenAIApiDeploymentName: "my-gpt4o-deployment",
        }),
        span,
      );
      assert.strictEqual(bridge.get(span as unknown as object), "my-gpt4o-deployment");
    });

    it("prefers azureOpenAIApiDeploymentName over azure_deployment over deployment_name", () => {
      const allThree = makeApiSpan();
      enricher(
        makeRun({
          azureOpenAIApiDeploymentName: "alias-1",
          azure_deployment: "alias-2",
          deployment_name: "alias-3",
        }),
        allThree,
      );
      assert.strictEqual(bridge.get(allThree as unknown as object), "alias-1");

      const azureDep = makeApiSpan();
      enricher(makeRun({ azure_deployment: "alias-2" }), azureDep);
      assert.strictEqual(bridge.get(azureDep as unknown as object), "alias-2");

      const deployName = makeApiSpan();
      enricher(makeRun({ deployment_name: "alias-3" }), deployName);
      assert.strictEqual(bridge.get(deployName as unknown as object), "alias-3");
    });

    it("skips empty / whitespace alias fields and falls through to the next candidate", () => {
      const span = makeApiSpan();
      enricher(
        makeRun({
          azureOpenAIApiDeploymentName: "",
          azure_deployment: "   ",
          deployment_name: "alias-3",
        }),
        span,
      );
      assert.strictEqual(bridge.get(span as unknown as object), "alias-3");
    });

    it("does NOT touch the span attribute namespace (no Azure-internal attribute leaks)", () => {
      const span = makeApiSpan();
      enricher(makeRun({ azureOpenAIApiDeploymentName: "my-gpt4o-deployment" }), span);
      assert.strictEqual(
        Object.keys(span.attrs).length,
        0,
        "enricher must not write any span attribute (bridge is a WeakMap)",
      );
    });

    it("captures nothing when no Azure deployment-alias field is present", () => {
      const span = makeApiSpan();
      enricher(makeRun({ model: "gpt-3.5-turbo" }), span);
      assert.strictEqual(bridge.get(span as unknown as object), undefined);
    });

    it("captures nothing when there are no invocation_params at all", () => {
      const span = makeApiSpan();
      enricher(makeRun(undefined), span);
      assert.strictEqual(bridge.get(span as unknown as object), undefined);
    });
  });

  describe("onEnd (consumes the WeakMap bridge)", () => {
    it("overrides gen_ai.request.model and rewrites chat span name when an alias was captured", () => {
      const proc = new AzureMonitorLangChainModelProcessor();
      const identity = {} as object;
      const apiSpan = makeApiSpan();
      enricher(
        makeRun({
          model: "gpt-3.5-turbo",
          azureOpenAIApiDeploymentName: "my-gpt4o-deployment",
        }),
        // The enricher and processor key off the same object identity in
        // production (SDK Span implements both interfaces). Use the same
        // identity here for both phases.
        identity as unknown as ApiSpan,
      );
      // Drive instrumentation-style attributes onto the readable span.
      void apiSpan;
      const readable = makeReadableSpan(
        "chat gpt-3.5-turbo",
        {
          [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo",
          [ATTR_GEN_AI_RESPONSE_MODEL]: "gpt-4o-2024-08-06",
        },
        identity,
      );

      proc.onEnd(readable);

      assert.strictEqual(readable.attributes[ATTR_GEN_AI_REQUEST_MODEL], "my-gpt4o-deployment");
      assert.strictEqual(readable.attributes[ATTR_GEN_AI_RESPONSE_MODEL], "gpt-4o-2024-08-06");
      assert.strictEqual(readable.name, "chat my-gpt4o-deployment");
      assert.strictEqual(
        bridge.get(identity),
        undefined,
        "bridge entry is dropped after consumption",
      );
    });

    it("is a no-op when no alias was captured for this span", () => {
      const proc = new AzureMonitorLangChainModelProcessor();
      const readable = makeReadableSpan("chat gpt-4o", {
        [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-4o",
        [ATTR_GEN_AI_RESPONSE_MODEL]: "gpt-4o-2024-08-06",
      });

      proc.onEnd(readable);

      assert.strictEqual(readable.attributes[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
      assert.strictEqual(readable.attributes[ATTR_GEN_AI_RESPONSE_MODEL], "gpt-4o-2024-08-06");
      assert.strictEqual(readable.name, "chat gpt-4o");
    });

    it("does not rewrite the span name for non-chat operations even when an alias is captured", () => {
      const proc = new AzureMonitorLangChainModelProcessor();
      const identity = {} as object;
      enricher(
        makeRun({ azureOpenAIApiDeploymentName: "my-deployment" }),
        identity as unknown as ApiSpan,
      );
      const readable = makeReadableSpan(
        "invoke_agent MyAgent",
        { [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo" },
        identity,
      );

      proc.onEnd(readable);

      assert.strictEqual(readable.attributes[ATTR_GEN_AI_REQUEST_MODEL], "my-deployment");
      assert.strictEqual(readable.name, "invoke_agent MyAgent");
    });

    it("populates gen_ai.request.model from the alias even when the instrumentation set none", () => {
      const proc = new AzureMonitorLangChainModelProcessor();
      const identity = {} as object;
      enricher(
        makeRun({ azureOpenAIApiDeploymentName: "my-gpt4o-deployment" }),
        identity as unknown as ApiSpan,
      );
      const readable = makeReadableSpan("chat ", {}, identity);

      proc.onEnd(readable);

      assert.strictEqual(readable.attributes[ATTR_GEN_AI_REQUEST_MODEL], "my-gpt4o-deployment");
    });

    it("tolerates spans without an attributes bag", () => {
      const proc = new AzureMonitorLangChainModelProcessor();
      const identity = {} as object;
      enricher(
        makeRun({ azureOpenAIApiDeploymentName: "my-deployment" }),
        identity as unknown as ApiSpan,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const readable = identity as any as ReadableSpan;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (readable as any).name = "chat foo";
      // No attributes property at all.
      proc.onEnd(readable);
      // Should not throw; name should still be rewritten because the chat
      // prefix matches.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.strictEqual((readable as any).name, "chat my-deployment");
    });
  });

  describe("end-to-end pipeline", () => {
    it("enricher captures alias from a Run; onEnd rewrites the readable span", () => {
      _resetLangChainSpanEnrichersForTesting();
      const proc = new AzureMonitorLangChainModelProcessor();
      const registered = _getLangChainSpanEnrichersForTesting();
      assert.strictEqual(registered.length, 1);

      // Simulate the LangChainTracer loop: invoke each registered enricher
      // with the live API span, then later hand the same object to onEnd as
      // a ReadableSpan.
      const identity = {} as object;
      registered[0](
        makeRun({
          model: "gpt-3.5-turbo",
          azureOpenAIApiDeploymentName: "my-gpt4o-deployment",
        }),
        identity as unknown as ApiSpan,
      );

      const readable = makeReadableSpan(
        "chat gpt-3.5-turbo",
        {
          [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo",
          [ATTR_GEN_AI_RESPONSE_MODEL]: "gpt-4o-2024-08-06",
        },
        identity,
      );
      proc.onEnd(readable);

      assert.strictEqual(readable.attributes[ATTR_GEN_AI_REQUEST_MODEL], "my-gpt4o-deployment");
      assert.strictEqual(readable.attributes[ATTR_GEN_AI_RESPONSE_MODEL], "gpt-4o-2024-08-06");
      assert.strictEqual(readable.name, "chat my-gpt4o-deployment");
    });
  });
});
