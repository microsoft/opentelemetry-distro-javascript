// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind } from "@opentelemetry/api";
import { OpenTelemetryScope } from "./OpenTelemetryScope.js";
import { OpenTelemetryConstants } from "../constants.js";
import { safeSerializeToJson } from "../message-utils.js";
import type {
  ToolCallDetails,
  AgentDetails,
  UserDetails,
  Request,
  SpanDetails,
} from "../contracts.js";

/**
 * Provides OpenTelemetry tracing scope for AI tool execution operations.
 */
export class ExecuteToolScope extends OpenTelemetryScope {
  /**
   * Creates and starts a new scope for tool execution tracing.
   *
   * @param request Request payload (channel, conversationId, content, sessionId).
   * @param details The tool call details (name, type, args, call id, etc.).
   * @param agentDetails The agent executing the tool. `tenantId` is required.
   * @param userDetails Optional human caller identity.
   * @param spanDetails Optional span configuration. Defaults to SpanKind.INTERNAL.
   */
  public static start(
    request: Request,
    details: ToolCallDetails,
    agentDetails: AgentDetails,
    userDetails?: UserDetails,
    spanDetails?: SpanDetails,
  ): ExecuteToolScope {
    return new ExecuteToolScope(request, details, agentDetails, userDetails, spanDetails);
  }

  private constructor(
    request: Request,
    details: ToolCallDetails,
    agentDetails: AgentDetails,
    userDetails?: UserDetails,
    spanDetails?: SpanDetails,
  ) {
    if (!agentDetails.tenantId) {
      throw new Error("ExecuteToolScope: tenantId is required on agentDetails");
    }

    const resolvedSpanDetails: SpanDetails = {
      spanKind: SpanKind.INTERNAL,
      ...spanDetails,
    };

    super(
      OpenTelemetryConstants.EXECUTE_TOOL_OPERATION_NAME,
      `${OpenTelemetryConstants.EXECUTE_TOOL_OPERATION_NAME} ${details.toolName}`,
      agentDetails,
      resolvedSpanDetails,
      userDetails,
    );

    const { toolName, arguments: args, toolCallId, description, toolType, endpoint } = details;

    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_TOOL_NAME_KEY, toolName);
    this.setTagMaybe(
      OpenTelemetryConstants.GEN_AI_TOOL_ARGS_KEY,
      args != null ? safeSerializeToJson(args, "arguments") : undefined,
    );
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_TOOL_TYPE_KEY, toolType);
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_TOOL_CALL_ID_KEY, toolCallId);
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_TOOL_DESCRIPTION_KEY, description);

    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY, request.conversationId);
    this.setTagMaybe(OpenTelemetryConstants.CHANNEL_NAME_KEY, request.channel?.name);
    this.setTagMaybe(OpenTelemetryConstants.CHANNEL_LINK_KEY, request.channel?.description);

    if (endpoint) {
      this.setTagMaybe(OpenTelemetryConstants.SERVER_ADDRESS_KEY, endpoint.host);
      if (endpoint.port && endpoint.port !== 443) {
        this.setTagMaybe(OpenTelemetryConstants.SERVER_PORT_KEY, endpoint.port);
      }
    }
  }

  /**
   * Records response information for telemetry tracking.
   * Objects are serialized to JSON automatically.
   */
  public recordResponse(response: Record<string, unknown> | string): void {
    this.setTagMaybe(
      OpenTelemetryConstants.GEN_AI_TOOL_CALL_RESULT_KEY,
      safeSerializeToJson(response, "result"),
    );
  }
}
