// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ClusterCategory } from "../configuration/A365ConfigurationOptions.js";
import { Logger } from "../../shared/logging/index.js";
import { ExporterEventNames } from "./ExporterEventNames.js";
import {
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_MICROSOFT_TENANT_ID,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
  GEN_AI_OPERATION_OUTPUT_MESSAGES,
} from "../../genai/semconv.js";
import { A365_MESSAGE_SCHEMA_VERSION } from "../contracts.js";

// Message attribute keys that receive special truncation handling
const MESSAGE_ATTR_KEYS: Set<string> = new Set([
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
]);

const MESSAGE_ROLE_SYSTEM = "system";

/**
 * Known genAI operation names produced by the SDK scopes and auto-instrumentation.
 * Only spans whose gen_ai.operation.name matches one of these values are exported.
 */
const GEN_AI_OPERATION_NAMES: ReadonlySet<string> = new Set([
  GEN_AI_OPERATION_INVOKE_AGENT, // 'invoke_agent'
  GEN_AI_OPERATION_EXECUTE_TOOL, // 'execute_tool'
  GEN_AI_OPERATION_OUTPUT_MESSAGES, // 'output_messages'
  GEN_AI_OPERATION_CHAT, // 'chat'
  "Chat", // InferenceOperationType.CHAT
  "TextCompletion", // InferenceOperationType.TEXT_COMPLETION
  "GenerateContent", // InferenceOperationType.GENERATE_CONTENT
]);

/**
 * Partition spans by (tenantId, agentId) identity pairs.
 * Only genAI spans (those with a known gen_ai.operation.name) are included.
 */
export function partitionByIdentity(spans: ReadableSpan[]): Map<string, ReadableSpan[]> {
  const groups = new Map<string, ReadableSpan[]>();

  let nonGenAICount = 0;
  let missingIdentityCount = 0;

  for (const span of spans) {
    const attrs = span.attributes || {};
    const operationName = asStr(attrs[ATTR_GEN_AI_OPERATION_NAME]);

    if (!operationName || !GEN_AI_OPERATION_NAMES.has(operationName)) {
      nonGenAICount++;
      continue;
    }

    const tenant = asStr(attrs[ATTR_MICROSOFT_TENANT_ID]);
    const agent = asStr(attrs[ATTR_GEN_AI_AGENT_ID]);

    if (!tenant || !agent) {
      missingIdentityCount++;
      continue;
    }

    const key = `${tenant}:${agent}`;
    let existing = groups.get(key);
    if (!existing) {
      existing = [];
      groups.set(key, existing);
    }
    existing.push(span);
  }

  if (nonGenAICount > 0) {
    Logger.getInstance().info(
      `[Agent365Exporter] ${nonGenAICount} non-genAI spans filtered out`,
    );
  }

  if (missingIdentityCount > 0) {
    Logger.getInstance().info(
      `[${ExporterEventNames.EXPORT_PARTITION_SPAN_MISSING_IDENTITY}] ${missingIdentityCount} spans skipped (missing tenant or agent ID)`,
    );
  }

  const skippedCount = nonGenAICount + missingIdentityCount;
  Logger.getInstance().info(
    `[Agent365Exporter] Partitioned into ${groups.size} identity groups (${skippedCount} spans skipped)`,
  );

  return groups;
}

/** Parse identity key back to tenant and agent IDs. */
export function parseIdentityKey(key: string): { tenantId: string; agentId: string } {
  const idx = key.indexOf(":");
  return { tenantId: key.slice(0, idx), agentId: key.slice(idx + 1) };
}

/** Convert trace ID to hex string (32 hex chars). */
export function hexTraceId(value: string | number): string {
  if (typeof value === "number") {
    return value.toString(16).padStart(32, "0");
  }
  return value.replace(/^0x/, "").padStart(32, "0");
}

/** Convert span ID to hex string (16 hex chars). */
export function hexSpanId(value: string | number): string {
  if (typeof value === "number") {
    return value.toString(16).padStart(16, "0");
  }
  return value.replace(/^0x/, "").padStart(16, "0");
}

