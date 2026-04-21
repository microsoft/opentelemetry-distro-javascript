// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { context as otelContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

import {
  BaggageBuilderUtils,
  BaggageBuilder,
  OpenTelemetryConstants,
} from "../../../../../src/a365/index.js";
import type { TurnContextLike } from "../../../../../src/a365/index.js";

let contextManager: AsyncLocalStorageContextManager;

beforeAll(() => {
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);
});

afterAll(() => {
  contextManager.disable();
  otelContext.disable();
});

function makeMockTurnContext(): TurnContextLike {
  return {
    activity: {
      from: {
        aadObjectId: "user-oid",
        name: "User One",
        agenticUserId: "user@contoso.com",
        tenantId: "tenant1",
        role: "user",
      },
      recipient: {
        aadObjectId: "agent-oid",
        name: "Agent One",
        role: "agent",
      },
      conversation: { id: "conv-1" },
      channelId: "web",
      serviceUrl: "https://example.com",
      isAgenticRequest: () => true,
      getAgenticInstanceId: () => "agent-app-1",
      getAgenticTenantId: () => "tenant1",
      getAgenticUser: () => "agent@contoso.com",
    },
    turnState: new Map(),
  };
}

describe("BaggageBuilderUtils", () => {
  it("should populate all baggage pairs from TurnContext", () => {
    const capturedPairs: Array<[string, string]> = [];

    // Subclass BaggageBuilder to capture setPairs calls
    class CapturingBaggageBuilder extends BaggageBuilder {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setPairs(pairs: Record<string, any> | Iterable<[string, any]> | null | undefined): this {
        if (pairs) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let entries: Iterable<[string, any]>;
          if (Symbol.iterator in Object(pairs)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            entries = pairs as Iterable<[string, any]>;
          } else {
            entries = Object.entries(pairs);
          }
          for (const [k, v] of entries) {
            if (v !== null && v !== undefined) {
              capturedPairs.push([k, String(v)]);
            }
          }
        }
        return this;
      }
    }

    const builder = new CapturingBaggageBuilder();
    const ctx = makeMockTurnContext();
    const result = BaggageBuilderUtils.fromTurnContext(builder, ctx);

    expect(result).toBe(builder);

    const asObj = Object.fromEntries(capturedPairs);

    // Caller pairs
    expect(asObj[OpenTelemetryConstants.USER_ID_KEY]).toBe("user-oid");
    expect(asObj[OpenTelemetryConstants.USER_NAME_KEY]).toBe("User One");
    expect(asObj[OpenTelemetryConstants.USER_EMAIL_KEY]).toBe("user@contoso.com");

    // Agent pairs
    expect(asObj[OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]).toBe("agent-app-1");
    expect(asObj[OpenTelemetryConstants.GEN_AI_AGENT_NAME_KEY]).toBe("Agent One");
    expect(asObj[OpenTelemetryConstants.GEN_AI_AGENT_DESCRIPTION_KEY]).toBe("agent");

    // Tenant
    expect(asObj[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant1");

    // Channel
    expect(asObj[OpenTelemetryConstants.CHANNEL_NAME_KEY]).toBe("web");

    // Conversation
    expect(asObj[OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY]).toBe("conv-1");
  });

  it("should throw if turnContext is missing", () => {
    const builder = new BaggageBuilder();
    expect(() =>
      BaggageBuilderUtils.fromTurnContext(builder, undefined as unknown as TurnContextLike),
    ).toThrow("turnContext is required");
  });

  it("should call individual set helpers", () => {
    const builder = new BaggageBuilder();
    const ctx = makeMockTurnContext();

    // Each helper should return the same builder (fluent)
    expect(BaggageBuilderUtils.setCallerBaggage(builder, ctx)).toBe(builder);
    expect(BaggageBuilderUtils.setTargetAgentBaggage(builder, ctx)).toBe(builder);
    expect(BaggageBuilderUtils.setTenantIdBaggage(builder, ctx)).toBe(builder);
    expect(BaggageBuilderUtils.setChannelBaggage(builder, ctx)).toBe(builder);
    expect(BaggageBuilderUtils.setConversationIdBaggage(builder, ctx)).toBe(builder);
  });
});
