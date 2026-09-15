// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";

export interface SampleConfig {
  authority: URL;
  blueprintClientId: string;
  blueprintClientSecret: string;
  tenantId: string;
  agentId: string;
  clusterCategory: "prod";
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(key: string): Error {
  return new Error(`Invalid sample configuration (${key}).`);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw invalid(key);
  }

  const normalized = value.trim();
  if (normalized.length === 0 || (normalized.startsWith("<") && normalized.endsWith(">"))) {
    throw invalid(key);
  }
  return normalized;
}

function requiredGuid(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key);
  if (!GUID_PATTERN.test(value)) {
    throw invalid(key);
  }
  return value;
}

function parseAuthority(value: string): URL {
  let authority: URL;
  try {
    authority = new URL(value);
  } catch {
    throw invalid("authority");
  }

  if (
    authority.protocol !== "https:" ||
    authority.pathname !== "/" ||
    authority.search !== "" ||
    authority.hash !== "" ||
    authority.username !== "" ||
    authority.password !== ""
  ) {
    throw invalid("authority");
  }
  return authority;
}

export function parseSampleConfig(value: unknown): SampleConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("root");
  }

  const input = value as Record<string, unknown>;
  const clusterCategory = input.clusterCategory ?? "prod";
  if (clusterCategory !== "prod") {
    throw invalid("clusterCategory");
  }

  return {
    authority: parseAuthority(requiredString(input, "authority")),
    blueprintClientId: requiredGuid(input, "blueprintClientId"),
    blueprintClientSecret: requiredString(input, "blueprintClientSecret"),
    tenantId: requiredGuid(input, "tenantId"),
    agentId: requiredGuid(input, "agentId"),
    clusterCategory,
  };
}

export async function loadSampleConfig(path = "appsettings.json"): Promise<SampleConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("Unable to load sample configuration.");
  }
  return parseSampleConfig(parsed);
}
