// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor as BaseSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS,
  GEN_AI_OPERATION_CHAT,
} from "../../genai/index.js";
import { Logger } from "../../shared/logging/index.js";

/**
 * Azure Monitor Span Processor that applies Azure-specific decisioning to
 * spans produced by the LangChain GenAI instrumentation.
 *
 * The LangChain instrumentation deliberately stays vendor-neutral: it sets
 * `gen_ai.request.model` from LangChain-generic fields only and surfaces the
 * raw LangChain "deployment alias" (when present) under the bridge attribute
 * {@link ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS}. This processor owns the
 * Azure-specific behavior of preferring that deployment alias over the
 * resolved request model, which is the right value for AzureChatOpenAI /
 * AzureOpenAI users (LangChain.js otherwise fills `invocation_params.model`
 * with a default like `gpt-3.5-turbo` even when only a deployment was
 * configured).
 *
 * The processor:
 *  - Overwrites `gen_ai.request.model` with the deployment alias.
 *  - Updates the span name to `chat <deployment-alias>` when applicable so
 *    the user-facing identifier matches the configured deployment.
 *  - Removes the bridge attribute so it is not exported.
 *
 * @internal
 */
export class AzureMonitorLangChainModelProcessor implements BaseSpanProcessor {
  /** Span attributes are mutated before export. No work to do on start. */
  onStart(_span: Span, _parentContext: Context): void {
    // No-op: invocation params are not yet known at start time.
  }

  /**
   * Called when a span ends. If the LangChain instrumentation surfaced a
   * deployment alias, override the request model and span name accordingly.
   *
   * Mutates the underlying span via the same casting pattern used by other
   * processors in this distro (see `A365SpanProcessor`). This is necessary
   * because attributes / span name need to be rewritten after the
   * instrumentation has populated them but before the batch processor exports
   * the span.
   */
  onEnd(span: ReadableSpan): void {
    try {
      const attrs = span.attributes;
      const deploymentAlias = attrs?.[ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS];
      if (typeof deploymentAlias !== "string" || deploymentAlias.length === 0) {
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mutable = span as any;

      // Override gen_ai.request.model so Azure deployment users see their
      // configured deployment name (instead of LangChain's default).
      if (mutable.attributes) {
        mutable.attributes[ATTR_GEN_AI_REQUEST_MODEL] = deploymentAlias;
        // Strip the internal bridge attribute so it does not leak to exporters.
        delete mutable.attributes[ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS];
      }

      // Keep the span name aligned with the rewritten request model for
      // chat operations (e.g. "chat my-gpt4o-deployment").
      const currentName = typeof mutable.name === "string" ? (mutable.name as string) : "";
      if (currentName.startsWith(`${GEN_AI_OPERATION_CHAT} `)) {
        mutable.name = `${GEN_AI_OPERATION_CHAT} ${deploymentAlias}`;
      }
    } catch (error) {
      Logger.getInstance().warn(
        "Error while applying Azure deployment alias to LangChain span",
        error,
      );
    }
  }

  async shutdown(): Promise<void> {
    // No-op
  }

  async forceFlush(): Promise<void> {
    // No-op
  }
}
