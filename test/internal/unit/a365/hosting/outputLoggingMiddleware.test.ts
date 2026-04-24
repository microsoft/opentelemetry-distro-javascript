// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { trace, context as otelContext } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

import {
  OutputLoggingMiddleware,
  A365_PARENT_SPAN_KEY,
  A365_AUTH_TOKEN_KEY,
  OpenTelemetryConstants,
} from "../../../../../src/a365/index.js";
import type {
  TurnContextLike,
  ActivityLike,
  SendActivitiesHandler,
} from "../../../../../src/a365/index.js";

let exporter: InMemorySpanExporter;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let flushProvider: any;
let contextManager: AsyncLocalStorageContextManager;

const originalConsoleWarn = console.warn;

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
    flushProvider = globalProvider;
  } else {
    const provider = new BasicTracerProvider({
      spanProcessors: [processor],
    });
    trace.setGlobalTracerProvider(provider);
    flushProvider = provider;
  }

  console.warn = vi.fn();
});

beforeEach(() => {
  exporter.reset();
});

afterAll(() => {
  console.warn = originalConsoleWarn;
  contextManager.disable();
  otelContext.disable();
});

interface MockTurnContext extends TurnContextLike {
  _sendHandlers: SendActivitiesHandler[];
  simulateSend(activities: Array<{ type?: string; text?: string }>): Promise<unknown[]>;
}

function makeMockTurnContext(options?: {
  text?: string;
  recipientName?: string;
  recipientTenantId?: string;
  channelId?: string;
  conversationId?: string;
  activityType?: string;
  activityName?: string;
}): MockTurnContext {
  const sendHandlers: SendActivitiesHandler[] = [];
  const recipientTenantId = options?.recipientTenantId ?? "tenant-123";

  const ctx: MockTurnContext = {
    activity: {
      type: options?.activityType,
      name: options?.activityName,
      text: options?.text ?? "Hello agent",
      channelId: options?.channelId ?? "web",
      conversation: { id: options?.conversationId ?? "conv-001" },
      serviceUrl: "https://example.com",
      from: {
        aadObjectId: "user-oid",
        name: "Test User",
        agenticUserId: "user@contoso.com",
        tenantId: "from-tenant",
      },
      recipient: {
        aadObjectId: "agent-oid",
        name: options?.recipientName ?? "Agent One",
        role: "assistant",
      },
      getAgenticTenantId: () => recipientTenantId,
      getAgenticUser: () => "agent@contoso.com",
      getAgenticInstanceId: () => "agent-1",
      isAgenticRequest: () => false,
    },
    turnState: new Map(),
    _sendHandlers: sendHandlers,
    onSendActivities(handler: SendActivitiesHandler) {
      sendHandlers.push(handler);
    },
    async simulateSend(activities: Array<{ type?: string; text?: string }>) {
      const finalSend = async () => activities.map(() => ({ id: "resp-1" }));
      let current = finalSend;
      for (let i = sendHandlers.length - 1; i >= 0; i--) {
        const handler = sendHandlers[i];
        const prev = current;
        current = () =>
          handler(
            ctx as TurnContextLike,
            activities as ActivityLike[],
            prev as () => Promise<unknown[]>,
          );
      }
      return await current();
    },
  };

  return ctx;
}

