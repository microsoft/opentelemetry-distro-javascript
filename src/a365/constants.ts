// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { MICROSOFT_OPENTELEMETRY_VERSION } from "../types.js";

/**
 * OpenTelemetry constants for A365 observability.
 *
 * Provides the well-known span operation names, attribute keys, metric names,
 * environment-variable names, and feature-flag switches used when emitting A365
 * telemetry. Attribute keys follow OTel gen-ai semantic conventions plus
 * Microsoft-specific extensions under the `microsoft.*` namespace.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability/src/tracing/constants.ts
 */
export class OpenTelemetryConstants {
  // ── Span operation names ──────────────────────────────────────────

  /** Operation name (`gen_ai.operation.name`) used for agent invocation spans. */
  public static readonly INVOKE_AGENT_OPERATION_NAME = "invoke_agent";
  /** Operation name used for tool-execution spans. */
  public static readonly EXECUTE_TOOL_OPERATION_NAME = "execute_tool";
  /** Operation name used for output-message spans. */
  public static readonly OUTPUT_MESSAGES_OPERATION_NAME = "output_messages";
  /** Operation name used for model chat/inference spans. */
  public static readonly CHAT_OPERATION_NAME = "chat";

  // ── Standard OTel semantic conventions ────────────────────────────

  /** Attribute key for the error type recorded on a span (`error.type`). */
  public static readonly ERROR_TYPE_KEY = "error.type";
  /** Error-type value used when an operation was cancelled. */
  public static readonly ERROR_TYPE_CANCELLED = "TaskCanceledException";
  /** Attribute key for a human-readable error message (`error.message`). */
  public static readonly ERROR_MESSAGE_KEY = "error.message";
  /** Attribute key for the Azure resource provider namespace (`az.namespace`). */
  public static readonly AZ_NAMESPACE_KEY = "az.namespace";
  /** Attribute key for the destination server host name (`server.address`). */
  public static readonly SERVER_ADDRESS_KEY = "server.address";
  /** Attribute key for the destination server port (`server.port`). */
  public static readonly SERVER_PORT_KEY = "server.port";
  /** Azure resource provider namespace value for Cognitive Services. */
  public static readonly AZURE_RP_NAMESPACE_VALUE = "Microsoft.CognitiveServices";

  // ── Source / SDK identity ─────────────────────────────────────────

  /** Tracer/instrumentation-scope name used for all A365 spans. */
  public static readonly SOURCE_NAME = "Agent365Sdk";

  // ── Feature flags / env var names ─────────────────────────────────

  /** Feature-switch name that enables the experimental activity source. */
  public static readonly ENABLE_OPENTELEMETRY_SWITCH = "Azure.Experimental.EnableActivitySource";
  /** Feature-switch name that enables tracing of gen-ai message content. */
  public static readonly TRACE_CONTENTS_SWITCH = "Azure.Experimental.TraceGenAIMessageContent";
  /** Environment-variable name that enables recording of gen-ai message content. */
  public static readonly TRACE_CONTENTS_ENVIRONMENT_VARIABLE =
    "AZURE_TRACING_GEN_AI_CONTENT_RECORDING_ENABLED";
  /** Environment-variable name that enables observability. */
  public static readonly ENABLE_OBSERVABILITY = "ENABLE_OBSERVABILITY";
  /** Environment-variable name that enables the A365 observability exporter. */
  public static readonly ENABLE_A365_OBSERVABILITY_EXPORTER = "ENABLE_A365_OBSERVABILITY_EXPORTER";
  /** Environment-variable name that enables A365 observability. */
  public static readonly ENABLE_A365_OBSERVABILITY = "ENABLE_A365_OBSERVABILITY";

  // ── GenAI core attributes ────────────────────────────────────────

