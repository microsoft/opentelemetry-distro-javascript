// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Global, process-wide state for SDK self-telemetry (SDKStats).
 *
 * Feature and instrumentation flags are stored as bitmasks so they can be
 * combined and reported efficiently. The bitmask values are intentionally
 * compatible with the Azure Monitor Exporter statsbeat encoding so that
 * Azure Monitor consumers see no behavioural change when the distro
 * bridges its bits into the exporter's existing pipeline.
 *
 * Mirrors `src/microsoft/opentelemetry/_sdkstats/_state.py` from the
 * Python distro (microsoft/opentelemetry-distro-python#89).
 */

import { StatsbeatFeature, StatsbeatInstrumentation } from "../types.js";

/**
 * Distro-specific feature flags, in addition to the
 * {@link StatsbeatFeature} flags shared with the Azure Monitor exporter.
 *
 * These bit values intentionally start above the values used by
 * {@link StatsbeatFeature} so that distro bits and exporter bits can be
 * OR-combined into a single 64-bit mask without collision.
 */
export enum SdkStatsDistroFeature {
  NONE = 0,
  A365_EXPORT = 512,
  OTLP_EXPORT = 1024,
  CONSOLE_EXPORT = 2048,
  SPECTRA_EXPORT = 4096,
}

/**
 * Environment variable that disables SDKStats globally.
 *
 * When set to a truthy value (`true`, `1`, `yes`, `on`), the standalone
 * SDKStats pipeline is not started and no SDKStats data is emitted.
 *
 * @internal
 */
export const SDKSTATS_DISABLED_ENV = "MICROSOFT_OTEL_SDKSTATS_DISABLED";

/**
 * Legacy Azure Monitor kill-switch, also honoured for parity with the
 * exporter package.
 *
 * @internal
 */
export const APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL =
  "APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL";

const TRUTHY_VALUES = new Set(["true", "1", "yes", "on"]);

/**
 * Return `true` unless SDKStats has been disabled via env var.
 */
export function isSdkStatsEnabled(): boolean {
  for (const envVar of [SDKSTATS_DISABLED_ENV, APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL]) {
    const raw = process.env[envVar];
    if (!raw) continue;
    if (TRUTHY_VALUES.has(raw.trim().toLowerCase())) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mutable global state — kept module-local to ensure a single source of truth
// across the distro process. Node.js executes JS in a single thread (modulo
// worker_threads), so no explicit locking is needed.
// ---------------------------------------------------------------------------

let _featureBits = 0;
let _instrumentationBits = 0;
let _shutdown = false;

export function setSdkStatsFeature(flag: StatsbeatFeature | SdkStatsDistroFeature): void {
  _featureBits |= flag;
}

export function getSdkStatsFeatureFlags(): number {
  return _featureBits;
}

export function setSdkStatsInstrumentation(flag: StatsbeatInstrumentation): void {
  _instrumentationBits |= flag;
}

export function getSdkStatsInstrumentationFlags(): number {
  return _instrumentationBits;
}

export function setSdkStatsShutdown(shutdown = true): void {
  _shutdown = shutdown;
}

export function getSdkStatsShutdown(): boolean {
  return _shutdown;
}

/**
 * @internal Test-only: reset all SDKStats state to defaults.
 */
export function _resetSdkStatsStateForTest(): void {
  _featureBits = 0;
  _instrumentationBits = 0;
  _shutdown = false;
}
