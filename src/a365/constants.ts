// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * OpenTelemetry constants for A365 observability.
 *
 * Attribute keys follow OTel gen-ai semantic conventions plus
 * Microsoft-specific extensions under the `microsoft.*` namespace.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability/src/tracing/constants.ts
 */
export class OpenTelemetryConstants {
  // ── Span operation names ──────────────────────────────────────────
  public static readonly INVOKE_AGENT_OPERATION_NAME = "invoke_agent";
  public static readonly EXECUTE_TOOL_OPERATION_NAME = "execute_tool";
  public static readonly OUTPUT_MESSAGES_OPERATION_NAME = "output_messages";
  public static readonly CHAT_OPERATION_NAME = "chat";

  // ── Standard OTel semantic conventions ────────────────────────────
  public static readonly ERROR_TYPE_KEY = "error.type";
  public static readonly ERROR_TYPE_CANCELLED = "TaskCanceledException";
  public static readonly ERROR_MESSAGE_KEY = "error.message";
  public static readonly AZ_NAMESPACE_KEY = "az.namespace";
  public static readonly SERVER_ADDRESS_KEY = "server.address";
  public static readonly SERVER_PORT_KEY = "server.port";

  // ── Source / SDK identity ─────────────────────────────────────────
  public static readonly SOURCE_NAME = "Agent365Sdk";

  // ── GenAI core attributes ────────────────────────────────────────
  public static readonly GEN_AI_OPERATION_NAME_KEY = "gen_ai.operation.name";
  public static readonly GEN_AI_REQUEST_MODEL_KEY = "gen_ai.request.model";
  public static readonly GEN_AI_RESPONSE_MODEL_KEY = "gen_ai.response.model";
  public static readonly GEN_AI_RESPONSE_FINISH_REASONS_KEY = "gen_ai.response.finish_reasons";
  public static readonly GEN_AI_PROVIDER_NAME_KEY = "gen_ai.provider.name";

  // ── GenAI usage ──────────────────────────────────────────────────
  public static readonly GEN_AI_USAGE_INPUT_TOKENS_KEY = "gen_ai.usage.input_tokens";
  public static readonly GEN_AI_USAGE_OUTPUT_TOKENS_KEY = "gen_ai.usage.output_tokens";

  // ── GenAI message attributes ─────────────────────────────────────
  public static readonly GEN_AI_SYSTEM_INSTRUCTIONS_KEY = "gen_ai.system_instructions";
  public static readonly GEN_AI_INPUT_MESSAGES_KEY = "gen_ai.input.messages";
  public static readonly GEN_AI_OUTPUT_MESSAGES_KEY = "gen_ai.output.messages";
  public static readonly A365_MESSAGES_SCHEMA_VERSION_KEY =
    "microsoft.a365.messages.schema_version";

  // ── GenAI agent attributes ───────────────────────────────────────
  public static readonly GEN_AI_AGENT_ID_KEY = "gen_ai.agent.id";
  public static readonly GEN_AI_AGENT_NAME_KEY = "gen_ai.agent.name";
  public static readonly GEN_AI_AGENT_DESCRIPTION_KEY = "gen_ai.agent.description";
  public static readonly GEN_AI_AGENT_VERSION_KEY = "gen_ai.agent.version";
  public static readonly GEN_AI_AGENT_PLATFORM_ID_KEY = "microsoft.a365.agent.platform.id";
  public static readonly GEN_AI_AGENT_THOUGHT_PROCESS_KEY = "microsoft.a365.agent.thought.process";
  public static readonly GEN_AI_ICON_URI_KEY = "gen_ai.agent365.icon_uri";

  // ── GenAI conversation / session ─────────────────────────────────
  public static readonly GEN_AI_CONVERSATION_ID_KEY = "gen_ai.conversation.id";
  public static readonly GEN_AI_CONVERSATION_ITEM_LINK_KEY = "microsoft.conversation.item.link";
  public static readonly SESSION_ID_KEY = "microsoft.session.id";
  public static readonly SESSION_DESCRIPTION_KEY = "microsoft.session.description";