  /** Attribute key for the gen-ai operation name (`gen_ai.operation.name`). */
  public static readonly GEN_AI_OPERATION_NAME_KEY = "gen_ai.operation.name";
  /** Attribute key for the requested model name (`gen_ai.request.model`). */
  public static readonly GEN_AI_REQUEST_MODEL_KEY = "gen_ai.request.model";
  /** Attribute key for the model that produced the response (`gen_ai.response.model`). */
  public static readonly GEN_AI_RESPONSE_MODEL_KEY = "gen_ai.response.model";
  /** Attribute key for the finish reasons returned by the model (`gen_ai.response.finish_reasons`). */
  public static readonly GEN_AI_RESPONSE_FINISH_REASONS_KEY = "gen_ai.response.finish_reasons";
  /** Attribute key for the gen-ai provider name (`gen_ai.provider.name`). */
  public static readonly GEN_AI_PROVIDER_NAME_KEY = "gen_ai.provider.name";
  /** Attribute key for the requested maximum number of tokens (`gen_ai.request.max_tokens`). */
  public static readonly GEN_AI_REQUEST_MAX_TOKENS_KEY = "gen_ai.request.max_tokens";
  /** Attribute key for the sampling temperature (`gen_ai.request.temperature`). */
  public static readonly GEN_AI_REQUEST_TEMPERATURE_KEY = "gen_ai.request.temperature";
  /** Attribute key for the nucleus-sampling top-p value (`gen_ai.request.top_p`). */
  public static readonly GEN_AI_REQUEST_TOP_P_KEY = "gen_ai.request.top_p";
  /** Attribute key for a gen-ai choice (`gen_ai.choice`). */
  public static readonly GEN_AI_CHOICE = "gen_ai.choice";

  // ── GenAI metrics ────────────────────────────────────────────────

  /** Metric name for the gen-ai client operation duration. */
  public static readonly GEN_AI_CLIENT_OPERATION_DURATION_METRIC_NAME =
    "gen_ai.client.operation.duration";
  /** Metric name for gen-ai client token usage. */
  public static readonly GEN_AI_CLIENT_TOKEN_USAGE_METRIC_NAME = "gen_ai.client.token.usage";

  // ── GenAI usage ──────────────────────────────────────────────────

  /** Attribute key for the number of input (prompt) tokens (`gen_ai.usage.input_tokens`). */
  public static readonly GEN_AI_USAGE_INPUT_TOKENS_KEY = "gen_ai.usage.input_tokens";
  /** Attribute key for the number of output (completion) tokens (`gen_ai.usage.output_tokens`). */
  public static readonly GEN_AI_USAGE_OUTPUT_TOKENS_KEY = "gen_ai.usage.output_tokens";

  // ── GenAI message attributes ─────────────────────────────────────

  /** Attribute key for the system instructions (`gen_ai.system_instructions`). */
  public static readonly GEN_AI_SYSTEM_INSTRUCTIONS_KEY = "gen_ai.system_instructions";
  /** Attribute key for the serialized input messages (`gen_ai.input.messages`). */
  public static readonly GEN_AI_INPUT_MESSAGES_KEY = "gen_ai.input.messages";
  /** Attribute key for the serialized output messages (`gen_ai.output.messages`). */
  public static readonly GEN_AI_OUTPUT_MESSAGES_KEY = "gen_ai.output.messages";
  /** Attribute key for the A365 messages schema version. */
  public static readonly A365_MESSAGES_SCHEMA_VERSION_KEY =
    "microsoft.a365.messages.schema_version";

  // ── GenAI agent attributes ───────────────────────────────────────

  /** Attribute key for the agent identifier (`gen_ai.agent.id`). */
  public static readonly GEN_AI_AGENT_ID_KEY = "gen_ai.agent.id";
  /** Attribute key for the agent display name (`gen_ai.agent.name`). */
  public static readonly GEN_AI_AGENT_NAME_KEY = "gen_ai.agent.name";
  /** Attribute key for the agent description (`gen_ai.agent.description`). */
  public static readonly GEN_AI_AGENT_DESCRIPTION_KEY = "gen_ai.agent.description";
  /** Attribute key for the agent version (`gen_ai.agent.version`). */
  public static readonly GEN_AI_AGENT_VERSION_KEY = "gen_ai.agent.version";
  /** Attribute key for the agent platform identifier (`microsoft.a365.agent.platform.id`). */
  public static readonly GEN_AI_AGENT_PLATFORM_ID_KEY = "microsoft.a365.agent.platform.id";
  /** Attribute key for the agent thought process (`microsoft.a365.agent.thought.process`). */
  public static readonly GEN_AI_AGENT_THOUGHT_PROCESS_KEY = "microsoft.a365.agent.thought.process";
  /** Attribute key for the agent icon URI (`gen_ai.agent365.icon_uri`). */
  public static readonly GEN_AI_ICON_URI_KEY = "gen_ai.agent365.icon_uri";
  /** Attribute key for the agent identifier (alias of {@link GEN_AI_AGENT_ID_KEY}). */
  public static readonly AGENT_ID_KEY = "gen_ai.agent.id";

