// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Constants for the GenAI "main agent" propagation feature.
 *
 * Target attribute keys written by {@link GenAIMainAgentSpanProcessor} and
 * {@link GenAIMainAgentLogRecordProcessor} so that downstream telemetry
 * (spans + logs) is attributed to the user-facing ("main") agent rather
 * than internal sub-agents in a multi-agent system.
 *
 * Mirrors `microsoft/opentelemetry-distro-python`.
 */

export const GEN_AI_MAIN_AGENT_NAME_KEY = "microsoft.gen_ai.main_agent.name" as const;
export const GEN_AI_MAIN_AGENT_ID_KEY = "microsoft.gen_ai.main_agent.id" as const;
export const GEN_AI_MAIN_AGENT_VERSION_KEY = "microsoft.gen_ai.main_agent.version" as const;
export const GEN_AI_MAIN_AGENT_CONVERSATION_ID_KEY =
  "microsoft.gen_ai.main_agent.conversation_id" as const;
export const GEN_AI_MAIN_AGENT_ATTRIBUTE_PREFIX = "microsoft.gen_ai.main_agent." as const;
