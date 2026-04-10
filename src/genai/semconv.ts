// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * GenAI semantic conventions (incubating/unstable).
 *
 * Per OTel recommendation, unstable conventions are copied locally rather than
 * imported from @opentelemetry/semantic-conventions/incubating.
 * See: https://opentelemetry.io/docs/specs/semconv/non-normative/code-generation/#stability-and-versioning
 *
 * Sourced from OTel semantic conventions + microsoft/Agent365-nodejs.
 */

// --- Span operation names ---
export const GEN_AI_OPERATION_INVOKE_AGENT = "invoke_agent" as const;
export const GEN_AI_OPERATION_EXECUTE_TOOL = "execute_tool" as const;
export const GEN_AI_OPERATION_OUTPUT_MESSAGES = "output_messages" as const;
export const GEN_AI_OPERATION_CHAT = "chat" as const;

// --- Attributes (ATTR_ prefix, following OTel convention) ---

// Error
export const ATTR_ERROR_TYPE = "error.type" as const;
export const ATTR_ERROR_MESSAGE = "error.message" as const;

// GenAI core
export const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name" as const;
export const ATTR_GEN_AI_REQUEST_MODEL = "gen_ai.request.model" as const;
export const ATTR_GEN_AI_RESPONSE_MODEL = "gen_ai.response.model" as const;
export const ATTR_GEN_AI_PROVIDER_NAME = "gen_ai.provider.name" as const;
export const ATTR_GEN_AI_SYSTEM_INSTRUCTIONS = "gen_ai.system_instructions" as const;
export const ATTR_GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages" as const;
export const ATTR_GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages" as const;

// GenAI usage
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens" as const;
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens" as const;

// GenAI agent
export const ATTR_GEN_AI_AGENT_ID = "gen_ai.agent.id" as const;
export const ATTR_GEN_AI_AGENT_NAME = "gen_ai.agent.name" as const;

// GenAI tool
export const ATTR_GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id" as const;
export const ATTR_GEN_AI_TOOL_NAME = "gen_ai.tool.name" as const;
export const ATTR_GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments" as const;
export const ATTR_GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result" as const;
export const ATTR_GEN_AI_TOOL_TYPE = "gen_ai.tool.type" as const;

// Microsoft-specific (not in OTel semconv)
export const ATTR_MICROSOFT_SESSION_ID = "microsoft.session.id" as const;
