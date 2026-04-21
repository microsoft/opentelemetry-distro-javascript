// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Per-request export token context propagation.
 *
 * Uses OpenTelemetry Context (backed by AsyncLocalStorage) to carry and
 * refresh a per-request bearer token that the PerRequestSpanProcessor
 * restores at export time.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability/src/tracing/context/token-context.ts
 */

import { context, createContextKey } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { Logger } from "../../shared/logging/index.js";

const EXPORT_TOKEN_KEY = createContextKey("a365_export_token");

/**
 * Mutable holder stored in Context so the token can be refreshed
 * after the context is created (OTel contexts are immutable, but
 * the object reference stays the same).
 */
interface TokenHolder {
  token: string;
}

/**
 * Run a function within a Context that carries the per-request export token.
 * This keeps the token only in OTel Context (ALS), never in any registry.
 *
 * The token can be updated later via `updateExportToken()` before the trace
 * is flushed — useful when the callback is long-running and the original
 * token may expire before export.
 */
export function runWithExportToken<T>(token: string, fn: () => T): T {
  const holder: TokenHolder = { token };
  const ctxWithToken = context.active().setValue(EXPORT_TOKEN_KEY, holder);
  Logger.getInstance().info("[TokenContext] Running function with export token in context.");
  return context.with(ctxWithToken, fn);
}

/**
 * Update the export token in the active OTel Context.
 * Call this to refresh the token before ending the root span when the
 * original token may have expired during a long-running request.
 *
 * Must be called within the same async context created by `runWithExportToken`.
 * @param token The fresh token to use for export.
 * @returns true if the token was updated successfully, false if no token holder was found.
 */
export function updateExportToken(token: string): boolean {
  const value = context.active().getValue(EXPORT_TOKEN_KEY);
  if (value && typeof value === "object" && "token" in value) {
    (value as TokenHolder).token = token;
    Logger.getInstance().info("[TokenContext] Export token updated in context.");
    return true;
  }
  Logger.getInstance().warn(
    "[TokenContext] updateExportToken called but no token holder found in active context. Was runWithExportToken called?",
  );
  return false;
}

/**
 * Retrieve the per-request export token from a given OTel Context (or the active one).
 */
export function getExportToken(ctx: Context = context.active()): string | undefined {
  const value = ctx.getValue(EXPORT_TOKEN_KEY);
  if (value && typeof value === "object" && "token" in value) {
    return (value as TokenHolder).token;
  }
  // Backward compat: support raw string values from older callers
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}
