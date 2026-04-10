// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Read an environment variable, trimmed and lowercased.
 * Returns undefined if not set or empty.
 */
export function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  return value || undefined;
}
