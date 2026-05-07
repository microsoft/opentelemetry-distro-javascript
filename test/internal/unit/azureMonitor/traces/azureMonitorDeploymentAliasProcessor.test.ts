// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, describe, it } from "vitest";
import type { Span as ApiSpan } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  AzureMonitorDeploymentAliasProcessor,
  setDeploymentAliasForSpan,
} from "../../../../../src/azureMonitor/traces/azureMonitorDeploymentAliasProcessor.js";
import {
  azureLangChainDeploymentAliasEnricher,
  registerAzureLangChainDeploymentAliasEnricher,
} from "../../../../../src/azureMonitor/traces/azureLangChainDeploymentAliasEnricher.js";
import {
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
} from "../../../../../src/genai/index.js";
import { getRegisteredSpanEnrichers } from "../../../../../src/genai/spanEnricherRegistry.js";

const cleanups: Array<() => void> = [];
function track<T extends () => void>(unregister: T | undefined): T | undefined {
  if (unregister) cleanups.push(unregister);
  return unregister;
}
afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeApiSpan(): ApiSpan & { attrs: Record<string, unknown> } {
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
  const span = (identity ?? {}) as ReadableSpan & {
    name: string;
    attributes: Record<string, unknown>;
  };
  span.name = name;
  span.attributes = attributes;
  return span;
}

/**
 * Drives the processor's observable behaviour for an alias attached to a
 * span: returns the resulting `gen_ai.request.model` and span name after
 * `onEnd` runs. Used in lieu of inspecting the module-private WeakMap so we
 * don't need a test-only helper in the source module.
 */
