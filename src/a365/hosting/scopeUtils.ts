// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Utilities to populate scope parameters from a TurnContext.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability-hosting/src/utils/ScopeUtils.ts
 */

import type { SpanKind, TimeInput } from "@opentelemetry/api";
import type { TurnContextLike } from "./types.js";
import { resolveEmbodiedAgentIds } from "./turnContextUtils.js";
import { InvokeAgentScope, InferenceScope, ExecuteToolScope } from "../scopes/index.js";
import type {
  AgentDetails,
  UserDetails,
  CallerDetails,
  Request,
  SpanDetails,
  InvokeAgentScopeDetails,
  ToolCallDetails,
  InferenceDetails,
} from "../contracts.js";

/**
 * Unified utilities to populate scope tags from a TurnContext.
 */
export class ScopeUtils {
  // ── Context-derived helpers ─────────────────────────────────────

  /**
   * Derive target agent details from the activity recipient.
   */
  public static deriveAgentDetails(
    turnContext: TurnContextLike,
    authToken: string,
  ): AgentDetails | undefined {
    const recipient = turnContext?.activity?.recipient;
    if (!recipient) return undefined;
    const { agentId, agentBlueprintId } = resolveEmbodiedAgentIds(turnContext, authToken);
    return {
      agentId,
      agentName: recipient.name,
      agentAUID: recipient.aadObjectId,
      agentBlueprintId,
      agentEmail: turnContext?.activity?.getAgenticUser?.(),
      agentDescription: recipient.role,
      tenantId: turnContext?.activity?.getAgenticTenantId?.(),
    } as AgentDetails;
  }

  /**
   * Derive caller agent details from the activity from.
   */
  public static deriveCallerAgent(turnContext: TurnContextLike): AgentDetails | undefined {
    const from = turnContext?.activity?.from;
    if (!from) return undefined;
    return {
      agentBlueprintId: from.agenticAppBlueprintId,
      agentName: from.name,
      agentAUID: from.aadObjectId,
      agentDescription: from.role,
      tenantId: from.tenantId,
      agentId: from.agenticAppId,
      agentEmail: from.agenticUserId,
    } as AgentDetails;
  }

  /**
   * Derive caller identity details (id, email, name, tenant) from the activity from.
   */
  public static deriveCallerDetails(turnContext: TurnContextLike): UserDetails | undefined {
    const from = turnContext?.activity?.from;
    if (!from) return undefined;
    return {
      userId: from.aadObjectId,
      userEmail: from.agenticUserId,
      userName: from.name,
      tenantId: from.tenantId,
    } as UserDetails;
  }

  /**
   * Derive conversation id from the TurnContext.
   */
  public static deriveConversationId(turnContext: TurnContextLike): string | undefined {
    return turnContext?.activity?.conversation?.id;
  }

  /**
   * Derive channel (name and description) from the TurnContext.
   */
  public static deriveChannelObject(turnContext: TurnContextLike): {
    name?: string;
    description?: string;
  } {
    return {
      name: turnContext?.activity?.channelId,
      description: turnContext?.activity?.channelIdSubChannel as string | undefined,
    };
  }

  // ── Scope factory helpers ───────────────────────────────────────

  private static setInputMessageTags(
    scope: InvokeAgentScope | InferenceScope,
    turnContext: TurnContextLike,
  ): void {
    if (turnContext?.activity?.text) {
      scope.recordInputMessages([turnContext.activity.text]);
    }
  }

  /**
   * Create an `InferenceScope` enriched with values from the TurnContext.
   */
  static populateInferenceScopeFromTurnContext(
    details: InferenceDetails,
    turnContext: TurnContextLike,
    authToken: string,
    startTime?: TimeInput,
    endTime?: TimeInput,
  ): InferenceScope {
    const agent = ScopeUtils.deriveAgentDetails(turnContext, authToken);
    const caller = ScopeUtils.deriveCallerDetails(turnContext);
    const conversationId = ScopeUtils.deriveConversationId(turnContext);
    const channel = ScopeUtils.deriveChannelObject(turnContext);

    if (!agent) {
      throw new Error(
        "populateInferenceScopeFromTurnContext: Missing agent details on TurnContext (recipient)",
      );
    }

    const hasChannel = channel.name !== undefined || channel.description !== undefined;
    const request: Request = {
      conversationId,
      ...(hasChannel ? { channel: { name: channel.name, description: channel.description } } : {}),
    };

    const spanDetails: SpanDetails | undefined =
      startTime || endTime ? { startTime, endTime } : undefined;

    const scope = InferenceScope.start(request, details, agent, caller, spanDetails);
    this.setInputMessageTags(scope, turnContext);
    return scope;
  }

