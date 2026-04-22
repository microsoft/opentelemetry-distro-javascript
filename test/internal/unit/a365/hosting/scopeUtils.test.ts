// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { trace, context as otelContext, SpanKind } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

import {
  ScopeUtils,
  OpenTelemetryConstants,
  OpenTelemetryScope,
  InvokeAgentScope,
  InferenceScope,
  ExecuteToolScope,
} from "../../../../../src/a365/index.js";
import type { TurnContextLike } from "../../../../../src/a365/index.js";

let contextManager: AsyncLocalStorageContextManager;

const testAuthToken = "mock-auth-token";

const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

beforeAll(() => {
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);

  const exporter = new InMemorySpanExporter();
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

  console.warn = vi.fn();
  console.error = vi.fn();
});

afterAll(() => {
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
  contextManager.disable();
  otelContext.disable();
});

function makeTurnContext(
  text?: string,
  channelName?: string,
  channelLink?: string,
  conversationId?: string,
): TurnContextLike {
  return {
    activity: {
      text: text ?? "hello world",
      channelId: channelName ?? "web",
      channelIdSubChannel: channelLink ?? "https://example/channel",
      conversation: { id: conversationId ?? "conv-001" },
      serviceUrl: "https://example.com",
      from: {
        aadObjectId: "user-oid",
        name: "Test User",
        agenticUserId: "user@contoso.com",
        tenantId: "tenant-xyz",
        agenticAppBlueprintId: "caller-agentBlueprintId",
        agenticAppId: "callerAgent-1",
        role: "user",
      },
      recipient: {
        aadObjectId: "agent-oid",
        name: "Agent One",
        role: "assistant",
      },
      isAgenticRequest: () => true,
      getAgenticInstanceId: () => "agent-1",
      getAgenticUser: () => "agent-upn@contoso.com",
      getAgenticTenantId: () => "tenant-123",
    },
    turnState: new Map(),
  };
}

function makeCtx(partial: Partial<TurnContextLike>): TurnContextLike {
  return partial as unknown as TurnContextLike;
}

