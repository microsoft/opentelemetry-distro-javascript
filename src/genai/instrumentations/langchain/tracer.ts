// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-langchain

import { context, trace, Span, SpanKind, SpanStatusCode, Tracer } from "@opentelemetry/api";
import { BaseTracer, Run } from "@langchain/core/tracers/base";
import { isTracingSuppressed } from "@opentelemetry/core";
import { diag } from "@opentelemetry/api";
import {
  ATTR_ERROR_MESSAGE,
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_CALLER_AGENT_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
} from "../../index.js";
import * as Utils from "./utils.js";

type RunWithSpan = { run: Run; span: Span; startTime: number; lastAccessTime: number };

/**
 * OpenTelemetry-based tracer for LangChain / LangGraph applications.
 *
 * Extends LangChain's `BaseTracer` callback handler so it can be injected into
 * the LangChain callback system (via `LangChainTraceInstrumentor`). Every
 * LangChain "run" (agent invocation, tool execution, or LLM call) is mapped to
 * an OTel span with GenAI semantic convention attributes.
 *
 * Key behaviors:
 * - Creates a span on `onRunCreate` and ends it on `_endTrace`.
 * - Maintains parent–child span relationships by tracking run IDs and walking
 *   up the parent chain to find the nearest span context.
 * - Skips LangChain-internal runs (tagged `langsmith:hidden`, `Branch*`, or
 *   unmapped run types) to avoid noisy traces.
 * - Guards against unbounded memory with a hard cap of {@link MAX_RUNS}.
 * - Content attributes (messages, tool args) are always recorded
 *   (aligned with Python/.NET SDKs).
 */
export class LangChainTracer extends BaseTracer {
  /** Hard cap on concurrent tracked runs to prevent memory leaks. */
  private static readonly MAX_RUNS = 10_000;
  private tracer: Tracer;
  /** Active runs keyed by LangChain run ID. */
  private runs = new Map<string, RunWithSpan>();
  /** Maps each run ID → its parent run ID for parent-span-context lookup. */
  private parentByRunId = new Map<string, string | undefined>();

  constructor(tracer: Tracer) {
    super();
    this.tracer = tracer;
  }

  name = "OpenTelemetryLangChainTracer";

  protected persistRun(_run: Run): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Called by LangChain when a new run starts. Records the parent mapping
   * and opens a span via {@link startTracing}.
   */
  async onRunCreate(run: Run) {
    this.parentByRunId.set(run.id, run.parent_run_id);
    if (super.onRunCreate) await super.onRunCreate(run);
    this.startTracing(run);
  }

