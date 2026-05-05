// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * TurnContext utility methods for extracting OpenTelemetry baggage pairs.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability-hosting/src/utils/TurnContextUtils.ts
 */

import { OpenTelemetryConstants } from "../constants.js";
import type { TurnContextLike } from "./types.js";

function normalizePairs(pairs: Array<[string, string | undefined]>): Array<[string, string]> {
  return pairs
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => [k, String(v)]);
}

/**
 * Extracts caller-related OpenTelemetry baggage pairs from the TurnContext.
 */
export function getCallerBaggagePairs(turnContext: TurnContextLike): Array<[string, string]> {
  if (!turnContext?.activity?.from) {
    return [];
  }
  const from = turnContext.activity.from;
  const pairs: Array<[string, string | undefined]> = [
    [OpenTelemetryConstants.USER_ID_KEY, from.aadObjectId || from.agenticUserId || from.id],
    [OpenTelemetryConstants.USER_NAME_KEY, from.name],
    [OpenTelemetryConstants.USER_EMAIL_KEY, from.agenticUserId],
    [OpenTelemetryConstants.GEN_AI_CALLER_AGENT_APPLICATION_ID_KEY, from.agenticAppBlueprintId],
  ];
  return normalizePairs(pairs);
}

/**
 * Resolves the agent instance ID and blueprint ID for embodied (agentic) agents.
 * For non-embodied agents, both fields are undefined.
 * @param turnContext Activity context
 * @param authToken Auth token for resolving blueprint ID from token claims.
 */
export function resolveEmbodiedAgentIds(
  turnContext: TurnContextLike,
  authToken: string,
): { agentId: string | undefined; agentBlueprintId: string | undefined } {
  const isAgentic = turnContext?.activity?.isAgenticRequest?.();
  const rawAgentId = isAgentic ? turnContext.activity.getAgenticInstanceId?.() : undefined;
  const rawBlueprintId = isAgentic ? getAgentIdFromToken(authToken) : undefined;
  return {
    agentId: rawAgentId || undefined,
    agentBlueprintId: rawBlueprintId || undefined,
  };
}

/**
 * Extracts agent/recipient-related OpenTelemetry baggage pairs from the TurnContext.
 */
export function getTargetAgentBaggagePairs(
  turnContext: TurnContextLike,
  authToken?: string,
): Array<[string, string]> {
  if (!turnContext?.activity?.recipient) {
    return [];
  }
  const recipient = turnContext.activity.recipient;
  const { agentId } = authToken
    ? resolveEmbodiedAgentIds(turnContext, authToken)
    : {
        agentId: turnContext.activity?.isAgenticRequest?.()
          ? turnContext.activity.getAgenticInstanceId?.()
          : undefined,
      };
  const pairs: Array<[string, string | undefined]> = [
    [OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY, agentId],
    [OpenTelemetryConstants.GEN_AI_AGENT_NAME_KEY, recipient.name],
    [OpenTelemetryConstants.GEN_AI_AGENT_DESCRIPTION_KEY, recipient.role],
    [OpenTelemetryConstants.GEN_AI_AGENT_AUID_KEY, recipient.aadObjectId],
  ];
  return normalizePairs(pairs);
}

/**
 * Extracts the tenant ID baggage key-value pair.
 */
export function getTenantIdPair(turnContext: TurnContextLike): Array<[string, string]> {
  const tenantId = turnContext.activity?.getAgenticTenantId?.();
  return tenantId ? [[OpenTelemetryConstants.TENANT_ID_KEY, tenantId]] : [];
}

/**
 * Extracts channel baggage pairs from the TurnContext.
 */
export function getChannelBaggagePairs(turnContext: TurnContextLike): Array<[string, string]> {
  if (!turnContext) {
    return [];
  }
  const pairs: Array<[string, string | undefined]> = [
    [OpenTelemetryConstants.CHANNEL_NAME_KEY, turnContext.activity?.channelId],
    [
      OpenTelemetryConstants.CHANNEL_LINK_KEY,
      turnContext.activity?.channelIdSubChannel as string | undefined,
    ],
  ];
  return normalizePairs(pairs);
}

/**
 * Extracts conversation ID and item link baggage pairs.
 */
export function getConversationIdAndItemLinkPairs(
  turnContext: TurnContextLike,
): Array<[string, string]> {
  if (!turnContext) {
    return [];
  }
  const conversationId = turnContext.activity?.conversation?.id;
  const itemLink = turnContext.activity?.serviceUrl;
  const pairs: Array<[string, string | undefined]> = [
    [OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY, conversationId],
    [OpenTelemetryConstants.GEN_AI_CONVERSATION_ITEM_LINK_KEY, itemLink],
  ];
  return normalizePairs(pairs);
}

// ---------------------------------------------------------------------------
// Inline token decode (replaces @microsoft/agents-a365-runtime Utility)
// ---------------------------------------------------------------------------

/**
 * Decode the JWT and return the best available agent identifier.
 * Priority: xms_par_app_azp > appid > azp.
 *
 * WARNING: NO SIGNATURE VERIFICATION — suitable only for logging/diagnostics.
 */
function getAgentIdFromToken(token: string): string {
  if (!token || token.trim() === "") return "";
  try {
    const parts = token.split(".");
    if (parts.length < 2) return "";
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    return (
      (decoded["xms_par_app_azp"] as string) ||
      (decoded["appid"] as string) ||
      (decoded["azp"] as string) ||
      ""
    );
  } catch {
    return "";
  }
}
