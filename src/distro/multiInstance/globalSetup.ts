// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

import {
  ParentLoggerProvider,
  ParentMeterProvider,
  ParentTracerProvider,
} from "./delegatingProviders.js";

let globalSetupDone = false;

/**
 * Register the parent (delegating) providers and the shared process-global
 * context manager + propagator exactly once. Context and propagation are
 * process-wide concerns shared by every instance, so they are NOT duplicated
 * per instance.
 *
 * Idempotent: safe to call on every `useMicrosoftOpenTelemetry()` /
 * `createMicrosoftOpenTelemetryInstance()` invocation.
 */
export function ensureGlobalSetup(): void {
  if (globalSetupDone) {
    return;
  }

  // Clear any stale OpenTelemetry API global state to avoid version conflicts
  // (mirrors the cleanup performed by the single-instance distro path).
  trace.disable();
  metrics.disable();
  logs.disable();
  const globalOpentelemetryApiKey = Symbol.for("opentelemetry.js.api.1");
  delete (globalThis as Record<symbol, unknown>)[globalOpentelemetryApiKey];

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );

  trace.setGlobalTracerProvider(new ParentTracerProvider());
  metrics.setGlobalMeterProvider(new ParentMeterProvider());
  logs.setGlobalLoggerProvider(new ParentLoggerProvider());

  globalSetupDone = true;
}

/** Test helper: allow re-running global setup. @internal */
export function _resetGlobalSetup(): void {
  globalSetupDone = false;
}
