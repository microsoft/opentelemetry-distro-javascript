// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Context propagation utilities for A365 observability.
 *
 * Provides:
 * - `ParentSpanRef` for explicit parent-child linking across async boundaries
 * - `createContextWithParentSpanRef` / `runWithParentSpanRef` helpers
 * - `isParentSpanRef` type guard
 * - W3C traceparent inject/extract helpers
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability/src/tracing/context/
 */

import { context, trace, propagation } from "@opentelemetry/api";
import type { Context, SpanContext } from "@opentelemetry/api";
import { TraceFlags } from "@opentelemetry/api";
import type { ParentSpanRef } from "./contracts.js";
import { Logger } from "../shared/logging/index.js";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidTraceId(traceId: string): boolean {
  return /^[0-9a-f]{32}$/i.test(traceId) && traceId !== "00000000000000000000000000000000";
}

function isValidSpanId(spanId: string): boolean {
  return /^[0-9a-f]{16}$/i.test(spanId) && spanId !== "0000000000000000";
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/** Type guard to distinguish a ParentSpanRef from an OTel Context. */
export function isParentSpanRef(value: unknown): value is ParentSpanRef {
  if (typeof value !== "object" || value === null) return false;

  const maybeCtx = value as Record<string, unknown>;
  if (
    typeof maybeCtx.getValue === "function" &&
    typeof maybeCtx.setValue === "function" &&
    typeof maybeCtx.deleteValue === "function"
  ) {
    return false;
  }

  const maybeRef = value as ParentSpanRef;
  return (
    "traceId" in maybeRef &&
    typeof maybeRef.traceId === "string" &&
    "spanId" in maybeRef &&
    typeof maybeRef.spanId === "string"
  );
}

// ---------------------------------------------------------------------------
// Parent span context
// ---------------------------------------------------------------------------

/**
 * Creates a new Context with an explicit parent span reference.
 * This allows child spans to be correctly parented even when async context is broken.
 */
export function createContextWithParentSpanRef(base: Context, parent: ParentSpanRef): Context {
  const logger = Logger.getInstance();

  if (!isValidTraceId(parent.traceId) || !isValidSpanId(parent.spanId)) {
    logger.warn(
      `[A365] Invalid parent span reference; returning base context. traceId=${parent.traceId}, spanId=${parent.spanId}`,
    );
    return base;
  }

  const activeCtx = trace.getSpan(base)?.spanContext();
  const traceFlags =
    parent.traceFlags ??
    (activeCtx?.traceId === parent.traceId ? activeCtx.traceFlags : undefined) ??
    TraceFlags.SAMPLED;

  const parentSpanContext: SpanContext = {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags,
    traceState: parent.traceState,
    isRemote: parent.isRemote ?? true,
  };

  const parentSpan = trace.wrapSpanContext(parentSpanContext);
  return trace.setSpan(base, parentSpan);
}

/**
 * Runs a callback within a context that has an explicit parent span reference.
 */
export function runWithParentSpanRef<T>(parent: ParentSpanRef, callback: () => T): T {
  const contextWithParent = createContextWithParentSpanRef(context.active(), parent);
  return context.with(contextWithParent, callback);
}

// ---------------------------------------------------------------------------
// W3C trace context propagation
// ---------------------------------------------------------------------------

/** Carrier type for HTTP headers. */
export type HeadersCarrier = Record<string, string | string[] | undefined>;

/**
 * Injects the current trace context (`traceparent`/`tracestate` headers) into
 * the provided headers object using the globally registered W3C propagator.
 */
export function injectContextToHeaders(
  headers: Record<string, string>,
  ctx?: Context,
): Record<string, string> {
  propagation.inject(ctx ?? context.active(), headers);
  return headers;
}

/**
 * Extracts trace context from incoming HTTP headers using the globally
 * registered W3C propagator.
 */
export function extractContextFromHeaders(headers: HeadersCarrier, baseCtx?: Context): Context {
  return propagation.extract(baseCtx ?? context.active(), headers);
}

/**
 * Extracts trace context from incoming HTTP headers and runs the callback
 * within that context.
 */
export function runWithExtractedTraceContext<T>(headers: HeadersCarrier, callback: () => T): T {
  return context.with(extractContextFromHeaders(headers), callback);
}
