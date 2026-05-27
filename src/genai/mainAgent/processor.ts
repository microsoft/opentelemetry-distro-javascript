// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Span and log-record processors that propagate
 * `microsoft.gen_ai.main_agent.*` attributes from the top-level (user-facing)
 * GenAI agent so that all downstream telemetry is attributed to the main
 * agent rather than internal sub-agents in a multi-agent system.
 *
 * Mirrors `microsoft/opentelemetry-distro-python`
 * (`src/microsoft/opentelemetry/_genai/main_agent/_processor.py`).
 */

import type { Context, Span } from "@opentelemetry/api";
import { isSpanContextValid, trace } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor as BaseSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import {
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  GEN_AI_OPERATION_INVOKE_AGENT,
} from "../semconv.js";
import {
  GEN_AI_MAIN_AGENT_ATTRIBUTE_PREFIX,
  GEN_AI_MAIN_AGENT_CONVERSATION_ID_KEY,
  GEN_AI_MAIN_AGENT_ID_KEY,
  GEN_AI_MAIN_AGENT_NAME_KEY,
  GEN_AI_MAIN_AGENT_VERSION_KEY,
} from "./constants.js";

// `gen_ai.agent.version` is not exported by ./semconv.ts; declare locally
// to keep parity with the Python processor's fallback table.
const ATTR_GEN_AI_AGENT_VERSION = "gen_ai.agent.version" as const;

/**
 * Each row: [target attribute on current span,
 *            primary source attribute on parent span,
 *            fallback source attribute on parent span].
 */
const PROPAGATION_TABLE: ReadonlyArray<readonly [string, string, string]> = [
  [GEN_AI_MAIN_AGENT_NAME_KEY, GEN_AI_MAIN_AGENT_NAME_KEY, ATTR_GEN_AI_AGENT_NAME],
  [GEN_AI_MAIN_AGENT_ID_KEY, GEN_AI_MAIN_AGENT_ID_KEY, ATTR_GEN_AI_AGENT_ID],
  [GEN_AI_MAIN_AGENT_VERSION_KEY, GEN_AI_MAIN_AGENT_VERSION_KEY, ATTR_GEN_AI_AGENT_VERSION],
  [
    GEN_AI_MAIN_AGENT_CONVERSATION_ID_KEY,
    GEN_AI_MAIN_AGENT_CONVERSATION_ID_KEY,
    ATTR_GEN_AI_CONVERSATION_ID,
  ],
];

/** Used at `onEnd` for the self-copy fallback on the top-level `invoke_agent`. */
const SELF_COPY_TABLE: ReadonlyArray<readonly [string, string]> = PROPAGATION_TABLE.map(
  ([target, _primary, fallback]) => [target, fallback] as const,
);

interface ReadableSpanLike {
  attributes?: Record<string, unknown>;
}

/**
 * Propagates `microsoft.gen_ai.main_agent.*` attributes onto spans.
 *
 * - `onStart`: copies main-agent attributes from the parent span (or falls
 *   back to the parent's `gen_ai.agent.*` / `gen_ai.conversation.id`
 *   attributes) onto the new span.
 * - `onEnd`: when the span is itself an `invoke_agent` operation and has not
 *   already been enriched, copies its own `gen_ai.agent.*` /
 *   `gen_ai.conversation.id` attributes onto `microsoft.gen_ai.main_agent.*`
 *   so the top-level agent identifies itself as the main agent.
 */
export class GenAIMainAgentSpanProcessor implements BaseSpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const parent = trace.getSpan(parentContext);
    if (!parent || !isSpanContextValid(parent.spanContext())) {
      return;
    }

    const parentAttributes = (parent as unknown as ReadableSpanLike).attributes ?? {};
    for (const [target, primary, fallback] of PROPAGATION_TABLE) {
      const value = parentAttributes[primary] ?? parentAttributes[fallback];
      if (value !== undefined && value !== null) {
        span.setAttribute(target, value as never);
      }
    }
  }

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes;
    if (!attributes || attributes[ATTR_GEN_AI_OPERATION_NAME] !== GEN_AI_OPERATION_INVOKE_AGENT) {
      return;
    }

    for (const key of Object.keys(attributes)) {
      if (key.startsWith(GEN_AI_MAIN_AGENT_ATTRIBUTE_PREFIX)) {
        return;
      }
    }

    // The span has already ended by the time onEnd fires, so `setAttribute`
    // is a no-op. Mutate the underlying attributes map directly, which is
    // what downstream exporters read.
    const mutable = attributes as Record<string, unknown>;
    for (const [target, source] of SELF_COPY_TABLE) {
      const value = attributes[source];
      if (value !== undefined && value !== null) {
        mutable[target] = value;
      }
    }
  }

  async shutdown(): Promise<void> {
    // no-op
  }

  async forceFlush(): Promise<void> {
    // no-op
  }
}

interface LogRecordAttributesLike {
  attributes?: Record<string, unknown> | null;
  setAttribute?: (key: string, value: unknown) => unknown;
}

/**
 * Copies any `microsoft.gen_ai.main_agent.*` attributes from the current
 * span onto every emitted log record.
 */
export class GenAIMainAgentLogRecordProcessor implements LogRecordProcessor {
  onEmit(logRecord: SdkLogRecord, contextArg?: Context): void {
    const span = contextArg ? trace.getSpan(contextArg) : trace.getActiveSpan();
    if (!span || !isSpanContextValid(span.spanContext())) {
      return;
    }

    const spanAttributes = (span as unknown as ReadableSpanLike).attributes ?? {};
    const target = logRecord as unknown as LogRecordAttributesLike;

    let setAttribute: ((key: string, value: unknown) => unknown) | undefined;
    if (typeof target.setAttribute === "function") {
      setAttribute = target.setAttribute.bind(target);
    } else {
      if (!target.attributes) {
        target.attributes = {};
      }
      const attrsBag = target.attributes;
      setAttribute = (key: string, value: unknown) => {
        attrsBag[key] = value;
        return undefined;
      };
    }

    for (const [key, value] of Object.entries(spanAttributes)) {
      if (
        key.startsWith(GEN_AI_MAIN_AGENT_ATTRIBUTE_PREFIX) &&
        value !== undefined &&
        value !== null
      ) {
        setAttribute(key, value);
      }
    }
  }

  async forceFlush(): Promise<void> {
    // no-op
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}
