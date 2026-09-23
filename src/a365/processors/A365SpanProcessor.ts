// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Span processor that propagates baggage key/value pairs to span attributes.
 *
 * This processor copies baggage entries onto spans based on the operation type.
 * For `invoke_agent` operations, it applies both generic and invoke-agent-specific attributes.
 * For other operations, it applies only generic attributes.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability/src/tracing/processors/SpanProcessor.ts
 */

import type { Context, Span } from "@opentelemetry/api";
import { propagation } from "@opentelemetry/api";
import type {
  SpanProcessor as BaseSpanProcessor,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { INTERNAL_CUSTOM_KEYS_METADATA_KEY, OpenTelemetryConstants } from "../constants.js";
import { GEN_AI_OPERATION_NAMES } from "../exporter/utils.js";
import { GENERIC_ATTRIBUTES, INVOKE_AGENT_ATTRIBUTES } from "./util.js";

const DEFAULT_GEN_AI_INSTRUMENTATION_SCOPE_NAMES: readonly string[] = [
  "microsoft-otel-langchain",
  "microsoft-otel-openai-agents",
];

const INVOKE_AGENT_ATTRIBUTE_NAMES = new Set<string>(INVOKE_AGENT_ATTRIBUTES);

function getOperationFromSpanName(spanName: unknown): string | undefined {
  if (typeof spanName !== "string") {
    return undefined;
  }

  for (const operationName of GEN_AI_OPERATION_NAMES) {
    if (spanName === operationName || spanName.startsWith(`${operationName} `)) {
      return operationName;
    }
  }

  return undefined;
}

function getRegisteredCustomKeys(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key && key !== INTERNAL_CUSTOM_KEYS_METADATA_KEY);
}

function shouldCopyRegisteredCustomKey(key: string, isInvokeAgent: boolean): boolean {
  return isInvokeAgent || !INVOKE_AGENT_ATTRIBUTE_NAMES.has(key);
}

function getSpanAttributeValue(key: string, value: string): string | number | undefined {
  if (key !== OpenTelemetryConstants.SERVER_PORT_KEY) {
    return value;
  }

  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Copies relevant baggage entries to span attributes on span start.
 *
 * This is the "automatic" counterpart to the manual scope API — it ensures
 * every span in the pipeline gets agent identity attributes from baggage
 * without explicitly creating scopes.
 */
export class A365SpanProcessor implements BaseSpanProcessor {
  private readonly genAiInstrumentationScopeNames = new Set<string>(
    DEFAULT_GEN_AI_INSTRUMENTATION_SCOPE_NAMES,
  );

  /**
   * Called when a span is started.
   * Copies relevant baggage entries to span attributes.
   * Only GenAI spans are processed (those with a known `gen_ai.operation.name`
   * span attribute: invoke_agent, execute_tool, chat, output_messages);
   * all other spans pass through unmodified.
   */
  onStart(span: Span, parentContext?: Context): void {
    const ctx = parentContext;
    if (!ctx) {
      return;
    }

    const spanRecord = span as Span & {
      attributes?: Record<string, unknown>;
      name?: string;
      instrumentationScope?: { name?: string };
    };

    // Get existing span attributes
    const existingAttrs = new Set<string>();
    if (spanRecord.attributes) {
      Object.keys(spanRecord.attributes).forEach((key) => existingAttrs.add(key));
    }

    // Get all baggage entries
    const baggage = propagation.getBaggage(ctx);
    if (!baggage) {
      return;
    }

    const explicitOperation =
      spanRecord.attributes?.[OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY];
    const recognizedExplicitOperation =
      typeof explicitOperation === "string" && GEN_AI_OPERATION_NAMES.has(explicitOperation)
        ? explicitOperation
        : undefined;
    const inferredOperation =
      explicitOperation === undefined ? getOperationFromSpanName(spanRecord.name) : undefined;
    const operationName = recognizedExplicitOperation ?? inferredOperation;
    const supportedScope =
      typeof spanRecord.instrumentationScope?.name === "string" &&
      this.genAiInstrumentationScopeNames.has(spanRecord.instrumentationScope.name);

    if (!operationName && !supportedScope) {
      return;
    }

    const baggageMap = new Map<string, string>();
    baggage.getAllEntries().forEach(([key, entry]) => {
      if (entry.value) {
        baggageMap.set(key, entry.value);
      }
    });

    // Determine if this is an invoke_agent operation
    const isInvokeAgent = operationName === OpenTelemetryConstants.INVOKE_AGENT_OPERATION_NAME;

    // Build target key set
    const targetKeys = new Set<string>(GENERIC_ATTRIBUTES);
    if (isInvokeAgent) {
      INVOKE_AGENT_ATTRIBUTES.forEach((key) => targetKeys.add(key));
    }
    getRegisteredCustomKeys(baggageMap.get(INTERNAL_CUSTOM_KEYS_METADATA_KEY))
      .filter((key) => shouldCopyRegisteredCustomKey(key, isInvokeAgent))
      .forEach((key) => targetKeys.add(key));
    targetKeys.delete(OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY);

    // Set telemetry SDK attributes
    if (!existingAttrs.has(OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY)) {
      span.setAttribute(
        OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY,
        OpenTelemetryConstants.TELEMETRY_SDK_NAME_VALUE,
      );
      existingAttrs.add(OpenTelemetryConstants.TELEMETRY_SDK_NAME_KEY);
    }
    if (!existingAttrs.has(OpenTelemetryConstants.TELEMETRY_SDK_LANGUAGE_KEY)) {
      span.setAttribute(
        OpenTelemetryConstants.TELEMETRY_SDK_LANGUAGE_KEY,
        OpenTelemetryConstants.TELEMETRY_SDK_LANGUAGE_VALUE,
      );
      existingAttrs.add(OpenTelemetryConstants.TELEMETRY_SDK_LANGUAGE_KEY);
    }
    if (!existingAttrs.has(OpenTelemetryConstants.TELEMETRY_SDK_VERSION_KEY)) {
      span.setAttribute(
        OpenTelemetryConstants.TELEMETRY_SDK_VERSION_KEY,
        OpenTelemetryConstants.TELEMETRY_SDK_VERSION_VALUE,
      );
      existingAttrs.add(OpenTelemetryConstants.TELEMETRY_SDK_VERSION_KEY);
    }

    // Copy baggage to span attributes
    for (const key of targetKeys) {
      // Skip if attribute already exists
      if (existingAttrs.has(key)) {
        continue;
      }

      const value = baggageMap.get(key);
      if (!value) {
        continue;
      }

      const attributeValue = getSpanAttributeValue(key, value);
      if (attributeValue === undefined) {
        continue;
      }

      try {
        span.setAttribute(key, attributeValue);
      } catch {
        // Ignore errors setting attributes
      }
    }
  }

  /** Called when a span is ended. */
  onEnd(_span: ReadableSpan): void {
    // No-op for this processor
  }

  /** Shutdown the processor. */
  async shutdown(): Promise<void> {
    // No-op for this processor
  }

  /** Force flush the processor. */
  async forceFlush(): Promise<void> {
    // No-op for this processor
  }
}
