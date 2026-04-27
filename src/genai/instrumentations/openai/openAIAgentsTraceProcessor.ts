// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-openai
// Adapted: removed A365 ObservabilityManager dependency, uses local semconv + utils

import {
  context,
  trace as OtelTrace,
  Span as OtelSpan,
  Tracer as OtelTracer,
  SpanKind,
  diag,
} from "@opentelemetry/api";
import type {
  Span as AgentsSpan,
  SpanData,
  MCPListToolsSpanData,
  Trace as AgentTrace,
  TracingProcessor,
} from "@openai/agents-core";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CALLER_AGENT_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_ERROR_TYPE,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
} from "../../index.js";

import { serializeMessages } from "../../../a365/message-utils.js";
import { GEN_AI_RESPONSE_CONTENT_KEY, GEN_AI_EXECUTION_PAYLOAD_KEY } from "./semconv.js";
import * as Utils from "./utils.js";

type ContextToken = unknown;

/**
 * OpenTelemetry-based trace processor for the OpenAI Agents SDK.
 *
 * Implements the `TracingProcessor` interface from `@openai/agents-core` so it
 * can be registered via `setTraceProcessors()`. Every OpenAI agent span
 * (agent invocation, function/tool call, LLM generation, response, handoff,
 * MCP list-tools) is mapped to an OTel span with GenAI semantic convention
 * attributes.
 *
 * Key behaviors:
 * - Creates an OTel span on `onSpanStart` and ends it on `onSpanEnd`.
 * - Maintains parent–child span relationships via trace/span ID maps.
 * - Guards against unbounded memory with a hard cap of {@link MAX_SPANS_IN_FLIGHT}.
 * - Content attributes (messages, tool args) are always recorded
 *   (aligned with Python/.NET SDKs).
 */
export class OpenAIAgentsTraceProcessor implements TracingProcessor {
  private static readonly MAX_HANDOFFS_IN_FLIGHT = 1_000;
  private static readonly MAX_SPANS_IN_FLIGHT = 10_000;
  private static readonly SERVER_SPAN_TYPES = new Set(["agent"]);
  private static readonly CLIENT_SPAN_TYPES = new Set([
    "handoff",
    "response",
    "generation",
    "function",
    "mcp_tools",
  ]);

  private readonly tracer: OtelTracer;
  private readonly suppressInvokeAgentInput: boolean;

  /** Root spans keyed by trace ID. */
  private readonly rootSpans: Map<string, OtelSpan> = new Map();
  /** Active OTel spans keyed by OpenAI span ID. */
  private readonly otelSpans: Map<string, OtelSpan> = new Map();
  /** Context tokens for span activation. */
  private readonly tokens: Map<string, ContextToken> = new Map();
  /** Reverse handoff map: `${toAgent}:${traceId}` → fromAgent */
  private readonly reverseHandoffsDict: Map<string, string> = new Map();
  /** Span names for lookup (OTel Span doesn't expose name). */
  private readonly spanNames: Map<OtelSpan, string> = new Map();

  constructor(
    tracer: OtelTracer,
    options?: {
      suppressInvokeAgentInput?: boolean;
    },
  ) {
    this.tracer = tracer;
    this.suppressInvokeAgentInput = options?.suppressInvokeAgentInput ?? false;
  }

  private getNewKey(spanType: string, key: string): string | null {
    return Utils.KEY_MAPPINGS.get(`${spanType}${key}`) ?? null;
  }

  // -- TracingProcessor interface --

  public async start(): Promise<void> {
    // no-op
  }

  public async onTraceStart(_trace: AgentTrace): Promise<void> {
    // no-op
  }

  public async onTraceEnd(trace: AgentTrace): Promise<void> {
    const rootSpan = this.rootSpans.get(trace.traceId);
    if (rootSpan) {
      this.rootSpans.delete(trace.traceId);
      rootSpan.end();
    }
  }

