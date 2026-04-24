// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { trace, context as otelContext, propagation } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

import { BaggageMiddleware, OpenTelemetryConstants } from "../../../../../src/a365/index.js";
import type { TurnContextLike } from "../../../../../src/a365/index.js";

let exporter: InMemorySpanExporter;
let contextManager: AsyncLocalStorageContextManager;

beforeAll(() => {
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);

  exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalProvider: any = trace.getTracerProvider();
  if (globalProvider && typeof globalProvider.addSpanProcessor === "function") {
    globalProvider.addSpanProcessor(processor);
  } else {
    const provider = new BasicTracerProvider({
      spanProcessors: [processor],
    });
    trace.setGlobalTracerProvider(provider);
  }
});

beforeEach(() => {
  exporter.reset();
});

afterAll(() => {
  contextManager.disable();
  otelContext.disable();
});

function makeMockTurnContext(options?: {
  activityType?: string;
  activityName?: string;
}): TurnContextLike {
  return {
    activity: {
      type: options?.activityType,
      name: options?.activityName,
      text: "Hello agent",
      channelId: "web",
      conversation: { id: "conv-001" },
      serviceUrl: "https://example.com",
      from: {
        aadObjectId: "user-oid",
        name: "Test User",
        agenticUserId: "user@contoso.com",
        tenantId: "from-tenant",
      },
      recipient: {
        aadObjectId: "agent-oid",
        name: "Agent One",
        role: "assistant",
      },
      isAgenticRequest: () => false,
      getAgenticInstanceId: () => "agent-1",
      getAgenticTenantId: () => "tenant-123",
      getAgenticUser: () => "agent@contoso.com",
    },
    turnState: new Map(),
  };
}

describe("BaggageMiddleware", () => {
  it("should propagate baggage context during turn", async () => {
    const middleware = new BaggageMiddleware();
    const ctx = makeMockTurnContext();
    const capturedBaggage: Record<string, string> = {};

    await middleware.onTurn(ctx, async () => {
      const bag = propagation.getBaggage(otelContext.active());
      if (bag) {
        for (const [key, entry] of bag.getAllEntries()) {
          capturedBaggage[key] = entry.value;
        }
      }
    });

    expect(capturedBaggage[OpenTelemetryConstants.USER_ID_KEY]).toBe("user-oid");
    expect(capturedBaggage[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
    expect(capturedBaggage[OpenTelemetryConstants.CHANNEL_NAME_KEY]).toBe("web");
    expect(capturedBaggage[OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY]).toBe("conv-001");
  });

  it("should skip baggage setup for async replies (ContinueConversation)", async () => {
    const middleware = new BaggageMiddleware();
    const ctx = makeMockTurnContext({
      activityType: "event",
      activityName: "ContinueConversation",
    });
    const capturedBaggage: Record<string, string> = {};

    await middleware.onTurn(ctx, async () => {
      const bag = propagation.getBaggage(otelContext.active());
      if (bag) {
        for (const [key, entry] of bag.getAllEntries()) {
          capturedBaggage[key] = entry.value;
        }
      }
    });

    // No baggage set for async replies
    expect(Object.keys(capturedBaggage).length).toBe(0);
  });

  it("should call next() even when baggage setup is skipped", async () => {
    const middleware = new BaggageMiddleware();
    const ctx = makeMockTurnContext({
      activityType: "event",
      activityName: "ContinueConversation",
    });
    let nextCalled = false;

    await middleware.onTurn(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("should always call next() for normal message activities", async () => {
    const middleware = new BaggageMiddleware();
    const ctx = makeMockTurnContext();
    let nextCalled = false;

    await middleware.onTurn(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("should not treat non-ContinueConversation events as async replies", async () => {
    const middleware = new BaggageMiddleware();
    const ctx = makeMockTurnContext({
      activityType: "event",
      activityName: "SomeOtherEvent",
    });
    const capturedBaggage: Record<string, string> = {};

    await middleware.onTurn(ctx, async () => {
      const bag = propagation.getBaggage(otelContext.active());
      if (bag) {
        for (const [key, entry] of bag.getAllEntries()) {
          capturedBaggage[key] = entry.value;
        }
      }
    });

    // Should still set baggage for non-ContinueConversation events
    expect(Object.keys(capturedBaggage).length).toBeGreaterThan(0);
  });

  it("should populate tenant and agent baggage from plain activity fields", async () => {
    const middleware = new BaggageMiddleware();
    const ctx = makeMockTurnContext();
    const activity = ctx.activity as TurnContextLike["activity"] & {
      recipient?: {
        tenantId?: string;
        agenticAppId?: string;
        role?: string;
      };
      conversation?: {
        id?: string;
        tenantId?: string;
      };
    };

    delete (activity as { getAgenticTenantId?: () => string }).getAgenticTenantId;
    delete (activity as { getAgenticInstanceId?: () => string }).getAgenticInstanceId;
    delete (activity as { isAgenticRequest?: () => boolean }).isAgenticRequest;

    activity.recipient = {
      ...activity.recipient,
      role: "agenticUser",
      tenantId: "tenant-from-recipient",
      agenticAppId: "agent-from-recipient",
    };
    activity.conversation = {
      ...activity.conversation,
      tenantId: "tenant-from-conversation",
    };

    const capturedBaggage: Record<string, string> = {};

    await middleware.onTurn(ctx, async () => {
      const bag = propagation.getBaggage(otelContext.active());
      if (bag) {
        for (const [key, entry] of bag.getAllEntries()) {
          capturedBaggage[key] = entry.value;
        }
      }
    });

    expect(capturedBaggage[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-from-recipient");
    expect(capturedBaggage[OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]).toBe(
      "agent-from-recipient",
    );
  });
});
