// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind } from "@opentelemetry/api";
import { OpenTelemetryScope } from "./OpenTelemetryScope.js";
import { OpenTelemetryConstants } from "../constants.js";
import type {
  InvokeAgentScopeDetails,
  CallerDetails,
  Request,
  SpanDetails,
  AgentDetails,
  InputMessagesParam,
  OutputMessagesParam,
} from "../contracts.js";

/**
 * Provides OpenTelemetry tracing scope for AI agent invocation operations.
 */
export class InvokeAgentScope extends OpenTelemetryScope {
  /**
   * Creates and starts a new scope for agent invocation tracing.
   *
   * @param request Request payload (channel, conversationId, content, sessionId).
   * @param invokeScopeDetails Scope-level details (endpoint).
   * @param agentDetails The agent identity. `tenantId` is required.
   * @param callerDetails Optional caller information (human, agent, or both for A2A).
   * @param spanDetails Optional span configuration.
   */
  public static start(
    request: Request,
    invokeScopeDetails: InvokeAgentScopeDetails,
    agentDetails: AgentDetails,
    callerDetails?: CallerDetails,
    spanDetails?: SpanDetails,
  ): InvokeAgentScope {
    return new InvokeAgentScope(
      request,
      invokeScopeDetails,
      agentDetails,
      callerDetails,
      spanDetails,
    );
  }

  private constructor(
    request: Request,
    invokeScopeDetails: InvokeAgentScopeDetails,
    agentDetails: AgentDetails,
    callerDetails?: CallerDetails,
    spanDetails?: SpanDetails,
  ) {
    if (!agentDetails.tenantId) {
      throw new Error("InvokeAgentScope: tenantId is required on agentDetails");
    }

    const resolvedSpanDetails: SpanDetails = {
      ...spanDetails,
      spanKind: spanDetails?.spanKind ?? SpanKind.CLIENT,
    };

    super(
      OpenTelemetryConstants.INVOKE_AGENT_OPERATION_NAME,
      agentDetails.agentName
        ? `${OpenTelemetryConstants.INVOKE_AGENT_OPERATION_NAME} ${agentDetails.agentName}`
        : OpenTelemetryConstants.INVOKE_AGENT_OPERATION_NAME,
      agentDetails,
      resolvedSpanDetails,
      callerDetails?.userDetails,
    );

    // Provider name
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_PROVIDER_NAME_KEY, agentDetails.providerName);

    // Session ID
    this.setTagMaybe(OpenTelemetryConstants.SESSION_ID_KEY, request.sessionId);

    // Endpoint
    if (invokeScopeDetails.endpoint) {
      this.setTagMaybe(OpenTelemetryConstants.SERVER_ADDRESS_KEY, invokeScopeDetails.endpoint.host);
      if (invokeScopeDetails.endpoint.port && invokeScopeDetails.endpoint.port !== 443) {
        this.setTagMaybe(OpenTelemetryConstants.SERVER_PORT_KEY, invokeScopeDetails.endpoint.port);
      }
    }

    // Channel
    if (request.channel) {
      this.setTagMaybe(OpenTelemetryConstants.CHANNEL_NAME_KEY, request.channel.name);
      this.setTagMaybe(OpenTelemetryConstants.CHANNEL_LINK_KEY, request.channel.description);
    }

    // Conversation ID
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY, request.conversationId);

    // Request content as input messages
    if (request.content != null) {
      this.recordInputMessages(request.content);
    }

    // Caller agent details for A2A scenarios
    const callerAgent = callerDetails?.callerAgentDetails;
    if (callerAgent) {
      this.setTagMaybe(OpenTelemetryConstants.GEN_AI_CALLER_AGENT_NAME_KEY, callerAgent.agentName);
      this.setTagMaybe(OpenTelemetryConstants.GEN_AI_CALLER_AGENT_ID_KEY, callerAgent.agentId);
      this.setTagMaybe(
        OpenTelemetryConstants.GEN_AI_CALLER_AGENT_APPLICATION_ID_KEY,
        callerAgent.agentBlueprintId,
      );
      this.setTagMaybe(
        OpenTelemetryConstants.GEN_AI_CALLER_AGENT_USER_ID_KEY,
        callerAgent.agentAUID,
      );
      this.setTagMaybe(
        OpenTelemetryConstants.GEN_AI_CALLER_AGENT_EMAIL_KEY,
        callerAgent.agentEmail,
      );
      this.setTagMaybe(
        OpenTelemetryConstants.GEN_AI_CALLER_AGENT_PLATFORM_ID_KEY,
        callerAgent.platformId,
      );
      this.setTagMaybe(
        OpenTelemetryConstants.GEN_AI_CALLER_AGENT_VERSION_KEY,
        callerAgent.agentVersion,
      );
    }
  }

  /** Records response information for telemetry tracking. */
  public recordResponse(response: string): void {
    this.recordOutputMessages(response);
  }

  /** Records the input messages for telemetry tracking. */
  public override recordInputMessages(messages: InputMessagesParam): void {
    super.recordInputMessages(messages);
  }

  /** Records the output messages for telemetry tracking. */
  public override recordOutputMessages(messages: OutputMessagesParam): void {
    super.recordOutputMessages(messages);
  }
}
