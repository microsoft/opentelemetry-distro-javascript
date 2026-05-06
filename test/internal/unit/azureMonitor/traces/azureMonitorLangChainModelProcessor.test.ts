// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert, describe, it } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AzureMonitorLangChainModelProcessor } from "../../../../../src/azureMonitor/traces/azureMonitorLangChainModelProcessor.js";
import {
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS,
} from "../../../../../src/genai/index.js";

function makeFakeSpan(name: string, attributes: Record<string, unknown>): ReadableSpan {
  // Mimic the SDK Span object enough that the processor's mutations land on
  // a writable `attributes` map and `name` field.
  const span = {
    name,
    attributes,
  } as unknown as ReadableSpan;
  return span;
}

describe("AzureMonitorLangChainModelProcessor", () => {
  it("overrides gen_ai.request.model with the deployment alias when the bridge attribute is present", () => {
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo",
      [ATTR_GEN_AI_RESPONSE_MODEL]: "gpt-4o-2024-08-06",
      [ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS]: "my-gpt4o-deployment",
    };
    const span = makeFakeSpan("chat gpt-3.5-turbo", attrs);

    processor.onEnd(span);

    assert.strictEqual(
      attrs[ATTR_GEN_AI_REQUEST_MODEL],
      "my-gpt4o-deployment",
      "request model is overridden with the Azure deployment alias",
    );
    assert.strictEqual(
      attrs[ATTR_GEN_AI_RESPONSE_MODEL],
      "gpt-4o-2024-08-06",
      "response model is left untouched",
    );
    assert.ok(
      !(ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS in attrs),
      "internal bridge attribute is stripped from the exported span",
    );
    assert.strictEqual(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (span as any).name,
      "chat my-gpt4o-deployment",
      "chat span name is rewritten to use the deployment alias",
    );
  });

  it("is a no-op when the deployment alias bridge attribute is missing", () => {
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-4o",
      [ATTR_GEN_AI_RESPONSE_MODEL]: "gpt-4o-2024-08-06",
    };
    const span = makeFakeSpan("chat gpt-4o", attrs);

    processor.onEnd(span);

    assert.strictEqual(attrs[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
    assert.strictEqual(attrs[ATTR_GEN_AI_RESPONSE_MODEL], "gpt-4o-2024-08-06");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual((span as any).name, "chat gpt-4o");
  });

  it("does not rewrite span name for non-chat operations", () => {
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo",
      [ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS]: "my-deployment",
    };
    const span = makeFakeSpan("invoke_agent MyAgent", attrs);

    processor.onEnd(span);

    assert.strictEqual(attrs[ATTR_GEN_AI_REQUEST_MODEL], "my-deployment");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual((span as any).name, "invoke_agent MyAgent");
  });

  it("ignores non-string deployment alias values", () => {
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-4o",
      [ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS]: 12345,
    };
    const span = makeFakeSpan("chat gpt-4o", attrs);

    processor.onEnd(span);

    assert.strictEqual(attrs[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
    assert.strictEqual(attrs[ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS], 12345);
  });
});
