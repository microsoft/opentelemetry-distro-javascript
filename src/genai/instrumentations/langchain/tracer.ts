// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-langchain

import { context, trace, Span, SpanKind, SpanStatusCode, Tracer } from "@opentelemetry/api";
import { BaseTracer, Run } from "@langchain/core/tracers/base";
import { isTracingSuppressed } from "@opentelemetry/core";
import { diag } from "@opentelemetry/api";
import { ATTR_ERROR_MESSAGE, ATTR_GEN_AI_PROVIDER_NAME } from "../../index.js";
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
 * - Content-sensitive attributes (messages, tool args, system instructions)
 *   are only recorded when `isContentRecordingEnabled` is true.
 */
export class LangChainTracer extends BaseTracer {
  /** Hard cap on concurrent tracked runs to prevent memory leaks. */
  private static readonly MAX_RUNS = 10_000;
  private tracer: Tracer;
  private isContentRecordingEnabled: boolean;
  /** Active runs keyed by LangChain run ID. */
  private runs = new Map<string, RunWithSpan>();
  /** Maps each run ID → its parent run ID for parent-span-context lookup. */
  private parentByRunId = new Map<string, string | undefined>();

  constructor(tracer: Tracer, options?: { isContentRecordingEnabled?: boolean }) {
    super();
    this.tracer = tracer;
    this.isContentRecordingEnabled = options?.isContentRecordingEnabled ?? false;
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

    // Attach to parent span if one exists in the run hierarchy
    const parentCtx = this.getNearestParentSpanContext(run);
    const activeContext = parentCtx
      ? trace.setSpanContext(context.active(), parentCtx)
      : context.active();

    // Build span name: "<operation> <name|model>"
    let spanName = run.name;
    if (operation === "invoke_agent") {
      spanName = `${operation} ${run.name}`;
    } else if (operation === "execute_tool") {
      spanName = `${operation} ${run.name}`;
    } else if (operation === "chat") {
      spanName = `${operation} ${Utils.getModel(run) || run.name}`.trim();
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
        kind: SpanKind.INTERNAL,
        startTime,
        attributes: { [ATTR_GEN_AI_PROVIDER_NAME]: "langchain" },
      },
      activeContext,
    );

    this.runs.set(run.id, { run, span, startTime, lastAccessTime: startTime });
  }

  /**
   * Called by LangChain when a run finishes. Sets status, enriches the span
   * with GenAI attributes, and ends it. If content recording is enabled,
   * message bodies, tool arguments, and system instructions are also attached.
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
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      // Always-on attributes: operation type, agent info, model, provider, session, tokens
      Utils.setOperationTypeAttribute(operation, span);
      Utils.setAgentAttributes(run, span);
      Utils.setModelAttribute(run, span);
      Utils.setProviderNameAttribute(run, span);
      Utils.setSessionIdAttribute(run, span);
      Utils.setTokenAttributes(run, span);

      // Opt-in content attributes (may contain PII / large payloads)
      if (this.isContentRecordingEnabled) {
        Utils.setToolAttributes(run, span);
        Utils.setInputMessagesAttribute(run, span);
        Utils.setOutputMessagesAttribute(run, span);
        Utils.setSystemInstructionsAttribute(run, span);
      }
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
   * active span, returning its `SpanContext` so the new span can be linked
   * as a child.
   */
  private getNearestParentSpanContext(run: Run) {
    let pid = run.parent_run_id;

    while (pid) {
      const entry = this.runs.get(pid);
      if (entry) return entry.span.spanContext();
      pid = this.parentByRunId.get(pid);
    }
    return undefined;
  }
}