  public async onSpanStart(span: AgentsSpan<SpanData>): Promise<void> {
    const spanId = span.spanId;
    const parentId = span.parentId;
    const traceId = span.traceId;
    const startedAt = span.startedAt;
    const spanData = span.spanData;

    if (!startedAt || !spanId || !traceId) {
      return;
    }

    const spanType = spanData?.type as string | undefined;

    // Skip span types we don't map to schema-defined operations.
    if (!spanType || spanType === "custom" || spanType === "guardrail") {
      return;
    }

    if (this.otelSpans.size >= OpenAIAgentsTraceProcessor.MAX_SPANS_IN_FLIGHT) {
      diag.warn(
        `[OpenAIAgentsTraceProcessor] Max spans in flight (${OpenAIAgentsTraceProcessor.MAX_SPANS_IN_FLIGHT}) reached, skipping span`,
      );
      return;
    }

    const startTime = new Date(startedAt).getTime();

    // Find parent span
    const parentSpan = parentId ? this.otelSpans.get(parentId) : this.rootSpans.get(traceId);

    // Create context with parent
    const parentContext = parentSpan
      ? OtelTrace.setSpan(context.active(), parentSpan)
      : context.active();

    const spanName = Utils.getSpanName(span);

    // SpanKind per OTel client/server semantics + A365 schema:
    const kind = OpenAIAgentsTraceProcessor.SERVER_SPAN_TYPES.has(spanType)
      ? SpanKind.SERVER
      : OpenAIAgentsTraceProcessor.CLIENT_SPAN_TYPES.has(spanType)
        ? SpanKind.CLIENT
        : undefined;

    // Start OpenTelemetry span
    const otelSpan = this.tracer.startSpan(
      spanName,
      {
        kind,
        startTime,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: Utils.getOperationName(spanData),
          [ATTR_GEN_AI_PROVIDER_NAME]: "openai",
        },
      },
      parentContext,
    );

    if (!parentSpan) {
      this.rootSpans.set(traceId, otelSpan);
    }

