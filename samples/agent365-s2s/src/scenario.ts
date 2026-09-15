// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ExecuteToolScope,
  FinishReason,
  InferenceOperationType,
  InferenceScope,
  InvokeAgentScope,
  MessageRole,
  type AgentDetails,
  type A365Request,
  type CallerDetails,
} from "@microsoft/opentelemetry";

import type { SampleConfig } from "./config.js";

function at(startMilliseconds: number, offsetMilliseconds: number): Date {
  return new Date(startMilliseconds + offsetMilliseconds);
}

export async function runScenario(
  config: Pick<SampleConfig, "agentId" | "tenantId">,
  startMilliseconds = Date.now(),
): Promise<void> {
  const agentDetails: AgentDetails = {
    agentId: config.agentId,
    tenantId: config.tenantId,
    agentName: "Synthetic Weather Agent",
    agentDescription: "Publishes deterministic sample telemetry only",
    agentAUID: "synthetic-agentic-user-id",
    agentEmail: "synthetic-agent@invalid.example",
    agentBlueprintId: "66666666-6666-4666-8666-666666666666",
    providerName: "sample",
    agentVersion: "1.0.0",
  };
  const callerDetails: CallerDetails = {
    userDetails: {
      userId: "synthetic-publisher-user",
      userName: "Synthetic Publisher",
      userEmail: "synthetic-publisher@invalid.example",
      tenantId: config.tenantId,
    },
    callerAgentDetails: {
      agentId: "44444444-4444-4444-8444-444444444444",
      agentName: "Synthetic Publishing Agent",
      agentAUID: "synthetic-publishing-agent-user",
      agentEmail: "synthetic-publishing-agent@invalid.example",
      agentBlueprintId: "77777777-7777-4777-8777-777777777777",
      platformId: "agent365-s2s-sample",
      agentVersion: "1.0.0",
      tenantId: config.tenantId,
    },
  };
  const request: A365Request = {
    conversationId: "synthetic-conversation",
    sessionId: "synthetic-session",
    channel: {
      id: "synthetic-channel",
      name: "Agent365 S2S sample",
      description: "Synthetic local scenario",
    },
    content: "What is the weather in Seattle?",
  };

  const invoke = InvokeAgentScope.start(
    request,
    { endpoint: { host: "synthetic-agent.invalid", port: 443 } },
    agentDetails,
    callerDetails,
    { startTime: at(startMilliseconds, 0), endTime: at(startMilliseconds, 400) },
  );

  try {
    await invoke.withActiveSpanAsync(async () => {
      const firstInference = InferenceScope.start(
        request,
        {
          operationName: InferenceOperationType.CHAT,
          model: "synthetic-tool-selector",
          providerName: "sample",
          endpoint: { host: "synthetic-model.invalid", port: 443 },
        },
        agentDetails,
        callerDetails.userDetails,
        {
          startTime: at(startMilliseconds, 10),
          endTime: at(startMilliseconds, 110),
        },
      );
      firstInference.recordInputMessages(["Select a tool for the synthetic weather request."]);
      firstInference.recordOutputMessages({
        messages: [
          {
            role: MessageRole.ASSISTANT,
            finish_reason: FinishReason.TOOL_CALL,
            parts: [
              {
                type: "tool_call",
                id: "synthetic-tool-call",
                name: "lookup_weather",
                arguments: { city: "Seattle" },
              },
            ],
          },
        ],
      });
      firstInference.recordInputTokens(48);
      firstInference.recordOutputTokens(18);
      firstInference.recordFinishReasons([FinishReason.TOOL_CALL]);
      firstInference.dispose();

      const tool = ExecuteToolScope.start(
        request,
        {
          toolName: "lookup_weather",
          toolCallId: "synthetic-tool-call",
          toolType: "function",
          description: "Returns deterministic synthetic weather",
          arguments: { city: "Seattle" },
        },
        agentDetails,
        callerDetails.userDetails,
        {
          startTime: at(startMilliseconds, 130),
          endTime: at(startMilliseconds, 180),
        },
      );
      tool.recordResponse({
        condition: "sunny",
        temperatureFahrenheit: 72,
      });
      tool.dispose();

      const finalInference = InferenceScope.start(
        request,
        {
          operationName: InferenceOperationType.CHAT,
          model: "synthetic-response-writer",
          providerName: "sample",
          endpoint: { host: "synthetic-model.invalid", port: 443 },
        },
        agentDetails,
        callerDetails.userDetails,
        {
          startTime: at(startMilliseconds, 200),
          endTime: at(startMilliseconds, 300),
        },
      );
      finalInference.recordInputMessages([
        "The synthetic tool returned sunny and 72 degrees Fahrenheit.",
      ]);
      finalInference.recordOutputMessages({
        messages: [
          {
            role: MessageRole.ASSISTANT,
            finish_reason: FinishReason.STOP,
            parts: [
              {
                type: "text",
                content: "The synthetic weather is sunny and 72°F in Seattle.",
              },
            ],
          },
        ],
      });
      finalInference.recordInputTokens(32);
      finalInference.recordOutputTokens(14);
      finalInference.recordFinishReasons([FinishReason.STOP]);
      finalInference.dispose();
    });

    invoke.recordResponse("The synthetic weather is sunny and 72°F in Seattle.");
  } finally {
    invoke.dispose();
  }
}
