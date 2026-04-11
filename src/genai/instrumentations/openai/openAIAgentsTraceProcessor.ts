// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-openai
// Adapted: removed A365 ObservabilityManager dependency, uses local semconv + utils

import {
  context,
  trace as OtelTrace,
  Span as OtelSpan,
  Tracer as OtelTracer,
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
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_TOOL_NAME,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
} from "../../index.js";
import { truncateValue } from "../../utils.js";
import {
  GEN_AI_GRAPH_NODE_ID,
  GEN_AI_GRAPH_NODE_PARENT_ID,
  GEN_AI_RESPONSE_CONTENT_KEY,
  GEN_AI_EXECUTION_PAYLOAD_KEY,
} from "./semconv.js";
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
 * - Content-sensitive attributes (messages, tool args) are only recorded
 *   when `isContentRecordingEnabled` is true.
 */
export class OpenAIAgentsTraceProcessor implements TracingProcessor {
  private static readonly MAX_HANDOFFS_IN_FLIGHT = 1_000;
  private static readonly MAX_SPANS_IN_FLIGHT = 10_000;

  private readonly tracer: OtelTracer;
  private readonly suppressInvokeAgentInput: boolean;
  private readonly isContentRecordingEnabled: boolean;

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
      isContentRecordingEnabled?: boolean;
    },
  ) {
    this.tracer = tracer;
    this.suppressInvokeAgentInput = options?.suppressInvokeAgentInput ?? false;
    this.isContentRecordingEnabled = options?.isContentRecordingEnabled ?? false;
  }

  private isContentKey(key: string): boolean {
    return Utils.CONTENT_KEYS.has(key);
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

    // Start OpenTelemetry span
    const otelSpan = this.tracer.startSpan(
      spanName,
      {
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
    const contentRecording = this.isContentRecordingEnabled;

    switch (type) {
      case "response":
        this.processResponseSpanData(otelSpan, data, contentRecording);
        break;

      case "generation":
        this.processGenerationSpanData(otelSpan, data, traceId, contentRecording);
        break;

      case "function":
        this.processFunctionSpanData(otelSpan, data, traceId, contentRecording);
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

  private processResponseSpanData(
    otelSpan: OtelSpan,
    data: SpanData,
    contentRecording: boolean,
  ): void {
    const responseData = data as Record<string, unknown>;
    const responseObj = responseData._response || responseData.response;
    const inputObj = responseData._input || responseData.input;

    if (responseObj) {
      const resp = responseObj as Record<string, unknown>;

      if (resp.output && contentRecording) {
        if (typeof resp.output === "string") {
          otelSpan.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, truncateValue(resp.output));
        } else {
          otelSpan.setAttribute(
            ATTR_GEN_AI_OUTPUT_MESSAGES,
            truncateValue(
              Utils.buildOutputMessages(
                resp.output as Array<{
                  role: string;
                  content: Array<{ type: string; text: string }>;
                }>,
              ),
            ),
          );
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

    if (inputObj && !this.suppressInvokeAgentInput && contentRecording) {
      if (typeof inputObj === "string") {
        try {
          const parsed = JSON.parse(inputObj as string);
          if (Array.isArray(parsed)) {
            otelSpan.setAttribute(
              ATTR_GEN_AI_INPUT_MESSAGES,
              truncateValue(Utils.buildInputMessages(parsed)),
            );
            return;
          }
        } catch {
          // Fall back to raw string
        }
        otelSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, truncateValue(inputObj as string));
      } else if (Array.isArray(inputObj)) {
        otelSpan.setAttribute(
          ATTR_GEN_AI_INPUT_MESSAGES,
          truncateValue(Utils.buildInputMessages(inputObj)),
        );
      }
    }
  }

  private processGenerationSpanData(
    otelSpan: OtelSpan,
    data: SpanData,
    traceId: string,
    contentRecording: boolean,
  ): void {
    const attrs = Utils.getAttributesFromGenerationSpanData(data);
    Object.entries(attrs).forEach(([key, value]) => {
      const shouldExcludeKey = key === GEN_AI_EXECUTION_PAYLOAD_KEY;
      if (value !== null && value !== undefined && !shouldExcludeKey) {
        const newKey = this.getNewKey(data.type, key);
        const resolvedKey = newKey || key;
        if (!this.isContentKey(resolvedKey) || contentRecording) {
          otelSpan.setAttribute(resolvedKey, value as string | number | boolean);
        }
      }
    });

    this.stampCustomParent(otelSpan, traceId);

    const operationName = attrs[ATTR_GEN_AI_OPERATION_NAME];
    const modelName = attrs[ATTR_GEN_AI_REQUEST_MODEL];
    if (operationName && modelName) {
      otelSpan.updateName(`${operationName} ${modelName}`);
    }
  }

  private processFunctionSpanData(
    otelSpan: OtelSpan,
    data: SpanData,
    traceId: string,
    contentRecording: boolean,
  ): void {
    const functionData = data as Record<string, unknown>;
    const attrs = Utils.getAttributesFromFunctionSpanData(data);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        const newKey = this.getNewKey(data.type, key);
        const resolvedKey = newKey || key;
        if (!this.isContentKey(resolvedKey) || contentRecording) {
          otelSpan.setAttribute(resolvedKey, value as string | number | boolean);
        }
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
    if (handoffData.to_agent && handoffData.from_agent) {
      const key = `${handoffData.to_agent}:${traceId}`;
      this.reverseHandoffsDict.set(key, handoffData.from_agent as string);

      while (this.reverseHandoffsDict.size > OpenAIAgentsTraceProcessor.MAX_HANDOFFS_IN_FLIGHT) {
        const firstKey = this.reverseHandoffsDict.keys().next().value;
        if (firstKey) {
          this.reverseHandoffsDict.delete(firstKey);
        }
      }
    }
  }

  private processAgentSpanData(otelSpan: OtelSpan, data: SpanData, traceId: string): void {
    const agentData = data as Record<string, unknown>;
    if (agentData.name) {
      otelSpan.setAttribute(GEN_AI_GRAPH_NODE_ID, agentData.name as string);
      otelSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_INVOKE_AGENT);

      // Lookup parent node from handoff
      const key = `${agentData.name}:${traceId}`;
      const parentNode = this.reverseHandoffsDict.get(key);
      if (parentNode) {
        this.reverseHandoffsDict.delete(key);
        otelSpan.setAttribute(GEN_AI_GRAPH_NODE_PARENT_ID, parentNode);
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