function aliasObservedThroughProcessor(
  proc: AzureMonitorDeploymentAliasProcessor,
  identity: object,
  initialName = "chat gpt-3.5-turbo",
  initialAttributes: Record<string, unknown> = {
    [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo",
  },
): { name: string; requestModel: unknown } {
  const readable = makeReadableSpan(initialName, { ...initialAttributes }, identity);
  proc.onEnd(readable);
  return {
    name: readable.name,
    requestModel: readable.attributes[ATTR_GEN_AI_REQUEST_MODEL],
  };
}

describe("AzureMonitorDeploymentAliasProcessor (generic)", () => {
  describe("setDeploymentAliasForSpan", () => {
    it("makes the alias observable to the processor on the same span identity", () => {
      const proc = new AzureMonitorDeploymentAliasProcessor();
      const identity = {} as object;
      setDeploymentAliasForSpan(identity as unknown as ApiSpan, "my-deployment");

      const result = aliasObservedThroughProcessor(proc, identity);
      assert.strictEqual(result.requestModel, "my-deployment");
      assert.strictEqual(result.name, "chat my-deployment");
    });

    it("trims whitespace before storing", () => {
      const proc = new AzureMonitorDeploymentAliasProcessor();
      const identity = {} as object;
      setDeploymentAliasForSpan(identity as unknown as ApiSpan, "   my-deployment   ");

      const result = aliasObservedThroughProcessor(proc, identity);
      assert.strictEqual(result.requestModel, "my-deployment");
      assert.strictEqual(result.name, "chat my-deployment");
    });

    it("ignores empty / whitespace-only aliases", () => {
      const proc = new AzureMonitorDeploymentAliasProcessor();
      const identity = {} as object;
      setDeploymentAliasForSpan(identity as unknown as ApiSpan, "   ");
      setDeploymentAliasForSpan(identity as unknown as ApiSpan, "");

      const result = aliasObservedThroughProcessor(proc, identity);
      assert.strictEqual(
        result.requestModel,
        "gpt-3.5-turbo",
        "no override happened — empty values were ignored",
      );
      assert.strictEqual(result.name, "chat gpt-3.5-turbo");
    });
  });

  describe("onEnd", () => {
    it("overrides gen_ai.request.model and rewrites chat span name when an alias was associated", () => {
      const proc = new AzureMonitorDeploymentAliasProcessor();
      const identity = {} as object;
      setDeploymentAliasForSpan(identity as unknown as ApiSpan, "my-gpt4o-deployment");

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

    it("consumes the alias on first onEnd (subsequent onEnd is a no-op)", () => {
      const proc = new AzureMonitorDeploymentAliasProcessor();
      const identity = {} as object;
      setDeploymentAliasForSpan(identity as unknown as ApiSpan, "my-deployment");

      // First call applies the alias.
      const first = aliasObservedThroughProcessor(proc, identity);
      assert.strictEqual(first.requestModel, "my-deployment");

      // Second call on a different readable wrapping the same identity should
      // not re-apply (alias was consumed).
      const second = aliasObservedThroughProcessor(proc, identity);
      assert.strictEqual(second.requestModel, "gpt-3.5-turbo");
      assert.strictEqual(second.name, "chat gpt-3.5-turbo");
    });

    it("is a no-op when no alias was associated", () => {
      const proc = new AzureMonitorDeploymentAliasProcessor();
      const readable = makeReadableSpan("chat gpt-4o", {
        [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-4o",
        [ATTR_GEN_AI_RESPONSE_MODEL]: "gpt-4o-2024-08-06",
      });

      proc.onEnd(readable);

      assert.strictEqual(readable.attributes[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
      assert.strictEqual(readable.attributes[ATTR_GEN_AI_RESPONSE_MODEL], "gpt-4o-2024-08-06");
      assert.strictEqual(readable.name, "chat gpt-4o");
    });

    it("does not rewrite span name for non-chat operations", () => {
      const proc = new AzureMonitorDeploymentAliasProcessor();
      const identity = {} as object;
      setDeploymentAliasForSpan(identity as unknown as ApiSpan, "my-deployment");
      const readable = makeReadableSpan(
        "invoke_agent MyAgent",
        { [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo" },
        identity,
      );

      proc.onEnd(readable);

      assert.strictEqual(readable.attributes[ATTR_GEN_AI_REQUEST_MODEL], "my-deployment");
      assert.strictEqual(readable.name, "invoke_agent MyAgent");
    });

    it("populates gen_ai.request.model from the alias even when the span had none set", () => {
      const proc = new AzureMonitorDeploymentAliasProcessor();
      const identity = {} as object;
      setDeploymentAliasForSpan(identity as unknown as ApiSpan, "my-gpt4o-deployment");
      const readable = makeReadableSpan("chat ", {}, identity);

      proc.onEnd(readable);

      assert.strictEqual(readable.attributes[ATTR_GEN_AI_REQUEST_MODEL], "my-gpt4o-deployment");
    });

    it("tolerates spans without an attributes bag", () => {
      const proc = new AzureMonitorDeploymentAliasProcessor();
      const identity = {} as object;
      setDeploymentAliasForSpan(identity as unknown as ApiSpan, "my-deployment");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const readable = identity as any as ReadableSpan;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (readable as any).name = "chat foo";
      proc.onEnd(readable);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.strictEqual((readable as any).name, "chat my-deployment");
    });
  });
});

describe("azureLangChainDeploymentAliasEnricher", () => {
  it("captures azureOpenAIApiDeploymentName and the processor applies it", () => {
    const proc = new AzureMonitorDeploymentAliasProcessor();
    const identity = {} as object;
    azureLangChainDeploymentAliasEnricher(
      {
        extra: {
          invocation_params: {
            model: "gpt-3.5-turbo",
            azureOpenAIApiDeploymentName: "my-gpt4o-deployment",
          },
        },
      },
      identity as unknown as ApiSpan,
    );

    const result = aliasObservedThroughProcessor(proc, identity);
    assert.strictEqual(result.requestModel, "my-gpt4o-deployment");
    assert.strictEqual(result.name, "chat my-gpt4o-deployment");
  });

  it("prefers azureOpenAIApiDeploymentName over azure_deployment over deployment_name", () => {
    const proc = new AzureMonitorDeploymentAliasProcessor();

    const allThree = {} as object;
    azureLangChainDeploymentAliasEnricher(
      {
        extra: {
          invocation_params: {
            azureOpenAIApiDeploymentName: "alias-1",
            azure_deployment: "alias-2",
            deployment_name: "alias-3",
          },
        },
      },
      allThree as unknown as ApiSpan,
    );
    assert.strictEqual(aliasObservedThroughProcessor(proc, allThree).requestModel, "alias-1");

    const azureDep = {} as object;
    azureLangChainDeploymentAliasEnricher(
      { extra: { invocation_params: { azure_deployment: "alias-2" } } },
      azureDep as unknown as ApiSpan,
    );
    assert.strictEqual(aliasObservedThroughProcessor(proc, azureDep).requestModel, "alias-2");

    const deployName = {} as object;
    azureLangChainDeploymentAliasEnricher(
      { extra: { invocation_params: { deployment_name: "alias-3" } } },
      deployName as unknown as ApiSpan,
    );
    assert.strictEqual(aliasObservedThroughProcessor(proc, deployName).requestModel, "alias-3");
  });

  it("skips empty / whitespace alias fields and falls through", () => {
    const proc = new AzureMonitorDeploymentAliasProcessor();
    const identity = {} as object;
    azureLangChainDeploymentAliasEnricher(
      {
        extra: {
          invocation_params: {
            azureOpenAIApiDeploymentName: "",
            azure_deployment: "   ",
            deployment_name: "alias-3",
          },
        },
      },
      identity as unknown as ApiSpan,
    );
    assert.strictEqual(aliasObservedThroughProcessor(proc, identity).requestModel, "alias-3");
  });

  it("does NOT touch the span attribute namespace", () => {
    const span = makeApiSpan();
    azureLangChainDeploymentAliasEnricher(
      { extra: { invocation_params: { azureOpenAIApiDeploymentName: "alias" } } },
      span,
    );
    assert.strictEqual(Object.keys(span.attrs).length, 0);
  });

  it("captures nothing when no Azure deployment-alias field is present", () => {
    const proc = new AzureMonitorDeploymentAliasProcessor();
    const identity = {} as object;
    azureLangChainDeploymentAliasEnricher(
      { extra: { invocation_params: { model: "gpt-3.5-turbo" } } },
      identity as unknown as ApiSpan,
    );
    assert.strictEqual(
      aliasObservedThroughProcessor(proc, identity).requestModel,
      "gpt-3.5-turbo",
      "no override — request model stays as the initial value",
    );
  });

  it("captures nothing when there are no invocation_params at all", () => {
    const proc = new AzureMonitorDeploymentAliasProcessor();
    const identity = {} as object;
    azureLangChainDeploymentAliasEnricher({}, identity as unknown as ApiSpan);
    assert.strictEqual(aliasObservedThroughProcessor(proc, identity).requestModel, "gpt-3.5-turbo");
  });

  it("tolerates an undefined run without throwing", () => {
    const proc = new AzureMonitorDeploymentAliasProcessor();
    const identity = {} as object;
    azureLangChainDeploymentAliasEnricher(undefined, identity as unknown as ApiSpan);
    assert.strictEqual(aliasObservedThroughProcessor(proc, identity).requestModel, "gpt-3.5-turbo");
  });
});

describe("registerAzureLangChainDeploymentAliasEnricher", () => {
  it("registers the enricher with the shared registry and returns an unregister thunk", () => {
    const startCount = getRegisteredSpanEnrichers().length;

    const unregister = track(registerAzureLangChainDeploymentAliasEnricher());
    assert.ok(unregister, "unregister thunk is returned on successful registration");
    assert.strictEqual(getRegisteredSpanEnrichers().length, startCount + 1);

    unregister?.();
    assert.strictEqual(getRegisteredSpanEnrichers().length, startCount);
  });

  it("is idempotent across multiple calls (single registration by reference)", () => {
    const startCount = getRegisteredSpanEnrichers().length;
    track(registerAzureLangChainDeploymentAliasEnricher());
    track(registerAzureLangChainDeploymentAliasEnricher());
    track(registerAzureLangChainDeploymentAliasEnricher());
    assert.strictEqual(getRegisteredSpanEnrichers().length, startCount + 1);
  });
});

describe("end-to-end (enricher → processor)", () => {
  it("LangChain-shaped run flows through the enricher and the processor rewrites the span", () => {
    const proc = new AzureMonitorDeploymentAliasProcessor();
    const unregister = track(registerAzureLangChainDeploymentAliasEnricher());
    assert.ok(unregister, "registration succeeded");

    // Simulate the LangChain tracer invoking each registered enricher on the
    // live API span, then later handing the same identity to onEnd.
    const enrichers = getRegisteredSpanEnrichers();
    const identity = {} as object;
    for (const enricher of enrichers) {
      enricher(
        {
          extra: {
            invocation_params: {
              model: "gpt-3.5-turbo",
              azureOpenAIApiDeploymentName: "my-gpt4o-deployment",
            },
          },
        },
        identity as unknown as ApiSpan,
      );
    }

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

  it("regression: deployment alias wins over the LangChain-default invocation_params.model, and the response model still flows from llmOutput", () => {
    // Reproduces the original bug scenario from the PR description:
    // LangChain.js fills `invocation_params.model` with `gpt-3.5-turbo` even
    // when only an Azure deployment was configured. The Azure pipeline must
    // surface the alias on `gen_ai.request.model` while keeping the actual
    // resolved model on `gen_ai.response.model`.
    const proc = new AzureMonitorDeploymentAliasProcessor();
    const unregister = track(registerAzureLangChainDeploymentAliasEnricher());
    assert.ok(unregister, "registration succeeded");

    const identity = {} as object;
    for (const enricher of getRegisteredSpanEnrichers()) {
      enricher(
        {
          extra: {
            metadata: { ls_model_name: "gpt-3.5-turbo" },
            invocation_params: {
              // Conflicting LangChain default — must NOT win on the Azure
              // pipeline.
              model: "gpt-3.5-turbo",
              azureOpenAIApiDeploymentName: "my-gpt4o-deployment",
            },
          },
        },
        identity as unknown as ApiSpan,
      );
    }

    // Vendor-neutral instrumentation has already set
    // request=gpt-3.5-turbo (from invocation_params.model) and
    // response=gpt-4o-2024-08-06 (from response_metadata.model_name /
    // llmOutput.model_name) by the time onEnd runs.
    const readable = makeReadableSpan(
      "chat gpt-3.5-turbo",
      {
        [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo",
        [ATTR_GEN_AI_RESPONSE_MODEL]: "gpt-4o-2024-08-06",
      },
      identity,
    );
    proc.onEnd(readable);

    assert.strictEqual(
      readable.attributes[ATTR_GEN_AI_REQUEST_MODEL],
      "my-gpt4o-deployment",
      "request model is the deployment alias on the Azure pipeline",
    );
    assert.strictEqual(
      readable.attributes[ATTR_GEN_AI_RESPONSE_MODEL],
      "gpt-4o-2024-08-06",
      "response model still reflects the resolved underlying model",
    );
    assert.strictEqual(
      readable.name,
      "chat my-gpt4o-deployment",
      "span name follows the alias for chat operations",
    );
  });

  it("regression: alias preference also holds when surfaced via deployment_name", () => {
    const proc = new AzureMonitorDeploymentAliasProcessor();
    const unregister = track(registerAzureLangChainDeploymentAliasEnricher());
    assert.ok(unregister, "registration succeeded");

    const identity = {} as object;
    for (const enricher of getRegisteredSpanEnrichers()) {
      enricher(
        {
          extra: {
            invocation_params: {
              model: "gpt-3.5-turbo",
              deployment_name: "prod-gpt4o",
            },
          },
        },
        identity as unknown as ApiSpan,
      );
    }

    const readable = makeReadableSpan(
      "chat gpt-3.5-turbo",
      { [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo" },
      identity,
    );
    proc.onEnd(readable);

    assert.strictEqual(readable.attributes[ATTR_GEN_AI_REQUEST_MODEL], "prod-gpt4o");
    assert.strictEqual(readable.name, "chat prod-gpt4o");
  });
});
