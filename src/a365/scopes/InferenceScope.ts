// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind } from "@opentelemetry/api";
import { OpenTelemetryScope } from "./OpenTelemetryScope.js";
import { OpenTelemetryConstants } from "../constants.js";
import type {
  InferenceDetails,
  AgentDetails,
  UserDetails,
  Request,
  SpanDetails,
  InputMessagesParam,
  OutputMessagesParam,
} from "../contracts.js";

/**
 * Provides OpenTelemetry tracing scope for generative AI inference operations.
 */
export class InferenceScope extends OpenTelemetryScope {
  /**
   * Creates and starts a new scope for inference tracing.
   *
   * @param request Request payload (channel, conversationId, content, sessionId).
   * @param details The inference call details (model, provider, tokens, etc.).
   * @param agentDetails The agent performing the inference. `tenantId` is required.
   * @param userDetails Optional human caller identity.
   * @param spanDetails Optional span configuration. `spanKind` is always CLIENT.
   */
  public static start(
    request: Request,
    details: InferenceDetails,
    agentDetails: AgentDetails,
    userDetails?: UserDetails,
    spanDetails?: SpanDetails,
  ): InferenceScope {
    return new InferenceScope(request, details, agentDetails, userDetails, spanDetails);
  }

  private constructor(
    request: Request,
    details: InferenceDetails,
    agentDetails: AgentDetails,
    userDetails?: UserDetails,
    spanDetails?: SpanDetails,
  ) {
    if (!agentDetails.tenantId) {
      throw new Error("InferenceScope: tenantId is required on agentDetails");
    }

    // spanKind for InferenceScope is always CLIENT
    const resolvedSpanDetails: SpanDetails = { ...spanDetails, spanKind: SpanKind.CLIENT };

    super(
      details.operationName.toString(),
      `${details.operationName} ${details.model}`,
      agentDetails,
      resolvedSpanDetails,
      userDetails,
    );

    // Core inference information
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_REQUEST_MODEL_KEY, details.model);
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_PROVIDER_NAME_KEY, details.providerName);
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_USAGE_INPUT_TOKENS_KEY, details.inputTokens);
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_USAGE_OUTPUT_TOKENS_KEY, details.outputTokens);
    this.setTagMaybe(
      OpenTelemetryConstants.GEN_AI_RESPONSE_FINISH_REASONS_KEY,
      details.finishReasons,
    );
    this.setTagMaybe(
      OpenTelemetryConstants.GEN_AI_AGENT_THOUGHT_PROCESS_KEY,
      details.thoughtProcess,
    );

    // Conversation and channel
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY, request.conversationId);
    this.setTagMaybe(OpenTelemetryConstants.CHANNEL_NAME_KEY, request.channel?.name);
    this.setTagMaybe(OpenTelemetryConstants.CHANNEL_LINK_KEY, request.channel?.description);

    // Endpoint
    if (details.endpoint) {
      this.setTagMaybe(OpenTelemetryConstants.SERVER_ADDRESS_KEY, details.endpoint.host);
      if (details.endpoint.port && details.endpoint.port !== 443) {
        this.setTagMaybe(OpenTelemetryConstants.SERVER_PORT_KEY, details.endpoint.port);
      }
    }
  }

  /** Records the number of input tokens. */
  public recordInputTokens(inputTokens: number): void {
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_USAGE_INPUT_TOKENS_KEY, inputTokens);
  }

  /** Records the number of output tokens. */
  public recordOutputTokens(outputTokens: number): void {
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_USAGE_OUTPUT_TOKENS_KEY, outputTokens);
  }

  /** Records the finish reasons. */
  public recordFinishReasons(finishReasons: string[]): void {
    if (finishReasons && finishReasons.length > 0) {
      this.setTagMaybe(OpenTelemetryConstants.GEN_AI_RESPONSE_FINISH_REASONS_KEY, finishReasons);
    }
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
