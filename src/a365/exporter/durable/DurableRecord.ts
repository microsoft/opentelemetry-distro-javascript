// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import type { ClusterCategory } from "../../configuration/A365ConfigurationOptions.js";

export const DURABLE_RECORD_VERSION = 1 as const;

const CLUSTER_CATEGORIES: readonly ClusterCategory[] = [
  "local",
  "dev",
  "test",
  "preprod",
  "firstrelease",
  "prod",
  "gov",
  "high",
  "dod",
  "mooncake",
  "ex",
  "rx",
] as const;

export interface DurableRecordV1 {
  version: typeof DURABLE_RECORD_VERSION;
  id: string;
  createdAt: number;
  tenantId: string;
  agentId: string;
  agenticUserId?: string;
  clusterCategory: ClusterCategory;
  domainOverride?: string;
  useS2SEndpoint: boolean;
  body: string;
}

export function createDurableRecord(
  input: Omit<DurableRecordV1, "version" | "id" | "createdAt">,
): DurableRecordV1 {
  return {
    version: DURABLE_RECORD_VERSION,
    id: randomUUID(),
    createdAt: Date.now(),
    tenantId: input.tenantId,
    agentId: input.agentId,
    agenticUserId: input.agenticUserId,
    clusterCategory: input.clusterCategory,
    domainOverride: input.domainOverride,
    useS2SEndpoint: input.useS2SEndpoint,
    body: input.body,
  };
}

export function parseDurableRecord(text: string): DurableRecordV1 {
  const value: unknown = JSON.parse(text);
  if (!isObject(value) || value.version !== DURABLE_RECORD_VERSION) {
    throw new Error("Unsupported durable record version");
  }

  if (
    typeof value.id !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.tenantId !== "string" ||
    typeof value.agentId !== "string" ||
    !isClusterCategory(value.clusterCategory) ||
    typeof value.useS2SEndpoint !== "boolean" ||
    typeof value.body !== "string" ||
    !isOptionalString(value.agenticUserId) ||
    !isOptionalString(value.domainOverride)
  ) {
    throw new Error("Invalid durable record");
  }

  return {
    version: DURABLE_RECORD_VERSION,
    id: value.id,
    createdAt: value.createdAt,
    tenantId: value.tenantId,
    agentId: value.agentId,
    agenticUserId: value.agenticUserId,
    clusterCategory: value.clusterCategory,
    domainOverride: value.domainOverride,
    useS2SEndpoint: value.useS2SEndpoint,
    body: value.body,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isClusterCategory(value: unknown): value is ClusterCategory {
  return typeof value === "string" && CLUSTER_CATEGORIES.includes(value as ClusterCategory);
}
