// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind } from "@opentelemetry/api";
import { OpenTelemetryScope } from "./OpenTelemetryScope.js";
import { OpenTelemetryConstants } from "../constants.js";
import { safeSerializeToJson, serializeToolPayload } from "../message-utils.js";
import { TransferMode, TransferTargetType } from "../contracts.js";
import type {
  ToolCallDetails,
  AgentDetails,
  ExecuteToolCallResult,
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

    const transfer = details.transferDetails;
    const targetType = transfer?.targetType ?? TransferTargetType.AGENT;
    if (transfer) {
      if (!Object.values(TransferMode).includes(transfer.mode)) {
        throw new RangeError("ExecuteToolScope: invalid transfer mode");
      }
      if (!Object.values(TransferTargetType).includes(targetType)) {
        throw new RangeError("ExecuteToolScope: invalid transfer target type");
      }
      if (targetType !== TransferTargetType.AGENT && transfer.targetAgentDetails != null) {
        throw new TypeError("ExecuteToolScope: target agent details require an agent transfer");
      }
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
      request,
    );

    const { toolName, arguments: args, toolCallId, description, toolType, endpoint } = details;

    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_TOOL_NAME_KEY, toolName);
    this.setTagMaybe(
      OpenTelemetryConstants.GEN_AI_TOOL_ARGS_KEY,
      typeof args === "string"
        ? safeSerializeToJson(args, "arguments")
        : serializeToolPayload(args),
    );
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_TOOL_TYPE_KEY, toolType);
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_TOOL_CALL_ID_KEY, toolCallId);
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_TOOL_DESCRIPTION_KEY, description);

    if (transfer) {
      this.setTagMaybe(OpenTelemetryConstants.TRANSFER_MODE_KEY, transfer.mode);
      this.setTagMaybe(OpenTelemetryConstants.TRANSFER_TARGET_TYPE_KEY, targetType);
      const target = transfer.targetAgentDetails;
      this.setTagMaybe(OpenTelemetryConstants.TRANSFER_TARGET_AGENT_ID_KEY, target?.agentId);
      this.setTagMaybe(OpenTelemetryConstants.TRANSFER_TARGET_AGENT_NAME_KEY, target?.agentName);
      this.setTagMaybe(
        OpenTelemetryConstants.TRANSFER_TARGET_AGENT_BLUEPRINT_ID_KEY,
        target?.agentBlueprintId,
      );
      this.setTagMaybe(
        OpenTelemetryConstants.TRANSFER_TARGET_AGENT_PLATFORM_ID_KEY,
        target?.platformId,
      );
      this.setTagMaybe(
        OpenTelemetryConstants.TRANSFER_TARGET_AGENT_VERSION_KEY,
        target?.agentVersion,
      );
    }

    if (endpoint) {
      this.setTagMaybe(OpenTelemetryConstants.SERVER_ADDRESS_KEY, endpoint.host);
      this.setTagMaybe(OpenTelemetryConstants.URL_FULL_KEY, endpoint.url);
      if (endpoint.port && endpoint.port !== 443) {
        this.setTagMaybe(OpenTelemetryConstants.SERVER_PORT_KEY, endpoint.port);
      }
    }
  }

  /**
   * Records response information for telemetry tracking.
   * Objects are serialized to JSON automatically.
   */
  public recordResponse(response: ExecuteToolCallResult | null | undefined): void;
  public recordResponse(response: Record<string, unknown> | string): void;
  public recordResponse(
    response: Record<string, unknown> | ExecuteToolCallResult | string | null | undefined,
  ): void {
    this.setTagMaybe(
      OpenTelemetryConstants.GEN_AI_TOOL_CALL_RESULT_KEY,
      typeof response === "string"
        ? safeSerializeToJson(response, "result")
        : serializeToolPayload(response),
    );
  }
}
