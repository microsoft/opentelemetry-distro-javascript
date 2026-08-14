// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import type { ClusterCategory } from "../../configuration/A365ConfigurationOptions.js";

export const DURABLE_RECORD_VERSION = 1 as const;
// PersistentStore's lease filename format is
// `${createdAt}-${id}.lease-at-${Date.now()}-${pid}-${randomUUID()}`, and
// filesystems commonly reject any single path component over 255 bytes
// (NAME_MAX). Budgeting generously for every variable part -- createdAt and
// the in-lease Date.now() at up to 21 digits each (the longest plain-decimal
// string JS ever produces before switching to exponential notation),
// process.pid at up to 10 digits (a full 32-bit value), and the fixed
// 36-character UUID -- the literal overhead alone (".lease-at-", the
// hyphens, ".pending"/etc.) plus those bounds consumes up to ~101 bytes,
// leaving no more than ~154 bytes of headroom for the id. 128 is a
// comfortably safe, round bound well under that worst case, while still far
// exceeding the 36-character UUIDs createDurableRecord() actually generates.
const MAX_DURABLE_RECORD_ID_LENGTH = 128;
const SAFE_DURABLE_RECORD_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

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
  useS2SEndpoint: boolean;
  body: string;
}

type DurableRecordV1CreateInput = Omit<DurableRecordV1, "version" | "id" | "createdAt"> & {
  clusterCategory?: ClusterCategory;
  domainOverride?: string;
};

export function createDurableRecord(input: DurableRecordV1CreateInput): DurableRecordV1 {
  return {
    version: DURABLE_RECORD_VERSION,
    id: randomUUID(),
    createdAt: Date.now(),
    tenantId: input.tenantId,
    agentId: input.agentId,
    agenticUserId: input.agenticUserId,
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
    !isSafeDurableRecordId(value.id) ||
    typeof value.createdAt !== "number" ||
    typeof value.tenantId !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.useS2SEndpoint !== "boolean" ||
    typeof value.body !== "string" ||
    !isOptionalString(value.agenticUserId) ||
    !isOptionalClusterCategory(value.clusterCategory) ||
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

function isOptionalClusterCategory(value: unknown): value is ClusterCategory | undefined {
  return value === undefined || isClusterCategory(value);
}

function isSafeDurableRecordId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DURABLE_RECORD_ID_LENGTH &&
    SAFE_DURABLE_RECORD_ID_PATTERN.test(value)
  );
}

function isClusterCategory(value: unknown): value is ClusterCategory {
  return typeof value === "string" && CLUSTER_CATEGORIES.includes(value as ClusterCategory);
}
