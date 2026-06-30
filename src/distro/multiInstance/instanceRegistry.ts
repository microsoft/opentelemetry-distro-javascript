// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Context, TracerProvider, MeterProvider } from "@opentelemetry/api";
import { context, createContextKey } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";

/**
 * The set of child providers owned by a single SDK instance. The parent
 * (delegating) providers route to one of these based on the ambient
 * "current instance".
 */
export interface InstanceProviders {
  readonly tracerProvider: TracerProvider;
  readonly meterProvider: MeterProvider;
  readonly loggerProvider: LoggerProvider;
}

const CURRENT_INSTANCE_KEY = createContextKey("microsoft.opentelemetry.current_instance");

const registry = new Map<string, InstanceProviders>();
let defaultInstanceId: string | undefined;

/**
 * Register a child instance. The first registered instance becomes the default
 * so that global API access (e.g. `trace.getTracer(...)`) keeps working exactly
 * as it does in the single-instance case.
 */
export function registerInstance(id: string, providers: InstanceProviders): void {
  registry.set(id, providers);
  if (defaultInstanceId === undefined) {
    defaultInstanceId = id;
  }
}

/**
 * Remove a child instance from the registry. If it was the default, the next
 * remaining instance (if any) is promoted to default.
 */
export function unregisterInstance(id: string): void {
  registry.delete(id);
  if (defaultInstanceId === id) {
    defaultInstanceId = registry.keys().next().value;
  }
}

/** Explicitly mark an already-registered instance as the default. */
export function setDefaultInstance(id: string): void {
  if (registry.has(id)) {
    defaultInstanceId = id;
  }
}

export function getDefaultInstanceId(): string | undefined {
  return defaultInstanceId;
}

export function getInstanceProviders(id: string): InstanceProviders | undefined {
  return registry.get(id);
}

/**
 * Bind `id` as the ambient current instance for the duration of `fn`.
 *
 * If `id` is not a registered instance (e.g. an unknown or stale id, or one
 * used after `shutdown()`), the binding is skipped so resolution falls back to
 * the default instance rather than silently producing no-op telemetry.
 */
export function withInstance<T>(id: string, fn: () => T): T {
  if (!registry.has(id)) {
    return fn();
  }
  return context.with(context.active().setValue(CURRENT_INSTANCE_KEY, id), fn);
}

/** Read the current instance id bound to a context (defaults to the active one). */
export function getCurrentInstanceId(ctx: Context = context.active()): string | undefined {
  return ctx.getValue(CURRENT_INSTANCE_KEY) as string | undefined;
}

/**
 * Resolve the providers of the instance that should handle the current
 * operation: the ambient instance if one is bound, otherwise the default.
 */
export function resolveInstanceProviders(): InstanceProviders | undefined {
  const id = getCurrentInstanceId() ?? defaultInstanceId;
  return id ? registry.get(id) : undefined;
}

/** Test helper: clear all registry state. @internal */
export function _resetRegistry(): void {
  registry.clear();
  defaultInstanceId = undefined;
}