  // ── GenAI tool attributes ────────────────────────────────────────
  public static readonly GEN_AI_TOOL_CALL_ID_KEY = "gen_ai.tool.call.id";
  public static readonly GEN_AI_TOOL_NAME_KEY = "gen_ai.tool.name";
  public static readonly GEN_AI_TOOL_DESCRIPTION_KEY = "gen_ai.tool.description";
  public static readonly GEN_AI_TOOL_ARGS_KEY = "gen_ai.tool.call.arguments";
  public static readonly GEN_AI_TOOL_CALL_RESULT_KEY = "gen_ai.tool.call.result";
  public static readonly GEN_AI_TOOL_TYPE_KEY = "gen_ai.tool.type";

  // ── Tenant ───────────────────────────────────────────────────────
  public static readonly TENANT_ID_KEY = "microsoft.tenant.id";

  // ── Human caller dimensions (OTel user.* namespace) ──────────────
  public static readonly USER_ID_KEY = "user.id";
  public static readonly USER_NAME_KEY = "user.name";
  public static readonly USER_EMAIL_KEY = "user.email";
  public static readonly GEN_AI_CALLER_CLIENT_IP_KEY = "client.address";

  // ── Agent-to-Agent caller dimensions ─────────────────────────────
  public static readonly GEN_AI_CALLER_AGENT_USER_ID_KEY = "microsoft.a365.caller.agent.user.id";
  public static readonly GEN_AI_CALLER_AGENT_EMAIL_KEY = "microsoft.a365.caller.agent.user.email";
  public static readonly GEN_AI_CALLER_AGENT_NAME_KEY = "microsoft.a365.caller.agent.name";
  public static readonly GEN_AI_CALLER_AGENT_ID_KEY = "microsoft.a365.caller.agent.id";
  public static readonly GEN_AI_CALLER_AGENT_APPLICATION_ID_KEY =
    "microsoft.a365.caller.agent.blueprint.id";
  public static readonly GEN_AI_CALLER_AGENT_PLATFORM_ID_KEY =
    "microsoft.a365.caller.agent.platform.id";
  public static readonly GEN_AI_CALLER_AGENT_VERSION_KEY = "microsoft.a365.caller.agent.version";

  // ── Baggage keys ─────────────────────────────────────────────────
  public static readonly GEN_AI_AGENT_AUID_KEY = "microsoft.agent.user.id";
  public static readonly GEN_AI_AGENT_EMAIL_KEY = "microsoft.agent.user.email";
  public static readonly GEN_AI_AGENT_BLUEPRINT_ID_KEY = "microsoft.a365.agent.blueprint.id";

  // ── Channel dimensions ───────────────────────────────────────────
  public static readonly CHANNEL_NAME_KEY = "microsoft.channel.name";
  public static readonly CHANNEL_LINK_KEY = "microsoft.channel.link";

  // ── Custom parent / span name ────────────────────────────────────
  public static readonly CUSTOM_PARENT_SPAN_ID_KEY = "custom.parent.span.id";
  public static readonly CUSTOM_SPAN_NAME_KEY = "custom.span.name";

  // ── Service attributes ───────────────────────────────────────────
  public static readonly SERVICE_NAME_KEY = "service.name";

  // ── Telemetry SDK attributes ─────────────────────────────────────
  public static readonly TELEMETRY_SDK_NAME_KEY = "telemetry.sdk.name";
  public static readonly TELEMETRY_SDK_LANGUAGE_KEY = "telemetry.sdk.language";
  public static readonly TELEMETRY_SDK_VERSION_KEY = "telemetry.sdk.version";
  public static readonly TELEMETRY_SDK_NAME_VALUE = "A365ObservabilitySDK";
  public static readonly TELEMETRY_SDK_LANGUAGE_VALUE = "nodejs";
  public static readonly TELEMETRY_SDK_VERSION_VALUE = "0.1.0";
}