  // ── GenAI conversation / session ─────────────────────────────────

  /** Attribute key for the conversation identifier (`gen_ai.conversation.id`). */
  public static readonly GEN_AI_CONVERSATION_ID_KEY = "gen_ai.conversation.id";
  /** Attribute key for the conversation item deep link (`microsoft.conversation.item.link`). */
  public static readonly GEN_AI_CONVERSATION_ITEM_LINK_KEY = "microsoft.conversation.item.link";
  /** Attribute key for the session identifier (`microsoft.session.id`). */
  public static readonly SESSION_ID_KEY = "microsoft.session.id";
  /** Attribute key for the session description (`microsoft.session.description`). */
  public static readonly SESSION_DESCRIPTION_KEY = "microsoft.session.description";

  // ── GenAI tool attributes ────────────────────────────────────────

  /** Attribute key for the tool-call identifier (`gen_ai.tool.call.id`). */
  public static readonly GEN_AI_TOOL_CALL_ID_KEY = "gen_ai.tool.call.id";
  /** Attribute key for the tool name (`gen_ai.tool.name`). */
  public static readonly GEN_AI_TOOL_NAME_KEY = "gen_ai.tool.name";
  /** Attribute key for the tool description (`gen_ai.tool.description`). */
  public static readonly GEN_AI_TOOL_DESCRIPTION_KEY = "gen_ai.tool.description";
  /** Attribute key for the serialized tool-call arguments (`gen_ai.tool.call.arguments`). */
  public static readonly GEN_AI_TOOL_ARGS_KEY = "gen_ai.tool.call.arguments";
  /** Attribute key for the tool-call result (`gen_ai.tool.call.result`). */
  public static readonly GEN_AI_TOOL_CALL_RESULT_KEY = "gen_ai.tool.call.result";
  /** Attribute key for the tool type (`gen_ai.tool.type`). */
  public static readonly GEN_AI_TOOL_TYPE_KEY = "gen_ai.tool.type";

  // ── Tenant ───────────────────────────────────────────────────────

  /** Attribute key for the tenant identifier (`microsoft.tenant.id`). */
  public static readonly TENANT_ID_KEY = "microsoft.tenant.id";

  // ── Human caller dimensions (OTel user.* namespace) ──────────────

  /** Attribute key for the user identifier (`user.id`). */
  public static readonly USER_ID_KEY = "user.id";
  /** Attribute key for the user display name (`user.name`). */
  public static readonly USER_NAME_KEY = "user.name";
  /** Attribute key for the user email address (`user.email`). */
  public static readonly USER_EMAIL_KEY = "user.email";
  /** Attribute key for the caller client IP address (`client.address`). */
  public static readonly GEN_AI_CALLER_CLIENT_IP_KEY = "client.address";

  // ── Agent-to-Agent caller dimensions ─────────────────────────────

  /** Attribute key for the calling agent's agentic user identifier. */
  public static readonly GEN_AI_CALLER_AGENT_USER_ID_KEY = "microsoft.a365.caller.agent.user.id";
  /** Attribute key for the calling agent's agentic user email. */
  public static readonly GEN_AI_CALLER_AGENT_EMAIL_KEY = "microsoft.a365.caller.agent.user.email";
  /** Attribute key for the calling agent's name. */
  public static readonly GEN_AI_CALLER_AGENT_NAME_KEY = "microsoft.a365.caller.agent.name";
  /** Attribute key for the calling agent's identifier. */
  public static readonly GEN_AI_CALLER_AGENT_ID_KEY = "microsoft.a365.caller.agent.id";
  /** Attribute key for the calling agent's blueprint (application) identifier. */
  public static readonly GEN_AI_CALLER_AGENT_APPLICATION_ID_KEY =
    "microsoft.a365.caller.agent.blueprint.id";
  /** Attribute key for the calling agent's platform identifier. */
  public static readonly GEN_AI_CALLER_AGENT_PLATFORM_ID_KEY =
    "microsoft.a365.caller.agent.platform.id";
  /** Attribute key for the calling agent's version. */
  public static readonly GEN_AI_CALLER_AGENT_VERSION_KEY = "microsoft.a365.caller.agent.version";

