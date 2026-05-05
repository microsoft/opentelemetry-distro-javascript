// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { context as otelContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

import {
  getCallerBaggagePairs,
  getTargetAgentBaggagePairs,
  getTenantIdPair,
  getChannelBaggagePairs,
  getConversationIdAndItemLinkPairs,
  resolveEmbodiedAgentIds,
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
        agenticAppBlueprintId: "caller-blueprint-001",
      },
      recipient: {
        aadObjectId: "agent-oid",
        name: "Agent One",
        role: "assistant",
      },
      conversation: { id: "conv-1" },
      channelId: "web",
      channelIdSubChannel: "general",
      serviceUrl: "https://smba.trafficmanager.net/teams/",
      text: "Hello world",
      isAgenticRequest: () => true,
      getAgenticInstanceId: () => "agent-instance-1",
      getAgenticTenantId: () => "tenant1",
      getAgenticUser: () => "agent@contoso.com",
    },
    turnState: new Map(),
  };
}

describe("TurnContextUtils", () => {
  describe("getCallerBaggagePairs", () => {
    it("should return caller baggage pairs from activity.from", () => {
      const ctx = makeMockTurnContext();
      const pairs = getCallerBaggagePairs(ctx);
      expect(Array.isArray(pairs)).toBe(true);
      expect(pairs.length).toBeGreaterThan(0);
      const obj = Object.fromEntries(pairs);
      expect(obj[OpenTelemetryConstants.USER_ID_KEY]).toBe("user-oid");
      expect(obj[OpenTelemetryConstants.USER_NAME_KEY]).toBe("User One");
      expect(obj[OpenTelemetryConstants.USER_EMAIL_KEY]).toBe("user@contoso.com");
      expect(obj[OpenTelemetryConstants.GEN_AI_CALLER_AGENT_APPLICATION_ID_KEY]).toBe(
        "caller-blueprint-001",
      );
    });

    it("should return empty array when from is undefined", () => {
      const ctx: TurnContextLike = { activity: {}, turnState: new Map() };
      const pairs = getCallerBaggagePairs(ctx);
      expect(pairs).toEqual([]);
    });

    it("should fall back to from.id when aadObjectId is undefined (non-Teams channel)", () => {
      const ctx: TurnContextLike = {
        activity: {
          from: { id: "webchat-user-123", name: "Web User" },
        },
        turnState: new Map(),
      };
      const pairs = getCallerBaggagePairs(ctx);
      const obj = Object.fromEntries(pairs);
      expect(obj[OpenTelemetryConstants.USER_ID_KEY]).toBe("webchat-user-123");
      expect(obj[OpenTelemetryConstants.USER_NAME_KEY]).toBe("Web User");
    });

    it("should fall back to agenticUserId when aadObjectId is undefined (A2A)", () => {
      const ctx: TurnContextLike = {
        activity: {
          from: { agenticUserId: "agent@contoso.com", name: "Upstream Agent" },
        },
        turnState: new Map(),
      };
      const pairs = getCallerBaggagePairs(ctx);
      const obj = Object.fromEntries(pairs);
      expect(obj[OpenTelemetryConstants.USER_ID_KEY]).toBe("agent@contoso.com");
    });

    it("should resolve userId to agenticUserId when it is a GUID (A2A with GUID)", () => {
      const ctx: TurnContextLike = {
        activity: {
          from: {
            id: "29:1sH5NArUwkWAX",
            agenticUserId: "bef730f4-d6f5-4ffb-b759-26ffa449ed7e",
            name: "Agent",
          },
        },
        turnState: new Map(),
      };
      const pairs = getCallerBaggagePairs(ctx);
      const obj = Object.fromEntries(pairs);
      expect(obj[OpenTelemetryConstants.USER_ID_KEY]).toBe("bef730f4-d6f5-4ffb-b759-26ffa449ed7e");
    });

    it("should prefer aadObjectId over agenticUserId and from.id", () => {
      const ctx: TurnContextLike = {
        activity: {
          from: {
            id: "fallback-id",
            aadObjectId: "aad-oid",
            agenticUserId: "agent@contoso.com",
            name: "User",
          },
        },
        turnState: new Map(),
      };
      const pairs = getCallerBaggagePairs(ctx);
      const obj = Object.fromEntries(pairs);
      expect(obj[OpenTelemetryConstants.USER_ID_KEY]).toBe("aad-oid");
    });

    it("should filter out undefined/empty values", () => {
      const ctx: TurnContextLike = {
        activity: { from: { name: "User", aadObjectId: "" } },
        turnState: new Map(),
      };
      const pairs = getCallerBaggagePairs(ctx);
      const keys = pairs.map(([k]) => k);
      // aadObjectId is empty string → filtered out
      expect(keys).not.toContain(OpenTelemetryConstants.USER_ID_KEY);
      expect(keys).toContain(OpenTelemetryConstants.USER_NAME_KEY);
    });
  });

  describe("getTargetAgentBaggagePairs", () => {
    it("should return target agent baggage pairs from activity.recipient", () => {
      const ctx = makeMockTurnContext();
      const pairs = getTargetAgentBaggagePairs(ctx);
      expect(Array.isArray(pairs)).toBe(true);
      expect(pairs.length).toBeGreaterThan(0);
      const obj = Object.fromEntries(pairs);
      expect(obj[OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]).toBe("agent-instance-1");
      expect(obj[OpenTelemetryConstants.GEN_AI_AGENT_NAME_KEY]).toBe("Agent One");
      expect(obj[OpenTelemetryConstants.GEN_AI_AGENT_DESCRIPTION_KEY]).toBe("assistant");
      expect(obj[OpenTelemetryConstants.GEN_AI_AGENT_AUID_KEY]).toBe("agent-oid");
    });

    it("should return empty array when recipient is undefined", () => {
      const ctx: TurnContextLike = { activity: {}, turnState: new Map() };
      const pairs = getTargetAgentBaggagePairs(ctx);
      expect(pairs).toEqual([]);
    });

    it("should include auth-resolved agent ID when authToken is provided", () => {
      const ctx = makeMockTurnContext();
      // Create a fake JWT with appid claim
      const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
      const payload = Buffer.from(JSON.stringify({ appid: "token-agent-id" })).toString("base64");
      const fakeToken = `${header}.${payload}.sig`;
      const pairs = getTargetAgentBaggagePairs(ctx, fakeToken);
      const obj = Object.fromEntries(pairs);
      // When isAgenticRequest returns true and token provided, blueprint from token is used
      expect(obj[OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY]).toBe("agent-instance-1");
    });
  });

  describe("resolveEmbodiedAgentIds", () => {
    it("should return agent IDs for agentic requests", () => {
      const ctx = makeMockTurnContext();
      const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
      const payload = Buffer.from(JSON.stringify({ appid: "bp-from-token" })).toString("base64");
      const token = `${header}.${payload}.sig`;
      const result = resolveEmbodiedAgentIds(ctx, token);
      expect(result.agentId).toBe("agent-instance-1");
      expect(result.agentBlueprintId).toBe("bp-from-token");
    });

    it("should return undefined for non-agentic requests", () => {
      const ctx: TurnContextLike = {
        activity: {
          isAgenticRequest: () => false,
          recipient: { name: "Agent" },
        },
        turnState: new Map(),
      };
      const result = resolveEmbodiedAgentIds(ctx, "some-token");
      expect(result.agentId).toBeUndefined();
      expect(result.agentBlueprintId).toBeUndefined();
    });

    it("should handle empty token", () => {
      const ctx = makeMockTurnContext();
      const result = resolveEmbodiedAgentIds(ctx, "");
      expect(result.agentId).toBe("agent-instance-1");
      // Empty token → getAgentIdFromToken returns "" → undefined
      expect(result.agentBlueprintId).toBeUndefined();
    });

    it("should use xms_par_app_azp over appid over azp from JWT", () => {
      const ctx = makeMockTurnContext();
      const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
      const payload = Buffer.from(
        JSON.stringify({ xms_par_app_azp: "xms-id", appid: "appid-id", azp: "azp-id" }),
      ).toString("base64");
      const token = `${header}.${payload}.sig`;
      const result = resolveEmbodiedAgentIds(ctx, token);
      expect(result.agentBlueprintId).toBe("xms-id");
    });
  });

  describe("getTenantIdPair", () => {
    it("should return tenant ID pair when available", () => {
      const ctx = makeMockTurnContext();
      const pairs = getTenantIdPair(ctx);
      expect(pairs).toEqual([[OpenTelemetryConstants.TENANT_ID_KEY, "tenant1"]]);
    });

    it("should return empty array when tenantId is not available", () => {
      const ctx: TurnContextLike = {
        activity: { getAgenticTenantId: () => undefined as unknown as string },
        turnState: new Map(),
      };
      const pairs = getTenantIdPair(ctx);
      expect(pairs).toEqual([]);
    });
  });

  describe("getChannelBaggagePairs", () => {
    it("should return channel baggage pairs", () => {
      const ctx = makeMockTurnContext();
      const pairs = getChannelBaggagePairs(ctx);
      expect(Array.isArray(pairs)).toBe(true);
      const obj = Object.fromEntries(pairs);
      expect(obj[OpenTelemetryConstants.CHANNEL_NAME_KEY]).toBe("web");
      expect(obj[OpenTelemetryConstants.CHANNEL_LINK_KEY]).toBe("general");
    });

    it("should return empty array when context is null", () => {
      const pairs = getChannelBaggagePairs(null as unknown as TurnContextLike);
      expect(pairs).toEqual([]);
    });
  });

  describe("getConversationIdAndItemLinkPairs", () => {
    it("should return conversation ID and item link", () => {
      const ctx = makeMockTurnContext();
      const pairs = getConversationIdAndItemLinkPairs(ctx);
      const obj = Object.fromEntries(pairs);
      expect(obj[OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY]).toBe("conv-1");
      expect(obj[OpenTelemetryConstants.GEN_AI_CONVERSATION_ITEM_LINK_KEY]).toBe(
        "https://smba.trafficmanager.net/teams/",
      );
    });

    it("should return empty array when context is null", () => {
      const pairs = getConversationIdAndItemLinkPairs(null as unknown as TurnContextLike);
      expect(pairs).toEqual([]);
    });
  });
});