  /**
   * Create an `InvokeAgentScope` enriched with values from the TurnContext.
   */
  static populateInvokeAgentScopeFromTurnContext(
    details: AgentDetails,
    scopeDetails: InvokeAgentScopeDetails,
    turnContext: TurnContextLike,
    authToken: string,
    startTime?: TimeInput,
    endTime?: TimeInput,
    spanKind?: SpanKind,
  ): InvokeAgentScope {
    const callerAgent = ScopeUtils.deriveCallerAgent(turnContext);
    const caller = ScopeUtils.deriveCallerDetails(turnContext);
    const conversationId = ScopeUtils.deriveConversationId(turnContext);
    const channel = ScopeUtils.deriveChannelObject(turnContext);

    const agentDetails = ScopeUtils.buildInvokeAgentDetailsCore(details, turnContext, authToken);

    const hasChannel = channel.name !== undefined || channel.description !== undefined;
    const request: Request = {
      conversationId,
      ...(hasChannel ? { channel: { name: channel.name, description: channel.description } } : {}),
    };

    const callerDetails: CallerDetails = {
      userDetails: caller,
      callerAgentDetails: callerAgent,
    };

    const spanDetailsObj: SpanDetails | undefined =
      startTime || endTime || spanKind ? { startTime, endTime, spanKind } : undefined;

    const scope = InvokeAgentScope.start(
      request,
      scopeDetails,
      agentDetails,
      callerDetails,
      spanDetailsObj,
    );
    this.setInputMessageTags(scope, turnContext);
    return scope;
  }

  /**
   * Build agent details by merging provided details with TurnContext.
   */
  public static buildInvokeAgentDetails(
    details: AgentDetails,
    turnContext: TurnContextLike,
    authToken: string,
  ): AgentDetails {
    return ScopeUtils.buildInvokeAgentDetailsCore(details, turnContext, authToken);
  }

  private static buildInvokeAgentDetailsCore(
    details: AgentDetails,
    turnContext: TurnContextLike,
    authToken: string,
  ): AgentDetails {
    const derivedAgentDetails = ScopeUtils.deriveAgentDetails(turnContext, authToken);
    return {
      ...details,
      ...(derivedAgentDetails ?? {}),
    };
  }

  /**
   * Create an `ExecuteToolScope` enriched with values from the TurnContext.
   */
  static populateExecuteToolScopeFromTurnContext(
    details: ToolCallDetails,
    turnContext: TurnContextLike,
    authToken: string,
    startTime?: TimeInput,
    endTime?: TimeInput,
    spanKind?: SpanKind,
  ): ExecuteToolScope {
    const agent = ScopeUtils.deriveAgentDetails(turnContext, authToken);
    const caller = ScopeUtils.deriveCallerDetails(turnContext);
    const conversationId = ScopeUtils.deriveConversationId(turnContext);
    const channel = ScopeUtils.deriveChannelObject(turnContext);

    if (!agent) {
      throw new Error(
        "populateExecuteToolScopeFromTurnContext: Missing agent details on TurnContext (recipient)",
      );
    }

    const hasChannel = channel.name !== undefined || channel.description !== undefined;
    const request: Request = {
      conversationId,
      ...(hasChannel ? { channel: { name: channel.name, description: channel.description } } : {}),
    };

    const spanDetailsObj: SpanDetails | undefined =
      startTime || endTime || spanKind ? { startTime, endTime, spanKind } : undefined;

    return ExecuteToolScope.start(request, details, agent, caller, spanDetailsObj);
  }
}
