// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Context, Span as ApiSpan, AttributeValue } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor as BaseSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_GEN_AI_REQUEST_MODEL, GEN_AI_OPERATION_CHAT } from "../../genai/index.js";
import { Logger } from "../../shared/logging/index.js";

/**
 * Module-scoped bridge between any GenAI integration that knows how to
 * extract a deployment alias for a span and the processor that consumes it.
 *
 * Using a `WeakMap` keyed by the live span object means
 *   - nothing internal lands on the span as an attribute, and
 *   - entries are garbage-collected with the span.
 */
const deploymentAliasBySpan = new WeakMap<object, string>();

/**
 * Narrow view of the `@opentelemetry/sdk-trace-base` `Span` runtime object
 * that the OTel JS SDK actually hands to `onEnd`. The public `ReadableSpan`
 * interface marks `attributes` and `name` as read-only, but the runtime
 * object passed to span processors is the same `Span` instance whose fields
 * are plain mutable properties. We ship this narrow shape so the cast in
 * `onEnd` is scoped to the two specific fields the spec requires us to
 * rewrite (`gen_ai.request.model` and the span name) instead of relying on
 * `any`. Post-end attribute rewrites are necessary here because the public
 * `Span.setAttribute` / `Span.updateName` APIs become no-ops once the span
 * has ended, and span-processor `onEnd` callbacks run after that point.
 */
type MutableEndedSpan = ReadableSpan & {
  attributes: Record<string, AttributeValue | undefined>;
  name: string;
};

/**
 * Associate an Azure deployment alias with a span.
 *
 * Intended to be called by GenAI integration glue (e.g. the LangChain
 * deployment-alias enricher in this folder) after extracting the alias from
 * the framework's run/request shape. Generic — has no knowledge of any
 * particular GenAI framework.
 */
export function setDeploymentAliasForSpan(span: ApiSpan, alias: string): void {
  if (typeof alias !== "string") return;
  const trimmed = alias.trim();
  if (trimmed.length === 0) return;
  deploymentAliasBySpan.set(span as unknown as object, trimmed);
}

/**
 * Generic Azure Monitor span processor that, for any span that has been
 * associated with an Azure deployment alias via {@link setDeploymentAliasForSpan},
 * overrides `gen_ai.request.model` with the alias and rewrites the
 * `chat <model>` span name to match.
 *
 * The processor itself has no GenAI-framework-specific knowledge. Framework
 * glue (e.g. for LangChain) lives in separate files and is responsible for
 * extracting deployment aliases and calling
 * {@link setDeploymentAliasForSpan}. This decoupling means a missing or
 * unloadable framework dependency cannot break the Azure Monitor pipeline.
 *
 * @internal
 */
export class AzureMonitorDeploymentAliasProcessor implements BaseSpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {
    // No-op: deployment alias is captured by integrations during their own
    // tracing lifecycle, not at span start.
  }

  /**
   * If a deployment alias was associated with this span, override
   * `gen_ai.request.model` and rewrite the chat span name accordingly.
   */
  onEnd(span: ReadableSpan): void {
    try {
      const deploymentAlias = deploymentAliasBySpan.get(span as unknown as object);
      if (typeof deploymentAlias !== "string" || deploymentAlias.length === 0) {
        return;
      }

      // The SDK hands `onEnd` the same `Span` runtime object whose
      // `attributes` and `name` fields are plain mutable properties; the
      // `ReadableSpan` API just exposes them as read-only. We use the
      // narrow `MutableEndedSpan` shape (instead of `any`) so the mutation
      // surface is restricted to exactly the two fields the App Insights
      // GenAI attribution spec requires us to rewrite.
      const mutable = span as MutableEndedSpan;

      if (mutable.attributes) {
        mutable.attributes[ATTR_GEN_AI_REQUEST_MODEL] = deploymentAlias;
      }

      const currentName = typeof mutable.name === "string" ? mutable.name : "";
      if (currentName.startsWith(`${GEN_AI_OPERATION_CHAT} `)) {
        mutable.name = `${GEN_AI_OPERATION_CHAT} ${deploymentAlias}`;
      }

      // Drop the bridge entry now that we've consumed it.
      deploymentAliasBySpan.delete(span as unknown as object);
    } catch (error) {
      Logger.getInstance().warn("Error while applying Azure deployment alias to span", error);
    }
  }

  async shutdown(): Promise<void> {
    // No-op
  }

  async forceFlush(): Promise<void> {
    // No-op
  }
}