describe("ScopeUtils", () => {
  describe("deriveAgentDetails", () => {
    it("should map recipient fields to AgentDetails", () => {
      const ctx = makeCtx({
        activity: {
          recipient: { name: "A", aadObjectId: "auid", role: "bot" },
          isAgenticRequest: () => false,
          getAgenticInstanceId: () => "aid",
          getAgenticUser: () => "upn1",
          getAgenticTenantId: () => "t1",
        },
      });
      const result = ScopeUtils.deriveAgentDetails(ctx, testAuthToken);
      expect(result).toEqual({
        agentId: undefined,
        agentName: "A",
        agentAUID: "auid",
        agentBlueprintId: undefined,
        agentEmail: "upn1",
        agentDescription: "bot",
        tenantId: "t1",
      });
    });

    it("should return undefined without recipient", () => {
      const ctx = makeCtx({ activity: {} });
      expect(ScopeUtils.deriveAgentDetails(ctx, testAuthToken)).toBeUndefined();
    });
  });

  describe("deriveCallerAgent", () => {
    it("should map from fields to caller AgentDetails", () => {
      const ctx = makeCtx({
        activity: {
          from: {
            agenticAppBlueprintId: "bp",
            name: "Caller",
            aadObjectId: "uid",
            agenticUserId: "caller-upn",
            role: "agent",
            tenantId: "t2",
            agenticAppId: "agent-caller",
          },
        },
      });
      expect(ScopeUtils.deriveCallerAgent(ctx)).toEqual({
        agentBlueprintId: "bp",
        agentName: "Caller",
        agentAUID: "uid",
        agentEmail: "caller-upn",
        agentDescription: "agent",
        tenantId: "t2",
        agentId: "agent-caller",
      });
    });

    it("should return undefined without from", () => {
      const ctx = makeCtx({ activity: {} });
      expect(ScopeUtils.deriveCallerAgent(ctx)).toBeUndefined();
    });
  });

  describe("deriveCallerDetails", () => {
    it("should map from to UserDetails", () => {
      const ctx = makeCtx({
        activity: {
          from: {
            aadObjectId: "uid",
            agenticUserId: "upn",
            name: "User",
            tenantId: "t3",
          },
        },
      });
      expect(ScopeUtils.deriveCallerDetails(ctx)).toEqual({
        userId: "uid",
        userEmail: "upn",
        userName: "User",
        tenantId: "t3",
      });
    });

    it("should return undefined without from", () => {
      const ctx = makeCtx({ activity: {} });
      expect(ScopeUtils.deriveCallerDetails(ctx)).toBeUndefined();
    });
  });

  describe("deriveConversationId", () => {
    it("should return id when present", () => {
      const ctx = makeCtx({ activity: { conversation: { id: "conv-1" } } });
      expect(ScopeUtils.deriveConversationId(ctx)).toBe("conv-1");
    });

    it("should return undefined when missing", () => {
      const ctx = makeCtx({ activity: {} });
      expect(ScopeUtils.deriveConversationId(ctx)).toBeUndefined();
    });
  });

  describe("deriveChannelObject", () => {
    it("should map channel name/description", () => {
      const ctx = makeCtx({
        activity: { channelId: "teams", channelIdSubChannel: "chat" },
      });
      expect(ScopeUtils.deriveChannelObject(ctx)).toEqual({
        name: "teams",
        description: "chat",
      });
    });

    it("should return undefined fields when missing", () => {
      const ctx = makeCtx({ activity: {} });
      expect(ScopeUtils.deriveChannelObject(ctx)).toEqual({
        name: undefined,
        description: undefined,
      });
    });
  });

  describe("populateInferenceScopeFromTurnContext", () => {
    it("should build InferenceScope based on turn context", () => {
      const spy = vi.spyOn(OpenTelemetryScope.prototype as any, "setTagMaybe");
      const details = {
        operationName: "inference",
        model: "gpt-4o",
        providerName: "openai",
      } as any;
      const ctx = makeTurnContext("input text", "web", "https://web", "conv-A");
      const scope = ScopeUtils.populateInferenceScopeFromTurnContext(details, ctx, testAuthToken);

      expect(scope).toBeInstanceOf(InferenceScope);

      const calls = spy.mock.calls.map((args) => [args[0], args[1]]);
      expect(calls).toEqual(
        expect.arrayContaining([
          [OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY, "conv-A"],
          [OpenTelemetryConstants.CHANNEL_NAME_KEY, "web"],
          [OpenTelemetryConstants.CHANNEL_LINK_KEY, "https://web"],
          [OpenTelemetryConstants.GEN_AI_AGENT_NAME_KEY, "Agent One"],
          [OpenTelemetryConstants.GEN_AI_AGENT_AUID_KEY, "agent-oid"],
          [OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY, "agent-1"],
          [OpenTelemetryConstants.TENANT_ID_KEY, "tenant-123"],
        ]),
      );

      scope?.dispose();
      spy.mockRestore();
    });

    it("should throw when agent details are missing (no recipient)", () => {
      const details = { operationName: "inference", model: "m", providerName: "prov" } as any;
      const ctx = makeCtx({
        activity: { getAgenticTenantId: () => "t1" },
      });
      expect(() =>
        ScopeUtils.populateInferenceScopeFromTurnContext(details, ctx, testAuthToken),
      ).toThrow("Missing agent details on TurnContext (recipient)");
    });
  });

  describe("populateInvokeAgentScopeFromTurnContext", () => {
    it("should build InvokeAgentScope based on turn context", () => {
      const spy = vi.spyOn(OpenTelemetryScope.prototype as any, "setTagMaybe");
      const ctx = makeTurnContext("invoke message", "teams", "https://teams", "conv-B");
      const scope = ScopeUtils.populateInvokeAgentScopeFromTurnContext(
        { agentId: "invoke-agent", providerName: "internal" } as any,
        {},
        ctx,
        testAuthToken,
      );

      expect(scope).toBeInstanceOf(InvokeAgentScope);

      const calls = spy.mock.calls.map((args) => [args[0], args[1]]);
      expect(calls).toEqual(
        expect.arrayContaining([
          [OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY, "conv-B"],
          [OpenTelemetryConstants.CHANNEL_NAME_KEY, "teams"],
          [OpenTelemetryConstants.CHANNEL_LINK_KEY, "https://teams"],
          [OpenTelemetryConstants.USER_ID_KEY, "user-oid"],
          [OpenTelemetryConstants.USER_NAME_KEY, "Test User"],
          [OpenTelemetryConstants.USER_EMAIL_KEY, "user@contoso.com"],
          [OpenTelemetryConstants.TENANT_ID_KEY, "tenant-123"],
        ]),
      );

      scope?.dispose();
      spy.mockRestore();
    });

    it("should forward spanKind", () => {
      const spy = vi.spyOn(InvokeAgentScope, "start");
      const ctx = makeTurnContext("hello", "web", "https://web", "conv-span");
      const scope = ScopeUtils.populateInvokeAgentScopeFromTurnContext(
        { agentId: "test-agent" } as any,
        {},
        ctx,
        testAuthToken,
        undefined,
        undefined,
        SpanKind.SERVER,
      );

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ spanKind: SpanKind.SERVER }),
      );

      scope?.dispose();
      spy.mockRestore();
    });
  });

  describe("populateExecuteToolScopeFromTurnContext", () => {
    it("should build ExecuteToolScope based on turn context", () => {
      const spy = vi.spyOn(OpenTelemetryScope.prototype as any, "setTagMaybe");
      const details = { toolName: "search", arguments: "{}" } as any;
      const ctx = makeTurnContext(undefined, "cli", "https://cli", "conv-C");
      const scope = ScopeUtils.populateExecuteToolScopeFromTurnContext(details, ctx, testAuthToken);

      expect(scope).toBeInstanceOf(ExecuteToolScope);

      const calls = spy.mock.calls.map((args) => [args[0], args[1]]);
      expect(calls).toEqual(
        expect.arrayContaining([
          [OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY, "conv-C"],
          [OpenTelemetryConstants.CHANNEL_NAME_KEY, "cli"],
          [OpenTelemetryConstants.CHANNEL_LINK_KEY, "https://cli"],
          [OpenTelemetryConstants.GEN_AI_AGENT_AUID_KEY, "agent-oid"],
          [OpenTelemetryConstants.GEN_AI_AGENT_NAME_KEY, "Agent One"],
          [OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY, "agent-1"],
          [OpenTelemetryConstants.GEN_AI_AGENT_DESCRIPTION_KEY, "assistant"],
          [OpenTelemetryConstants.TENANT_ID_KEY, "tenant-123"],
        ]),
      );

      scope?.dispose();
      spy.mockRestore();
    });

    it("should throw when agent details are missing (no recipient)", () => {
      const details = { toolName: "tool" } as any;
      const ctx = makeCtx({
        activity: { getAgenticTenantId: () => "t1" },
      });
      expect(() =>
        ScopeUtils.populateExecuteToolScopeFromTurnContext(details, ctx, testAuthToken),
      ).toThrow("Missing agent details on TurnContext (recipient)");
    });

    it("should forward spanKind", () => {
      const spy = vi.spyOn(ExecuteToolScope, "start");
      const ctx = makeTurnContext();
      const scope = ScopeUtils.populateExecuteToolScopeFromTurnContext(
        { toolName: "tool" } as any,
        ctx,
        testAuthToken,
        undefined,
        undefined,
        SpanKind.CLIENT,
      );

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ spanKind: SpanKind.CLIENT }),
      );

      scope?.dispose();
      spy.mockRestore();
    });
  });

  describe("buildInvokeAgentDetails", () => {
    it("should merge agent (recipient) into provided details", () => {
      const ctx = makeCtx({
        activity: {
          recipient: { name: "Rec", role: "bot" },
          conversation: { id: "c-2" },
          channelId: "web",
          isAgenticRequest: () => false,
          getAgenticInstanceId: () => "rec-agent",
          getAgenticUser: () => undefined as unknown as string,
          getAgenticTenantId: () => "tX",
        },
      });

      const result = ScopeUtils.buildInvokeAgentDetails(
        { agentId: "provided" } as any,
        ctx,
        testAuthToken,
      );
      expect(result.agentName).toBe("Rec");
    });

    it("should keep base details when TurnContext has no overrides", () => {
      const ctx = makeCtx({ activity: {} });
      const result = ScopeUtils.buildInvokeAgentDetails(
        { agentId: "base-agent" } as any,
        ctx,
        testAuthToken,
      );
      expect(result.agentId).toBe("base-agent");
    });
  });
});
