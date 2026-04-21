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
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_MICROSOFT_TENANT_ID,
} from "../../genai/semconv.js";
import { A365_MESSAGE_SCHEMA_VERSION } from "../contracts.js";

// Message attribute keys that receive special truncation handling
const MESSAGE_ATTR_KEYS: Set<string> = new Set([
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
]);

const MESSAGE_ROLE_SYSTEM = "system";

/**
 * Partition spans by (tenantId, agentId) identity pairs.
 * Spans missing either attribute are skipped.
 */
export function partitionByIdentity(spans: ReadableSpan[]): Map<string, ReadableSpan[]> {
  const groups = new Map<string, ReadableSpan[]>();
  let skippedCount = 0;

  for (const span of spans) {
    const attrs = span.attributes || {};
    const tenant = asStr(attrs[ATTR_MICROSOFT_TENANT_ID]);
    const agent = asStr(attrs[ATTR_GEN_AI_AGENT_ID]);

    if (!tenant || !agent) {
      skippedCount++;
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

  if (skippedCount > 0) {
    Logger.getInstance().info(
      `[${ExporterEventNames.EXPORT_PARTITION_SPAN_MISSING_IDENTITY}] ${skippedCount} spans skipped (missing tenant or agent ID)`,
    );
  }

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