/** Convert any value to a trimmed string, or undefined if empty/null. */
export function asStr(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s.trim() ? s : undefined;
}

/** Get span kind name. */
export function kindName(kind: SpanKind): string {
  switch (kind) {
    case SpanKind.INTERNAL:
      return "INTERNAL";
    case SpanKind.SERVER:
      return "SERVER";
    case SpanKind.CLIENT:
      return "CLIENT";
    case SpanKind.PRODUCER:
      return "PRODUCER";
    case SpanKind.CONSUMER:
      return "CONSUMER";
    default:
      return "UNSPECIFIED";
  }
}

/** Get status name. */
export function statusName(code: SpanStatusCode): string {
  switch (code) {
    case SpanStatusCode.UNSET:
      return "UNSET";
    case SpanStatusCode.OK:
      return "OK";
    case SpanStatusCode.ERROR:
      return "ERROR";
    default:
      return "UNSET";
  }
}

/**
 * Resolve the Agent365 service endpoint base URI for a given cluster category.
 */
export function resolveAgent365Endpoint(clusterCategory: ClusterCategory): string {
  switch (clusterCategory) {
    case "prod":
      return "https://agent365.svc.cloud.microsoft";
    default:
      throw new Error(
        `Unsupported Agent365 cluster category "${clusterCategory}". ` +
          "Configure an explicit domain override or add a mapped endpoint for this cluster category.",
      );
  }
}

// ── Span truncation ─────────────────────────────────────────────────────────

/** Maximum allowed span size in bytes (250KB). */
export const MAX_SPAN_SIZE_BYTES = 250 * 1024;

const BLOB_SENTINEL = "[blob truncated]";
const JSON_SENTINEL = "[truncated]";
const TRUNCATED_SUFFIX = "… [truncated]";
const TRUNCATED_SUFFIX_BYTES = Buffer.byteLength(TRUNCATED_SUFFIX, "utf8");
const OVERLIMIT_SENTINEL = "[overlimit]";
const MIN_SHRINKABLE_STRING_BYTES = 50;

interface OTLPSpanLike {
  attributes: Record<string, unknown> | null;
}

interface ShrinkAction {
  contentBytes: number;
  apply(bytesToShed: number): void;
  sourceKey?: string;
}

function getSerializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Build a versioned message wrapper indicating original messages were dropped.
 */
function serializeOverflowSentinel(totalMessages: number): string {
  return JSON.stringify({
    version: A365_MESSAGE_SCHEMA_VERSION,
    messages: [
      {
        role: MESSAGE_ROLE_SYSTEM,
        parts: [
          {
            type: "text",
            content: `[truncated: ${totalMessages} ${totalMessages === 1 ? "message" : "messages"} exceeded limit]`,
          },
        ],
      },
    ],
  });
}

/**
 * Trim a string by a target UTF-8 byte budget while preserving whole code points.
 */
function trimString(value: string, bytesToShed: number): string {
  const currentBytes = Buffer.byteLength(value, "utf8");
  const targetContentBytes = Math.max(
    0,
    currentBytes - Math.max(1, bytesToShed) - TRUNCATED_SUFFIX_BYTES,
  );
  if (targetContentBytes <= 0) return TRUNCATED_SUFFIX;

  let consumedBytes = 0;
  let endIndex = 0;
  for (const codePoint of value) {
    const cpBytes = Buffer.byteLength(codePoint, "utf8");
    if (consumedBytes + cpBytes > targetContentBytes) break;
    consumedBytes += cpBytes;
    endIndex += codePoint.length;
  }

  return value.slice(0, endIndex) + TRUNCATED_SUFFIX;
}

