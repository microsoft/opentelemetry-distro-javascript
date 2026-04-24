// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export type InternalPerRequestOptions = {
  enabled: boolean;
  maxTraces: number;
  maxSpansPerTrace: number;
  maxConcurrentExports: number;
  flushGraceMs: number;
  maxTraceAgeMs: number;
};

export const INTERNAL_A365_ENV_VARS = {
  PER_REQUEST_EXPORT_ENABLED: "ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT",
  PER_REQUEST_MAX_TRACES: "A365_PER_REQUEST_MAX_TRACES",
  PER_REQUEST_MAX_SPANS_PER_TRACE: "A365_PER_REQUEST_MAX_SPANS_PER_TRACE",
  PER_REQUEST_MAX_CONCURRENT_EXPORTS: "A365_PER_REQUEST_MAX_CONCURRENT_EXPORTS",
  PER_REQUEST_FLUSH_GRACE_MS: "A365_PER_REQUEST_FLUSH_GRACE_MS",
  PER_REQUEST_MAX_TRACE_AGE_MS: "A365_PER_REQUEST_MAX_TRACE_AGE_MS",
} as const;

const DEFAULT_PER_REQUEST_MAX_TRACES = 1000;
const DEFAULT_PER_REQUEST_MAX_SPANS_PER_TRACE = 5000;
const DEFAULT_PER_REQUEST_MAX_CONCURRENT_EXPORTS = 20;
const DEFAULT_PER_REQUEST_FLUSH_GRACE_MS = 250;
const DEFAULT_PER_REQUEST_MAX_TRACE_AGE_MS = 30 * 60 * 1000;

function parseEnvBoolean(envValue: string | undefined): boolean | undefined {
  if (!envValue) return undefined;
  const normalized = envValue.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parsePositiveInt(envValue: string | undefined): number | undefined {
  if (!envValue) return undefined;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function resolveInternalPerRequestOptions(): InternalPerRequestOptions {
  return {
    enabled:
      parseEnvBoolean(process.env[INTERNAL_A365_ENV_VARS.PER_REQUEST_EXPORT_ENABLED]) ?? false,
    maxTraces:
      parsePositiveInt(process.env[INTERNAL_A365_ENV_VARS.PER_REQUEST_MAX_TRACES]) ??
      DEFAULT_PER_REQUEST_MAX_TRACES,
    maxSpansPerTrace:
      parsePositiveInt(process.env[INTERNAL_A365_ENV_VARS.PER_REQUEST_MAX_SPANS_PER_TRACE]) ??
      DEFAULT_PER_REQUEST_MAX_SPANS_PER_TRACE,
    maxConcurrentExports:
      parsePositiveInt(process.env[INTERNAL_A365_ENV_VARS.PER_REQUEST_MAX_CONCURRENT_EXPORTS]) ??
      DEFAULT_PER_REQUEST_MAX_CONCURRENT_EXPORTS,
    flushGraceMs:
      parsePositiveInt(process.env[INTERNAL_A365_ENV_VARS.PER_REQUEST_FLUSH_GRACE_MS]) ??
      DEFAULT_PER_REQUEST_FLUSH_GRACE_MS,
    maxTraceAgeMs:
      parsePositiveInt(process.env[INTERNAL_A365_ENV_VARS.PER_REQUEST_MAX_TRACE_AGE_MS]) ??
      DEFAULT_PER_REQUEST_MAX_TRACE_AGE_MS,
  };
}