  /**
   * Opens an OTel span for the given run. The span name is derived from the
   * operation type (invoke_agent, execute_tool, chat) and the run/model name.
   * Internal or unknown runs are silently skipped.
   */
  protected startTracing(run: Run) {
    if (isTracingSuppressed(context.active())) {
      return;
    }

    const operation = Utils.getOperationType(run);

    // Skip internal runs (LangSmith hidden, Branch nodes, unknown operations)
    if (
      run.tags?.includes("langsmith:hidden") ||
      run.name?.startsWith("Branch") ||
      operation === "unknown"
    ) {
      diag.debug(
        `[LangChainTracer] Skipping internal run: ${run.name} (parent: ${run.parent_run_id})`,
      );
      return;
    }

    // Attach to parent span if one exists in the run hierarchy. We put the
    // actual parent Span (not just its SpanContext) into the context so that
    // span processors observing on_start of this span (e.g.
    // GenAIMainAgentSpanProcessor) can read attributes off the parent.
    const parentSpan = this.getNearestParentSpan(run);
    const activeContext = parentSpan
      ? trace.setSpan(context.active(), parentSpan)
      : context.active();

    // Build span name: "<operation> <name|model>"
    let spanName = run.name;
    let kind: SpanKind = SpanKind.INTERNAL;
    if (operation === "invoke_agent") {
      spanName = `${operation} ${run.name}`;
      kind = SpanKind.SERVER;
    } else if (operation === "execute_tool") {
      spanName = `${operation} ${run.name}`;
      kind = SpanKind.CLIENT;
    } else if (operation === "chat") {
      spanName = `${operation} ${Utils.getModel(run) || run.name}`.trim();
      kind = SpanKind.CLIENT;
    }

    if (this.runs.size >= LangChainTracer.MAX_RUNS) {
      diag.warn(`[LangChainTracer] Max runs (${LangChainTracer.MAX_RUNS}) reached, skipping span`);
      this.parentByRunId.delete(run.id);
      return;
    }

    const startTime = run.start_time ?? Date.now();
    const span = this.tracer.startSpan(
      spanName,
      {
        kind,
        startTime,
        attributes: { [ATTR_GEN_AI_PROVIDER_NAME]: "langchain" },
      },
      activeContext,
    );

    // Set identity attributes (operation, agent, session/conversation) BEFORE
    // any child run starts, so that span processors observing on_start of
    // child spans (e.g. GenAIMainAgentSpanProcessor) can read them from this
    // parent span. Output/usage/model attributes are still set at end time
    // because their values are not known yet.
    try {
      Utils.setOperationTypeAttribute(operation, span);
      Utils.setAgentAttributes(run, span);
      Utils.setSessionIdAttribute(run, span);
    } catch (error) {
      diag.debug(
        `[LangChainTracer] Failed to set start-time attributes for run ${run.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.runs.set(run.id, { run, span, startTime, lastAccessTime: startTime });
  }

  /**
   * Called by LangChain when a run finishes. Sets status, enriches the span
   * with GenAI attributes, and ends it.
   */
  protected async _endTrace(run: Run) {
    if (isTracingSuppressed(context.active())) {
      // End any span that was started before suppression to avoid leaks.
      const suppressedEntry = this.runs.get(run.id);
      if (suppressedEntry) {
        suppressedEntry.span.end(run.end_time ?? undefined);
      }
      this.parentByRunId.delete(run.id);
      this.runs.delete(run.id);
      return;
    }

    const operation = Utils.getOperationType(run);
    if (
      run.tags?.includes("langsmith:hidden") ||
      run.name?.startsWith("Branch") ||
      operation === "unknown"
    ) {
      diag.debug(
        `[LangChainTracer] Skipping internal run: ${run.name} (parent: ${run.parent_run_id})`,
      );
      return;
    }

    const entry = this.runs.get(run.id);
    if (!entry) {
      return;
    }

    const { span } = entry;
    try {
      entry.lastAccessTime = Date.now();

      if (run.error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(ATTR_ERROR_MESSAGE, String(run.error));
        const errorType =
          (run.error as { name?: string })?.name ??
          (run.error as { constructor?: { name?: string } })?.constructor?.name;
        if (typeof errorType === "string" && errorType.length > 0) {
          span.setAttribute(ATTR_ERROR_TYPE, errorType);
        }
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      // Always-on attributes: operation type, agent info, model, provider, session, tokens.
      // Operation/agent/session are also set at span start so that
      // GenAIMainAgentSpanProcessor.onStart sees them on child spans; setting
      // them again here is idempotent and guarantees end-time corrections
      // (e.g. metadata that only becomes available mid-run) still land.
      Utils.setOperationTypeAttribute(operation, span);
      Utils.setAgentAttributes(run, span);
      if (operation === "invoke_agent") {
        const callerName = this.findCallerAgentName(run);
        if (callerName) {
          span.setAttribute(ATTR_GEN_AI_CALLER_AGENT_NAME, callerName);
        }
      }
      Utils.setModelAttribute(run, span);
      Utils.setResponseIdAttribute(run, span);
      Utils.setProviderNameAttribute(run, span);
      Utils.setSessionIdAttribute(run, span);
      Utils.setTokenAttributes(run, span);

      // Content attributes — always recorded (aligned with Python/.NET SDKs)
      Utils.setToolAttributes(run, span);
      Utils.setInputMessagesAttribute(run, span);
      Utils.setOutputMessagesAttribute(run, span);
      Utils.setSystemInstructionsAttribute(run, span);
    } catch (error) {
      diag.error(
        `[LangChainTracer] Error setting span attributes for run ${run.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      span.end(run.end_time ?? undefined);
      this.runs.delete(run.id);
      this.parentByRunId.delete(run.id);
      await super._endTrace(run);
    }
  }

  /**
   * Walks up the parent run chain to find the nearest ancestor that has an
   * active span, returning that Span so the new span can be linked as a
   * child and processors can read parent attributes.
   */
  private getNearestParentSpan(run: Run) {
    let pid = run.parent_run_id;

    while (pid) {
      const entry = this.runs.get(pid);
      if (entry) return entry.span;
      pid = this.parentByRunId.get(pid);
    }
    return undefined;
  }

  /**
   * Walk up the parent run chain to find the nearest ancestor that is an
   * invoke_agent run, returning its name as the caller agent name.
   */
  private findCallerAgentName(run: Run): string | undefined {
    let pid = run.parent_run_id;
    while (pid) {
      const entry = this.runs.get(pid);
      if (entry && Utils.getOperationType(entry.run) === "invoke_agent") {
        return entry.run.name;
      }
      pid = this.parentByRunId.get(pid);
    }
    return undefined;
  }
}