  // ── Baggage keys ─────────────────────────────────────────────────

  /** Attribute/baggage key for the agentic user identifier (`microsoft.agent.user.id`). */
  public static readonly GEN_AI_AGENT_AUID_KEY = "microsoft.agent.user.id";
  /** Attribute/baggage key for the agentic user email (`microsoft.agent.user.email`). */
  public static readonly GEN_AI_AGENT_EMAIL_KEY = "microsoft.agent.user.email";
  /** Attribute/baggage key for the agent blueprint identifier (`microsoft.a365.agent.blueprint.id`). */
  public static readonly GEN_AI_AGENT_BLUEPRINT_ID_KEY = "microsoft.a365.agent.blueprint.id";

  // ── Execution context ────────────────────────────────────────────

  /** Attribute key for the task identifier (`gen_ai.task.id`). */
  public static readonly GEN_AI_TASK_ID_KEY = "gen_ai.task.id";
  /** Attribute key for the execution payload (`gen_ai.execution.payload`). */
  public static readonly GEN_AI_EXECUTION_PAYLOAD_KEY = "gen_ai.execution.payload";

  // ── Channel dimensions ───────────────────────────────────────────

  /** Attribute key for the channel name (`microsoft.channel.name`). */
  public static readonly CHANNEL_NAME_KEY = "microsoft.channel.name";
  /** Attribute key for the channel link/description (`microsoft.channel.link`). */
  public static readonly CHANNEL_LINK_KEY = "microsoft.channel.link";

  // ── Custom parent / span name ────────────────────────────────────

  /** Attribute key for a custom parent span identifier (`custom.parent.span.id`). */
  public static readonly CUSTOM_PARENT_SPAN_ID_KEY = "custom.parent.span.id";
  /** Attribute key for a custom span name (`custom.span.name`). */
  public static readonly CUSTOM_SPAN_NAME_KEY = "custom.span.name";

  // ── Service attributes ───────────────────────────────────────────

  /** Attribute key for the service name (`service.name`). */
  public static readonly SERVICE_NAME_KEY = "service.name";

  // ── Telemetry SDK attributes ─────────────────────────────────────

  /** Attribute key for the telemetry SDK name (`telemetry.sdk.name`). */
  public static readonly TELEMETRY_SDK_NAME_KEY = "telemetry.sdk.name";
  /** Attribute key for the telemetry SDK language (`telemetry.sdk.language`). */
  public static readonly TELEMETRY_SDK_LANGUAGE_KEY = "telemetry.sdk.language";
  /** Attribute key for the telemetry SDK version (`telemetry.sdk.version`). */
  public static readonly TELEMETRY_SDK_VERSION_KEY = "telemetry.sdk.version";
  /** Telemetry SDK name value reported by this distro. */
  public static readonly TELEMETRY_SDK_NAME_VALUE = "microsoft-opentelemetry";
  /** Telemetry SDK language value reported by this distro. */
  public static readonly TELEMETRY_SDK_LANGUAGE_VALUE = "nodejs";
  /** Telemetry SDK version value reported by this distro. */
  public static readonly TELEMETRY_SDK_VERSION_VALUE = MICROSOFT_OPENTELEMETRY_VERSION;

  // Guardrail operation name

  /** Operation name used for guardrail-evaluation spans. */
  public static readonly APPLY_GUARDRAIL_OPERATION_NAME = "apply_guardrail";

  // Guardian attributes