describe("OutputLoggingMiddleware", () => {
  it("should create OutputScope for outgoing messages", async () => {
    const middleware = new OutputLoggingMiddleware();
    const ctx = makeMockTurnContext({ text: "Hello" });
    ctx.turnState.set(A365_AUTH_TOKEN_KEY, "");

    await middleware.onTurn(ctx, async () => {
      ctx.turnState.set(A365_PARENT_SPAN_KEY, {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 1,
      });
      await ctx.simulateSend([{ type: "message", text: "Hi there!" }]);
    });

    await flushProvider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const outputSpan = spans.find((s) => s.name.includes("output_messages"));

    expect(outputSpan).toBeDefined();
    const messages = outputSpan!.attributes[OpenTelemetryConstants.GEN_AI_OUTPUT_MESSAGES_KEY];
    expect(messages).toBeDefined();
    expect(typeof messages).toBe("string");
    expect(JSON.parse(messages as string).messages[0].parts[0].content).toBe("Hi there!");
  });

  it("should skip non-message activities", async () => {
    const middleware = new OutputLoggingMiddleware();
    const ctx = makeMockTurnContext({ text: "Hello" });
    ctx.turnState.set(A365_AUTH_TOKEN_KEY, "");

    await middleware.onTurn(ctx, async () => {
      await ctx.simulateSend([{ type: "typing" }, { type: "event", text: "some event" }]);
    });

    await flushProvider.forceFlush();
    const outputSpan = exporter.getFinishedSpans().find((s) => s.name.includes("output_messages"));
    expect(outputSpan).toBeUndefined();
  });

  it("should pass through without tracing when agent details are missing", async () => {
    const middleware = new OutputLoggingMiddleware();

    // No recipient → no agent details → should pass through
    const ctx: TurnContextLike = {
      activity: {
        text: "Hello",
        isAgenticRequest: () => false,
        getAgenticTenantId: () => undefined as unknown as string,
        getAgenticUser: () => undefined as unknown as string,
      },
      turnState: new Map(),
    };

    let nextCalled = false;
    await middleware.onTurn(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("should pass through when tenantId is missing", async () => {
    const middleware = new OutputLoggingMiddleware();
    const ctx: TurnContextLike = {
      activity: {
        text: "Hello",
        recipient: { name: "Agent" },
        isAgenticRequest: () => false,
        getAgenticInstanceId: () => "aid",
        getAgenticTenantId: () => undefined as unknown as string,
        getAgenticUser: () => undefined as unknown as string,
      },
      turnState: new Map(),
    };

    let nextCalled = false;
    await middleware.onTurn(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("should set caller details on OutputScope span", async () => {
    const middleware = new OutputLoggingMiddleware();
    const ctx = makeMockTurnContext({ text: "Hello", channelId: "teams" });
    ctx.turnState.set(A365_AUTH_TOKEN_KEY, "");

    await middleware.onTurn(ctx, async () => {
      ctx.turnState.set(A365_PARENT_SPAN_KEY, {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 1,
      });
      await ctx.simulateSend([{ type: "message", text: "Reply" }]);
    });

    await flushProvider.forceFlush();
    const outputSpan = exporter.getFinishedSpans().find((s) => s.name.includes("output_messages"));
    expect(outputSpan).toBeDefined();
    expect(outputSpan!.attributes[OpenTelemetryConstants.USER_ID_KEY]).toBe("user-oid");
    expect(outputSpan!.attributes[OpenTelemetryConstants.USER_NAME_KEY]).toBe("Test User");
    expect(outputSpan!.attributes[OpenTelemetryConstants.CHANNEL_NAME_KEY]).toBe("teams");
  });

  it("should create OutputScope when activity helper methods are missing", async () => {
    const middleware = new OutputLoggingMiddleware();
    const ctx = makeMockTurnContext({ text: "Hello" });
    ctx.turnState.set(A365_AUTH_TOKEN_KEY, "");

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

    await middleware.onTurn(ctx, async () => {
      await ctx.simulateSend([{ type: "message", text: "Reply" }]);
    });

    await flushProvider.forceFlush();
    const outputSpan = exporter.getFinishedSpans().find((s) => s.name.includes("output_messages"));

    expect(outputSpan).toBeDefined();
    expect(outputSpan!.attributes[OpenTelemetryConstants.TENANT_ID_KEY]).toBe(
      "tenant-from-recipient",
    );
    expect(outputSpan!.attributes[OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]).toBe(
      "agent-from-recipient",
    );
  });

  it("should link OutputScope to parent when parentSpanRef is set", async () => {
    const middleware = new OutputLoggingMiddleware();
    const ctx = makeMockTurnContext({ text: "Hello" });
    ctx.turnState.set(A365_AUTH_TOKEN_KEY, "");

    const parentSpanRef = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    };

    await middleware.onTurn(ctx, async () => {
      ctx.turnState.set(A365_PARENT_SPAN_KEY, parentSpanRef);
      await ctx.simulateSend([{ type: "message", text: "Reply" }]);
    });

    await flushProvider.forceFlush();
    const outputSpan = exporter.getFinishedSpans().find((s) => s.name.includes("output_messages"));
    expect(outputSpan).toBeDefined();
    const parentCtx = outputSpan!.parentSpanContext;
    expect(parentCtx?.traceId).toBe(parentSpanRef.traceId);
    expect(parentCtx?.spanId).toBe(parentSpanRef.spanId);
  });

  it("should not create spans when no messages are sent", async () => {
    const middleware = new OutputLoggingMiddleware();
    const ctx = makeMockTurnContext({ text: "Hello" });
    ctx.turnState.set(A365_AUTH_TOKEN_KEY, "");

    await middleware.onTurn(ctx, async () => {
      // next() without sending any messages
    });

    await flushProvider.forceFlush();
    expect(
      exporter.getFinishedSpans().find((s) => s.name.includes("output_messages")),
    ).toBeUndefined();
  });

  it("should re-throw errors from sendNext after recording on OutputScope", async () => {
    const middleware = new OutputLoggingMiddleware();
    const ctx = makeMockTurnContext({ text: "Hello" });
    ctx.turnState.set(A365_AUTH_TOKEN_KEY, "");
    const sendError = new Error("send pipeline failed");

    // Override simulateSend to make the final send throw
    ctx.simulateSend = async (activities) => {
      // Register the handler first via onTurn, then trigger a throwing send
      const finalSend = async () => {
        throw sendError;
      };
      let current = finalSend;
      for (let i = ctx._sendHandlers.length - 1; i >= 0; i--) {
        const handler = ctx._sendHandlers[i];
        const prev = current;
        current = () =>
          handler(
            ctx as TurnContextLike,
            activities as ActivityLike[],
            prev as () => Promise<unknown[]>,
          );
      }
      return await current();
    };

    await middleware.onTurn(ctx, async () => {
      await expect(ctx.simulateSend([{ type: "message", text: "Will fail" }])).rejects.toThrow(
        "send pipeline failed",
      );
    });

    await flushProvider.forceFlush();
    const outputSpan = exporter.getFinishedSpans().find((s) => s.name.includes("output_messages"));
    expect(outputSpan).toBeDefined();
    // The span should have an error event recorded
    const errorEvents = outputSpan!.events.filter((e) => e.name === "exception");
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it("should export A365_PARENT_SPAN_KEY and A365_AUTH_TOKEN_KEY constants", () => {
    expect(A365_PARENT_SPAN_KEY).toBe("A365ParentSpanId");
    expect(A365_AUTH_TOKEN_KEY).toBe("A365AuthToken");
  });
});
