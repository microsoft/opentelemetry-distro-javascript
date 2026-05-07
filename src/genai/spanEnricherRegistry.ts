// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Span } from "@opentelemetry/api";

/**
 * Generic span enricher signature. The first argument is the framework-specific
 * "run" object (e.g. a LangChain `Run`); this module intentionally types it as
 * `unknown` so the registry has no runtime dependency on any particular GenAI
 * framework. Consumers cast as needed.
 */
export type SpanEnricher = (run: unknown, span: Span) => void;

const enrichers: SpanEnricher[] = [];
const refCounts = new Map<SpanEnricher, number>();

/**
 * Register an enricher to be invoked for every completed run mapped to a span
 * by an integration (e.g. the LangChain tracer). Returns an unregister thunk.
 *
 * Registration is reference-counted by function reference: registering the
 * same enricher N times keeps a single entry in the active list and requires
 * N matching unregister calls before the entry is removed. Each call returns
 * its own unregister thunk so independent owners (e.g. multiple
 * `TraceHandler` instances in the same process) can coordinate safely
 * without shutting down one of them tearing down the enricher for the others.
 *
 * Each returned thunk is itself idempotent — calling it more than once has
 * no additional effect.
 */
export function registerSpanEnricher(enricher: SpanEnricher): () => void {
  const previous = refCounts.get(enricher) ?? 0;
  refCounts.set(enricher, previous + 1);
  if (previous === 0) {
    enrichers.push(enricher);
  }

  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    const current = refCounts.get(enricher);
    if (current === undefined) return;
    if (current <= 1) {
      refCounts.delete(enricher);
      const idx = enrichers.indexOf(enricher);
      if (idx >= 0) enrichers.splice(idx, 1);
    } else {
      refCounts.set(enricher, current - 1);
    }
  };
}

/** Internal: called by GenAI integrations from their tracing lifecycle. */
export function getRegisteredSpanEnrichers(): readonly SpanEnricher[] {
  return enrichers;
}