    this.otelSpans.set(spanId, otelSpan);
    this.spanNames.set(otelSpan, spanName);
    const newContext = OtelTrace.setSpan(context.active(), otelSpan);
    const token = context.with(newContext, () => context.active());
    this.tokens.set(spanId, token);
  }

  public async onSpanEnd(span: AgentsSpan<SpanData>): Promise<void> {
    const spanId = span.spanId;
    const traceId = span.traceId;
    const endedAt = span.endedAt;
    const spanData = span.spanData;

    if (!spanId || !traceId) {
      return;
    }

    // Cleanup context token
    const token = this.tokens.get(spanId);
    if (token) {
      this.tokens.delete(spanId);
    }

    const otelSpan = this.otelSpans.get(spanId);
    if (!otelSpan) {
      return;
    }
    this.otelSpans.delete(spanId);
    this.spanNames.delete(otelSpan);

    // Clean up root span reference if this is the root
    const rootSpan = this.rootSpans.get(traceId);
    if (rootSpan === otelSpan) {
      this.rootSpans.delete(traceId);
    }

    // Update span name
    otelSpan.updateName(Utils.getSpanName(span));

    // Process based on span data type
    if (spanData) {
      this.processSpanData(otelSpan, spanData, traceId);
    }

    // Set end time and status
    const endTime = endedAt ? new Date(endedAt).getTime() : undefined;
    const status = Utils.getSpanStatus(span);
    otelSpan.setStatus(status);
    if (span.error) {
      const errData = (span.error as { data?: Record<string, unknown>; name?: string }).data;
      const errorType =
        (typeof errData?.type === "string" && errData.type) ||
        (span.error as { name?: string }).name ||
        "error";
      otelSpan.setAttribute(ATTR_ERROR_TYPE, errorType);
    }
    if (endTime) {
      otelSpan.end(endTime);
    } else {
      otelSpan.end();
    }
  }

  public async forceFlush(): Promise<void> {
    // no-op
  }

  public async shutdown(_timeout?: number): Promise<void> {
    this.rootSpans.clear();
    this.otelSpans.clear();
    this.tokens.clear();
    this.reverseHandoffsDict.clear();
  }

  // -- Span data processors --

  private processSpanData(otelSpan: OtelSpan, data: SpanData, traceId: string): void {
    const type = data.type;

    switch (type) {
      case "response":
        this.processResponseSpanData(otelSpan, data);
        break;

      case "generation":
        this.processGenerationSpanData(otelSpan, data, traceId);
        break;

      case "function":
        this.processFunctionSpanData(otelSpan, data, traceId);
        break;

      case "mcp_tools":
        this.processMCPListToolsSpanData(otelSpan, data);
        break;

      case "handoff":
        this.processHandoffSpanData(otelSpan, data, traceId);
        break;

      case "agent":
        this.processAgentSpanData(otelSpan, data, traceId);
        break;
    }
  }

  private processResponseSpanData(otelSpan: OtelSpan, data: SpanData): void {
    const responseData = data as Record<string, unknown>;
    const responseObj = responseData._response || responseData.response;
    const inputObj = responseData._input || responseData.input;

    if (responseObj) {
      const resp = responseObj as Record<string, unknown>;

      // Store the output field as structured OutputMessages (always use versioned envelope)
      if (resp.output != null) {
        if (Array.isArray(resp.output)) {
          const structured = Utils.buildStructuredOutputMessages(
            resp.output as Array<Record<string, unknown>>,
          );
          otelSpan.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, serializeMessages(structured));
        } else {
          // String or non-array object — wrap as raw content
          const structured = Utils.wrapRawContentAsOutputMessages(resp.output);
          otelSpan.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, serializeMessages(structured));
        }
      }

      // Get attributes but filter out response content key (handled above)
      const attrs = Utils.getAttributesFromResponse(responseObj);
      Object.entries(attrs).forEach(([key, value]) => {
        if (value !== null && value !== undefined && key !== GEN_AI_RESPONSE_CONTENT_KEY) {
          otelSpan.setAttribute(key, value as string | number | boolean);
        }
      });

      const modelName = attrs[ATTR_GEN_AI_REQUEST_MODEL] ?? "";
      otelSpan.updateName(`${GEN_AI_OPERATION_CHAT} ${modelName}`);
    }

    if (inputObj != null && !this.suppressInvokeAgentInput) {
      if (typeof inputObj === "string") {
        try {
          const parsed = JSON.parse(inputObj as string);
          if (Array.isArray(parsed)) {
            const structured = Utils.buildStructuredInputMessages(parsed);
            otelSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, serializeMessages(structured));
            return;
          }
        } catch {
          // If parsing fails, wrap raw string in versioned envelope
        }
        const wrappedInput = Utils.wrapRawContentAsInputMessages(inputObj);
        otelSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, serializeMessages(wrappedInput));
      } else if (Array.isArray(inputObj)) {
        const structured = Utils.buildStructuredInputMessages(inputObj);
        otelSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, serializeMessages(structured));
      }
    }
  }

  private processGenerationSpanData(otelSpan: OtelSpan, data: SpanData, traceId: string): void {
    const attrs = Utils.getAttributesFromGenerationSpanData(data);
    Object.entries(attrs).forEach(([key, value]) => {
      const shouldExcludeKey = key === GEN_AI_EXECUTION_PAYLOAD_KEY;
      if (value !== null && value !== undefined && !shouldExcludeKey) {
        const newKey = this.getNewKey(data.type, key);
        const resolvedKey = newKey || key;
        if (resolvedKey !== ATTR_GEN_AI_INPUT_MESSAGES || !this.suppressInvokeAgentInput) {
          otelSpan.setAttribute(resolvedKey, value as string | number | boolean);
        }
      }
    });

    this.stampCustomParent(otelSpan, traceId);

    const modelName = attrs[ATTR_GEN_AI_REQUEST_MODEL];
    if (typeof modelName === "string" && modelName.length > 0) {
      otelSpan.updateName(`${GEN_AI_OPERATION_CHAT} ${modelName}`);
    }
  }

  private processFunctionSpanData(otelSpan: OtelSpan, data: SpanData, traceId: string): void {
    const functionData = data as Record<string, unknown>;
    const attrs = Utils.getAttributesFromFunctionSpanData(data);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        const newKey = this.getNewKey(data.type, key);
        const resolvedKey = newKey || key;
        otelSpan.setAttribute(resolvedKey, value as string | number | boolean);
      }
    });
    otelSpan.setAttribute(ATTR_GEN_AI_TOOL_TYPE, "function");

    this.stampCustomParent(otelSpan, traceId);
    otelSpan.updateName(`${GEN_AI_OPERATION_EXECUTE_TOOL} ${functionData.name ?? ""}`);
    otelSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_EXECUTE_TOOL);
  }

  private processMCPListToolsSpanData(otelSpan: OtelSpan, data: SpanData): void {
    const attrs = Utils.getAttributesFromMCPListToolsSpanData(data);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        const newKey = this.getNewKey(data.type, key);
        otelSpan.setAttribute(newKey || key, value as string | number | boolean);
      }
    });

    otelSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_EXECUTE_TOOL);
    const serverName = (data as MCPListToolsSpanData).server ?? "unknown";
    otelSpan.updateName(`${GEN_AI_OPERATION_EXECUTE_TOOL} ${serverName}`);
    if (serverName) {
      otelSpan.setAttribute(ATTR_GEN_AI_TOOL_NAME, serverName);
    }
    otelSpan.setAttribute(ATTR_GEN_AI_TOOL_TYPE, "extension");
  }

  private processHandoffSpanData(_otelSpan: OtelSpan, data: SpanData, traceId: string): void {
    const handoffData = data as Record<string, unknown>;
    const fromAgent = handoffData.from_agent as string | undefined;
    const toAgent = handoffData.to_agent as string | undefined;

    if (toAgent && fromAgent) {
      const key = `${toAgent}:${traceId}`;
      this.reverseHandoffsDict.set(key, fromAgent);

      while (this.reverseHandoffsDict.size > OpenAIAgentsTraceProcessor.MAX_HANDOFFS_IN_FLIGHT) {
        const firstKey = this.reverseHandoffsDict.keys().next().value;
        if (firstKey) {
          this.reverseHandoffsDict.delete(firstKey);
        }
      }
    }

    _otelSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_INVOKE_AGENT);
    if (toAgent) {
      _otelSpan.setAttribute(ATTR_GEN_AI_AGENT_NAME, toAgent);
      _otelSpan.updateName(`${GEN_AI_OPERATION_INVOKE_AGENT} ${toAgent}`);
    }
    if (fromAgent) {
      _otelSpan.setAttribute(ATTR_GEN_AI_CALLER_AGENT_NAME, fromAgent);
    }
  }

  private processAgentSpanData(otelSpan: OtelSpan, data: SpanData, traceId: string): void {
    const agentData = data as Record<string, unknown>;
    if (agentData.name) {
      otelSpan.setAttribute(ATTR_GEN_AI_AGENT_NAME, agentData.name as string);
      otelSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_INVOKE_AGENT);

      // Link back to the agent that handed off to this one (A2A caller semantics)
      const key = `${agentData.name}:${traceId}`;
      const parentNode = this.reverseHandoffsDict.get(key);
      if (parentNode) {
        this.reverseHandoffsDict.delete(key);
        otelSpan.setAttribute(ATTR_GEN_AI_CALLER_AGENT_NAME, parentNode);
      }

      otelSpan.updateName(`${GEN_AI_OPERATION_INVOKE_AGENT} ${agentData.name}`);
    }
  }

  private stampCustomParent(otelSpan: OtelSpan, traceId: string): void {
    const root = this.rootSpans.get(traceId);
    if (!root) {
      return;
    }
    const spanContext = root.spanContext();
    const pidHex = `0x${spanContext.spanId}`;
    otelSpan.setAttribute("custom.parent.span.id", pidHex);
  }
}