function createBlobShrinkAction(
  part: Record<string, unknown>,
  sourceKey?: string,
): ShrinkAction | undefined {
  if (part.type === "blob" && typeof part.content === "string" && part.content !== BLOB_SENTINEL) {
    const contentSize = Buffer.byteLength(part.content, "utf8");
    if (contentSize <= 0) return undefined;
    const action: ShrinkAction = {
      contentBytes: contentSize,
      sourceKey,
      apply() {
        part.content = BLOB_SENTINEL;
        action.contentBytes = 0;
      },
    };
    return action;
  }
  return undefined;
}

/**
 * Collect all shrink candidates from message parts and direct string attributes.
 */
function collectShrinkActions(
  attributes: Record<string, unknown>,
  parsedMessages: Map<
    string,
    { version: string; messages: Array<{ parts: Array<Record<string, unknown>> }> }
  >,
): ShrinkAction[] {
  const actions: ShrinkAction[] = [];

  for (const key of Object.keys(attributes)) {
    let handledAsMessage = false;

    if (MESSAGE_ATTR_KEYS.has(key)) {
      if (!parsedMessages.has(key) && typeof attributes[key] === "string") {
        try {
          const parsed = JSON.parse(attributes[key] as string);
          if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
            parsedMessages.set(key, parsed);
          }
        } catch {
          // Not valid JSON — will fall through to string trim
        }
      }

      if (parsedMessages.has(key)) {
        handledAsMessage = true;
        const wrapper = parsedMessages.get(key)!;
        for (const message of wrapper.messages) {
          if (!Array.isArray(message.parts)) continue;
          for (const part of message.parts) {
            const partType = part.type as string;

            // Blob → sentinel
            const blobAction = createBlobShrinkAction(part, key);
            if (blobAction) {
              actions.push(blobAction);
            }

            // Tool/server JSON payload fields → sentinel
            const jsonField =
              partType === "tool_call"
                ? "arguments"
                : partType === "tool_call_response"
                  ? "response"
                  : partType === "server_tool_call"
                    ? "server_tool_call"
                    : partType === "server_tool_call_response"
                      ? "server_tool_call_response"
                      : undefined;

            if (jsonField && part[jsonField] !== undefined && part[jsonField] !== JSON_SENTINEL) {
              let fieldSize: number;
              try {
                fieldSize = Buffer.byteLength(JSON.stringify(part[jsonField]), "utf8");
              } catch {
                fieldSize = 0;
              }
              if (fieldSize > 0) {
                const action: ShrinkAction = {
                  contentBytes: fieldSize,
                  sourceKey: key,
                  apply() {
                    part[jsonField!] = JSON_SENTINEL;
                    action.contentBytes = 0;
                  },
                };
                actions.push(action);
              }
              continue;
            }

            // Text/reasoning → trim
            if (
              (partType === "text" || partType === "reasoning") &&
              typeof part.content === "string"
            ) {
              const contentSize = Buffer.byteLength(part.content, "utf8");
              if (contentSize > MIN_SHRINKABLE_STRING_BYTES) {
                const action: ShrinkAction = {
                  contentBytes: contentSize,
                  sourceKey: key,
                  apply(bytesToShed: number) {
                    const cur = Buffer.byteLength(part.content as string, "utf8");
                    if (cur > TRUNCATED_SUFFIX_BYTES) {
                      part.content = trimString(part.content as string, bytesToShed);
                      action.contentBytes = Buffer.byteLength(part.content as string, "utf8");
                    }
                  },
                };
                actions.push(action);
              }
            }
          }
        }
      }
    }

    // Non-message string attribute → trim
    if (!handledAsMessage && typeof attributes[key] === "string") {
      const value = attributes[key] as string;
      const valueSize = Buffer.byteLength(value, "utf8");
      if (valueSize > MIN_SHRINKABLE_STRING_BYTES) {
        const action: ShrinkAction = {
          contentBytes: valueSize,
          apply(bytesToShed: number) {
            const cur = Buffer.byteLength(attributes[key] as string, "utf8");
            if (cur > TRUNCATED_SUFFIX_BYTES) {
              attributes[key] = trimString(attributes[key] as string, bytesToShed);
              action.contentBytes = Buffer.byteLength(attributes[key] as string, "utf8");
            }
          },
        };
        actions.push(action);
      }
    }
  }

  return actions;
}