  /** Attribute key for the guardian identifier (`microsoft.guardian.id`). */
  public static readonly GUARDIAN_ID_KEY = "microsoft.guardian.id";
  /** Attribute key for the guardian name (`microsoft.guardian.name`). */
  public static readonly GUARDIAN_NAME_KEY = "microsoft.guardian.name";
  /** Attribute key for the guardian provider name (`microsoft.guardian.provider.name`). */
  public static readonly GUARDIAN_PROVIDER_NAME_KEY = "microsoft.guardian.provider.name";
  /** Attribute key for the guardian version (`microsoft.guardian.version`). */
  public static readonly GUARDIAN_VERSION_KEY = "microsoft.guardian.version";

  // Security decision attributes

  /** Attribute key for the guardrail decision type (`microsoft.security.decision.type`). */
  public static readonly SECURITY_DECISION_TYPE_KEY = "microsoft.security.decision.type";
  /** Attribute key for the guardrail decision reason (`microsoft.security.decision.reason`). */
  public static readonly SECURITY_DECISION_REASON_KEY = "microsoft.security.decision.reason";
  /** Attribute key for the guardrail decision code (`microsoft.security.decision.code`). */
  public static readonly SECURITY_DECISION_CODE_KEY = "microsoft.security.decision.code";

  // Security target attributes

  /** Attribute key for the guardrail target type (`microsoft.security.target.type`). */
  public static readonly SECURITY_TARGET_TYPE_KEY = "microsoft.security.target.type";
  /** Attribute key for the guardrail target identifier (`microsoft.security.target.id`). */
  public static readonly SECURITY_TARGET_ID_KEY = "microsoft.security.target.id";

  // Security policy attributes

  /** Attribute key for the security policy identifier (`microsoft.security.policy.id`). */
  public static readonly SECURITY_POLICY_ID_KEY = "microsoft.security.policy.id";
  /** Attribute key for the security policy name (`microsoft.security.policy.name`). */
  public static readonly SECURITY_POLICY_NAME_KEY = "microsoft.security.policy.name";
  /** Attribute key for the security policy version (`microsoft.security.policy.version`). */
  public static readonly SECURITY_POLICY_VERSION_KEY = "microsoft.security.policy.version";
  /** Attribute key for the security policy decision type (`microsoft.security.policy.decision.type`). */
  public static readonly SECURITY_POLICY_DECISION_TYPE_KEY =
    "microsoft.security.policy.decision.type";

  // Security content attributes

  /** Attribute key for the hash of guarded input content (`microsoft.security.content.input.hash`). */
  public static readonly SECURITY_CONTENT_INPUT_HASH_KEY = "microsoft.security.content.input.hash";
  /** Attribute key indicating whether guarded content was modified (`microsoft.security.content.modified`). */
  public static readonly SECURITY_CONTENT_MODIFIED_KEY = "microsoft.security.content.modified";
  /** Attribute key for the guarded input content value (`microsoft.security.content.input.value`). */
  public static readonly SECURITY_CONTENT_INPUT_VALUE_KEY =
    "microsoft.security.content.input.value";
  /** Attribute key for the guarded output content value (`microsoft.security.content.output.value`). */
  public static readonly SECURITY_CONTENT_OUTPUT_VALUE_KEY =
    "microsoft.security.content.output.value";

  // Security correlation attributes

  /** Attribute key for an external correlation identifier for SIEM systems (`microsoft.security.external_event_id`). */
  public static readonly SECURITY_EXTERNAL_EVENT_ID_KEY = "microsoft.security.external_event_id";

  // Security finding event

  /** Event name emitted for a security finding (`microsoft.security.finding`). */
  public static readonly SECURITY_FINDING_EVENT_NAME = "microsoft.security.finding";
  /** Attribute key for the detected risk category (`microsoft.security.risk.category`). */
  public static readonly SECURITY_RISK_CATEGORY_KEY = "microsoft.security.risk.category";
  /** Attribute key for the detected risk severity (`microsoft.security.risk.severity`). */
  public static readonly SECURITY_RISK_SEVERITY_KEY = "microsoft.security.risk.severity";
  /** Attribute key for the numeric risk score (`microsoft.security.risk.score`). */
  public static readonly SECURITY_RISK_SCORE_KEY = "microsoft.security.risk.score";
  /** Attribute key for non-content risk metadata (`microsoft.security.risk.metadata`). */
  public static readonly SECURITY_RISK_METADATA_KEY = "microsoft.security.risk.metadata";
}
