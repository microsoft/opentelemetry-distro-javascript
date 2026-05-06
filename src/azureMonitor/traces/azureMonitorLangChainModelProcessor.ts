// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Context, Span as ApiSpan } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor as BaseSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Run } from "@langchain/core/tracers/base";
import { ATTR_GEN_AI_REQUEST_MODEL, GEN_AI_OPERATION_CHAT } from "../../genai/index.js";
import { registerLangChainSpanEnricher } from "../../genai/instrumentations/langchain/index.js";
import { Logger } from "../../shared/logging/index.js";

/**
 * LangChain-specific field names that Azure-backed clients (AzureChatOpenAI /
 * AzureOpenAI) populate on `Run.extra.invocation_params` when configured with
 * a deployment instead of a raw model name. Owned by the Azure module — the
 * vendor-neutral LangChain instrumentation has no knowledge of these.
 */
const AZURE_DEPLOYMENT_ALIAS_FIELDS: ReadonlyArray<string> = [
  "azureOpenAIApiDeploymentName",
  "azure_deployment",
  "deployment_name",
];

function extractAzureDeploymentAlias(run: Run): string | undefined {
  const invocationParams = run.extra?.invocation_params as Record<string, unknown> | undefined;
  if (!invocationParams) return undefined;
  for (const field of AZURE_DEPLOYMENT_ALIAS_FIELDS) {
    const raw = invocationParams[field];
    if (raw == null) continue;
    const value = String(raw).trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

/**
 * Module-scoped bridge between the enricher (which sees the LangChain `Run`
 * and the live API `Span`) and the span processor (which only sees a
 * `ReadableSpan` later). Using a WeakMap keyed by the span object means
 *   - nothing Azure-internal ever lands on the span as an attribute, and
 *   - entries are garbage-collected with the span.
 */
const deploymentAliasBySpan = new WeakMap<object, string>();

/**
 * Span enricher that captures the Azure-specific LangChain deployment alias
 * for later consumption by {@link AzureMonitorLangChainModelProcessor}.
 */
function azureLangChainDeploymentAliasEnricher(run: Run, span: ApiSpan): void {
  const alias = extractAzureDeploymentAlias(run);
  if (alias) {
    deploymentAliasBySpan.set(span as unknown as object, alias);
  }
}

/**
 * Azure Monitor Span Processor that applies Azure-specific decisioning to
 * spans produced by the LangChain GenAI instrumentation.
 *
 * The vendor-neutral LangChain instrumentation populates `gen_ai.request.model`
 * from LangChain-generic fields only. This processor:
 *   - Registers an Azure-specific span enricher with the instrumentation that
 *     extracts the LangChain deployment-alias fields from a `Run` and stashes
 *     them in a module-scoped `WeakMap<Span, string>` keyed by the live span.
 *   - On `onEnd`, looks the span up in the WeakMap and (if a deployment alias
 *     was captured) overrides `gen_ai.request.model` and rewrites the
 *     `chat <model>` span name. AzureChatOpenAI users would otherwise see the
 *     LangChain default (e.g. `gpt-3.5-turbo`) instead of their configured
 *     deployment because LangChain.js fills `invocation_params.model` even
 *     when only a deployment was configured.
 *
 * @internal
 */
export class AzureMonitorLangChainModelProcessor implements BaseSpanProcessor {
  private readonly _unregisterEnricher: () => void;

  constructor() {
    // The langchain registry de-duplicates by reference, so calling this on
    // every construction is safe (multiple processor instances share the
    // single registration of the module-scoped enricher function).
    this._unregisterEnricher = registerLangChainSpanEnricher(azureLangChainDeploymentAliasEnricher);
  }

  onStart(_span: Span, _parentContext: Context): void {
    // No-op: invocation params are not yet known at start time.
  }

  /**
   * If the LangChain enricher captured a deployment alias for this span,
   * override the request model and rewrite the chat span name accordingly.
   */
  onEnd(span: ReadableSpan): void {
    try {
      const deploymentAlias = deploymentAliasBySpan.get(span as unknown as object);
      if (typeof deploymentAlias !== "string" || deploymentAlias.length === 0) {
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mutable = span as any;

      if (mutable.attributes) {
        mutable.attributes[ATTR_GEN_AI_REQUEST_MODEL] = deploymentAlias;
      }

      const currentName = typeof mutable.name === "string" ? (mutable.name as string) : "";
      if (currentName.startsWith(`${GEN_AI_OPERATION_CHAT} `)) {
        mutable.name = `${GEN_AI_OPERATION_CHAT} ${deploymentAlias}`;
      }

      // Drop the bridge entry now that we've consumed it.
      deploymentAliasBySpan.delete(span as unknown as object);
    } catch (error) {
      Logger.getInstance().warn(
        "Error while applying Azure deployment alias to LangChain span",
        error,
      );
    }
  }

  async shutdown(): Promise<void> {
    this._unregisterEnricher();
  }

  async forceFlush(): Promise<void> {
    // No-op
  }

  /** @internal Exposed for tests to drive the enricher / WeakMap directly. */
  static readonly _enricherForTesting = azureLangChainDeploymentAliasEnricher;
  /** @internal Exposed for tests to inspect the bridge state. */
  static readonly _bridgeForTesting = deploymentAliasBySpan;
}