function flushParsedMessages(
  attributes: Record<string, unknown>,
  parsedMessages: Map<
    string,
    { version: string; messages: Array<{ parts: Array<Record<string, unknown>> }> }
  >,
): void {
  for (const [key, wrapper] of parsedMessages) {
    try {
      attributes[key] = JSON.stringify(wrapper);
    } catch {
      // Leave the previous value intact
    }
  }
}

function flushParsedMessage(
  attributes: Record<string, unknown>,
  parsedMessages: Map<
    string,
    { version: string; messages: Array<{ parts: Array<Record<string, unknown>> }> }
  >,
  key: string,
): void {
  const wrapper = parsedMessages.get(key);
  if (wrapper) {
    try {
      attributes[key] = JSON.stringify(wrapper);
    } catch {
      // Leave the previous value intact
    }
  }
}

function runShrinkPhase(
  span: OTLPSpanLike,
  attributes: Record<string, unknown>,
  parsedMessages: Map<
    string,
    { version: string; messages: Array<{ parts: Array<Record<string, unknown>> }> }
  >,
  currentSize: number,
): number {
  let nextSize = currentSize;
  const actions = collectShrinkActions(attributes, parsedMessages);

  while (actions.length > 0 && nextSize > MAX_SPAN_SIZE_BYTES) {
    let maxIdx = 0;
    for (let j = 1; j < actions.length; j++) {
      if (actions[j].contentBytes > actions[maxIdx].contentBytes) maxIdx = j;
    }

    const excess = nextSize - MAX_SPAN_SIZE_BYTES;
    const previousSize = nextSize;
    const action = actions[maxIdx];
    action.apply(excess);

    if (action.sourceKey) {
      flushParsedMessage(attributes, parsedMessages, action.sourceKey);
    }
    nextSize = getSerializedSize(span);

    if (nextSize >= previousSize) {
      actions.splice(maxIdx, 1);
    } else if (action.contentBytes <= MIN_SHRINKABLE_STRING_BYTES) {
      actions.splice(maxIdx, 1);
    }
  }

  flushParsedMessages(attributes, parsedMessages);
  return nextSize;
}

// ── Span size estimation and byte-level chunking ────────────────────────────

/** Overhead constant for OTLP JSON span fixed fields. @internal */
const SPAN_BASE_OVERHEAD = 2000;

/** Overhead per attribute in OTLP JSON format. @internal */
const ATTR_OVERHEAD = 80;

/** Overhead per event in OTLP JSON. @internal */
const EVENT_OVERHEAD = 200;

/**
 * Estimate the serialized byte size of a single attribute value in OTLP/HTTP JSON.
 */
export function estimateValueBytes(value: unknown): number {
  if (typeof value === "string") {
    return 40 + Buffer.byteLength(value, "utf8");
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 60;
    if (typeof value[0] === "string") {
      let sum = 60;
      for (const s of value) {
        sum += 40 + Buffer.byteLength(String(s), "utf8");
      }
      return sum;
    }
    return 60 + 50 * value.length;
  }
  return 40; // bool/int/float/null/other
}

/**
 * Heuristic estimator for the serialized size of an OTLP span in HTTP JSON.
 *
 * Uses generous constants tuned to over-estimate by ~25-50%, providing headroom
 * for JSON serializer variance.
 */
export function estimateSpanBytes(span: {
  name?: string;
  attributes?: Record<string, unknown> | null;
  events?: Array<{ name: string; attributes?: Record<string, unknown> | null }> | null;
}): number {
  let total = SPAN_BASE_OVERHEAD;

  if (span.name) {
    total += Buffer.byteLength(span.name, "utf8");
  }

  if (span.attributes) {
    for (const [key, value] of Object.entries(span.attributes)) {
      total += ATTR_OVERHEAD;
      total += Buffer.byteLength(key, "utf8");
      total += estimateValueBytes(value);
    }
  }

  if (span.events) {
    for (const ev of span.events) {
      total += EVENT_OVERHEAD;
      total += Buffer.byteLength(ev.name, "utf8");
      if (ev.attributes) {
        for (const [key, value] of Object.entries(ev.attributes)) {
          total += ATTR_OVERHEAD;
          total += Buffer.byteLength(key, "utf8");
          total += estimateValueBytes(value);
        }
      }
    }
  }

  return total;
}

/**
 * Split items into sub-batches whose cumulative estimated size stays under maxChunkBytes.
 *
 * Invariants:
 * - Input order is preserved across chunks.
 * - Empty input produces empty output.
 * - A single item whose size exceeds maxChunkBytes forms its own single-item chunk.
 * - No chunk is ever empty.
 */
export function chunkBySize<T>(
  items: T[],
  getSize: (item: T) => number,
  maxChunkBytes: number,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const itemBytes = getSize(item);
    if (current.length > 0 && currentBytes + itemBytes > maxChunkBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Truncate span attributes if the serialized span exceeds MAX_SPAN_SIZE_BYTES.
 *
 * Phase 1: iteratively shrink fields (blobs, text, json, strings) by size priority.
 * Phase 2 (fallback): replace remaining string attributes with overlimit sentinel.
 */
export function truncateSpan<T extends OTLPSpanLike>(spanDict: T): T {
  try {
    let currentSize = getSerializedSize(spanDict);
    if (currentSize <= MAX_SPAN_SIZE_BYTES) return spanDict;

    Logger.getInstance().warn(
      `[Agent365Exporter] Span size (${currentSize} bytes) exceeds limit (${MAX_SPAN_SIZE_BYTES} bytes). Shrinking.`,
    );

    const truncated = { ...spanDict };
    if (truncated.attributes) truncated.attributes = { ...truncated.attributes };
    const attributes = truncated.attributes;
    if (!attributes) return truncated;

    const parsedMessages = new Map<
      string,
      { version: string; messages: Array<{ parts: Array<Record<string, unknown>> }> }
    >();

    // Phase 1: iteratively shrink fields by size priority
    currentSize = runShrinkPhase(truncated, attributes, parsedMessages, currentSize);

    if (currentSize > MAX_SPAN_SIZE_BYTES) {
      // Phase 2: replace all string attributes with sentinels, largest first
      const stringKeys = Object.keys(attributes)
        .filter((k) => typeof attributes[k] === "string" && attributes[k] !== OVERLIMIT_SENTINEL)
        .sort(
          (a, b) =>
            Buffer.byteLength(attributes[b] as string, "utf8") -
            Buffer.byteLength(attributes[a] as string, "utf8"),
        );

      for (const key of stringKeys) {
        if (currentSize <= MAX_SPAN_SIZE_BYTES) break;
        if (MESSAGE_ATTR_KEYS.has(key)) {
          let messageCount = 0;
          const cached = parsedMessages.get(key);
          if (cached) {
            messageCount = cached.messages.length;
          } else if (typeof attributes[key] === "string") {
            try {
              const parsed = JSON.parse(attributes[key] as string);
              if (parsed && Array.isArray(parsed.messages)) {
                messageCount = parsed.messages.length;
              }
            } catch {
              /* not valid JSON */
            }
          }
          attributes[key] = serializeOverflowSentinel(messageCount);
          parsedMessages.delete(key);
        } else {
          attributes[key] = OVERLIMIT_SENTINEL;
        }
        currentSize = getSerializedSize(truncated);
      }
    }

    if (currentSize > MAX_SPAN_SIZE_BYTES) {
      Logger.getInstance().warn(
        `[Agent365Exporter] Span still ${currentSize} bytes after truncation (limit: ${MAX_SPAN_SIZE_BYTES}).`,
      );
    }

    return truncated;
  } catch (e) {
    Logger.getInstance().error(`[Agent365Exporter] Error during span truncation: ${e}`);
    return spanDict;
  }
}
