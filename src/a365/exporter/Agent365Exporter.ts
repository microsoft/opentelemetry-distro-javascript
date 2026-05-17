// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

import type { Agent365ExporterOptions } from "./Agent365ExporterOptions.js";
import { ResolvedExporterOptions } from "./Agent365ExporterOptions.js";
import { ExporterEventNames } from "./ExporterEventNames.js";
import {
  partitionByIdentity,
  parseIdentityKey,
  hexTraceId,
  hexSpanId,
  kindName,
  statusName,
  resolveAgent365Endpoint,
  truncateSpan,
  estimateSpanBytes,
  chunkBySize,
} from "./utils.js";
import { getA365Logger } from "../logging.js";
import {
  THROTTLE_STATUS_CODES,
  isSdkStatsEnabled,
  recordDuration,
  recordException,
  recordFailure,
  recordRetry,
  recordSuccess,
  recordThrottle,
  shortHost,
} from "../../sdkstats/index.js";

const DEFAULT_MAX_RETRIES = 3;

// ── OTLP-like payload types ─────────────────────────────────────────────────

interface OTLPExportRequest {
  resourceSpans: ResourceSpan[];
}

interface ResourceSpan {
  resource: { attributes: Record<string, unknown> | null };
  scopeSpans: ScopeSpan[];
}

interface ScopeSpan {
  scope: { name: string; version?: string };
  spans: OTLPSpan[];
}

interface OTLPSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  attributes: Record<string, unknown> | null;
  events?: OTLPEvent[] | null;
  links?: OTLPLink[] | null;
  status: OTLPStatus;
}

interface OTLPEvent {
  timeUnixNano: number;
  name: string;
  attributes?: Record<string, unknown> | null;
}

interface OTLPLink {
  traceId: string;
  spanId: string;
  attributes?: Record<string, unknown> | null;
}

interface OTLPStatus {
  code: string;
  message?: string;
}

interface MappedSpan {
  span: OTLPSpan;
  scopeKey: string;
  scopeName: string;
  scopeVersion?: string;
}

/**
 * Agent365 span exporter.
 *
 * Implements `SpanExporter` from `@opentelemetry/sdk-trace-base`.
 * Partitions spans by (tenantId, agentId), builds OTLP-like JSON payloads,
 * and POSTs them to the Agent365 observability service with Bearer auth.
 */
export class Agent365Exporter implements SpanExporter {
  private closed = false;
  private readonly options: ResolvedExporterOptions;

  private get logger() {
    return getA365Logger();
  }

  constructor(options?: Agent365ExporterOptions) {
    this.options = new ResolvedExporterOptions(options);
  }

  async export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    if (this.closed) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    try {
      const exportStart = Date.now();
      this.logger.info(`[Agent365Exporter] Exporting ${spans.length} spans`);
      const groups = partitionByIdentity(spans);

      if (groups.size === 0) {
        this.logExporterEvent(
          ExporterEventNames.EXPORT,
          true,
          Date.now() - exportStart,
          "No eligible spans to export",
        );
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }

      let anyFailure = false;
      const promises: Promise<void>[] = [];

      for (const [identityKey, groupSpans] of groups) {
        const promise = this.exportGroup(identityKey, groupSpans).catch((err) => {
          anyFailure = true;
          this.logger.error(`[Agent365Exporter] Error exporting group ${identityKey}:`, err);
        });
        promises.push(promise);
      }

      await Promise.all(promises);
      this.logExporterEvent(
        ExporterEventNames.EXPORT,
        !anyFailure,
        Date.now() - exportStart,
        anyFailure ? "One or more export groups failed" : "All spans exported successfully",
      );
      resultCallback({
        code: anyFailure ? ExportResultCode.FAILED : ExportResultCode.SUCCESS,
      });
    } catch (err) {
      this.logger.error("[Agent365Exporter] Export failed:", err);
      this.logExporterEvent(
        ExporterEventNames.EXPORT,
        false,
        0,
        `Export failed with error: ${String(err)}`,
      );
      resultCallback({ code: ExportResultCode.FAILED });
    }
  }

  private async exportGroup(identityKey: string, spans: ReadableSpan[]): Promise<void> {
    const start = Date.now();
    const { tenantId, agentId } = parseIdentityKey(identityKey);

    // Map, truncate, and chunk spans by estimated byte size
    const mappedSpans = this.mapAndTruncateSpans(spans);
    const resourceAttrs = this.getResourceAttributes(spans);
    const chunks = chunkBySize(
      mappedSpans,
      (ms) => estimateSpanBytes(ms.span),
      this.options.maxPayloadBytes,
    );

    if (chunks.length > 1) {
      this.logger.info(
        `[Agent365Exporter] Split ${spans.length} spans into ${chunks.length} chunks for ${tenantId}/${agentId}`,
      );
    }

    const servicePrefix = this.options.useS2SEndpoint ? "/observabilityService" : "/observability";
    const endpointPath = `${servicePrefix}/tenants/${encodeURIComponent(tenantId)}/otlp/agents/${encodeURIComponent(agentId)}/traces`;

    const baseUrl =
      this.options.domainOverride ?? resolveAgent365Endpoint(this.options.clusterCategory);
    const url = `${baseUrl}${endpointPath}?api-version=1`;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-ms-tenant-id": tenantId,
    };

    // Resolve token
    const token = await this.resolveToken(agentId, tenantId);
    if (!token) {
      this.logger.warn(
        `[Agent365Exporter] Skipping export for ${tenantId}/${agentId}: no token available`,
      );
      this.logExporterEvent(
        ExporterEventNames.EXPORT_GROUP,
        false,
        Date.now() - start,
        "skip exporting: no token available",
        { tenantId, agentId },
      );
      return;
    }
    headers["authorization"] = `Bearer ${token}`;

    // Send each chunk (all-or-nothing: fail on first chunk failure)
    let lastCorrelationId = "unknown";
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const payload = this.buildEnvelope(chunk, resourceAttrs);
      const body = JSON.stringify(payload);

      this.logger.info(
        `[Agent365Exporter] Sending chunk ${i + 1} of ${chunks.length} (${chunk.length} spans)`,
      );

      const { ok, correlationId } = await this.postWithRetries(url, body, headers);
      lastCorrelationId = correlationId;

      if (!ok) {
        this.logExporterEvent(
          ExporterEventNames.EXPORT_GROUP,
          false,
          Date.now() - start,
          `chunk ${i + 1} of ${chunks.length} failed`,
          { tenantId, agentId, correlationId },
        );
        throw new Error(`Failed to export spans (chunk ${i + 1} of ${chunks.length})`);
      }
    }

    this.logExporterEvent(
      ExporterEventNames.EXPORT_GROUP,
      true,
      Date.now() - start,
      `${chunks.length} chunk(s) exported successfully`,
      { tenantId, agentId, correlationId: lastCorrelationId },
    );
  }

  private async resolveToken(agentId: string, tenantId: string): Promise<string | null> {
    if (!this.options.tokenResolver) return null;
    const result = this.options.tokenResolver(agentId, tenantId, this.options.authScopes);
    return result instanceof Promise ? result : result;
  }

  private async postWithRetries(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; correlationId: string }> {
    let lastCorrelationId = "unknown";

    // Resolve the short host (and the SDKStats kill-switch) once per call
    // so each retry attempt records under the same key without re-parsing
    // the URL or re-checking env on every iteration. `endpoint` is the
    // category label per spec — A365 transmits report endpoint="a365".
    const recordA365Stats = isSdkStatsEnabled();
    const endpointCategory = "a365";
    let host = url;
    if (recordA365Stats) {
      host = shortHost(url);
    }

    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      const startTime = Date.now();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.options.httpRequestTimeoutMilliseconds),
        });

        if (recordA365Stats) {
          recordDuration(endpointCategory, host, (Date.now() - startTime) / 1000);
        }

        const correlationId =
          response.headers.get("x-ms-correlation-id") ??
          response.headers.get("x-correlation-id") ??
          "unknown";
        lastCorrelationId = correlationId;

        if (response.status >= 200 && response.status < 300) {
          if (recordA365Stats) {
            recordSuccess(endpointCategory, host);
          }
          return { ok: true, correlationId };
        }

        // Retry on transient errors
        if (
          [408, 429].includes(response.status) ||
          (response.status >= 500 && response.status < 600)
        ) {
          if (recordA365Stats) {
            // 402 (throttle) is not in the retryable set, so it never
            // lands here — only true retries.
            recordRetry(endpointCategory, host, response.status);
          }
          if (attempt < DEFAULT_MAX_RETRIES) {
            const sleepMs = 200 * (attempt + 1) + Math.floor(Math.random() * 100);
            this.logger.warn(
              `[Agent365Exporter] Transient error ${response.status}, retrying after ${sleepMs}ms`,
            );
            await sleep(sleepMs);
            continue;
          }
          // Retries exhausted: also record a final failure so dashboards
          // see this as a terminal failure (not just a retry blip).
          if (recordA365Stats) {
            recordFailure(endpointCategory, host, response.status);
          }
        } else if (recordA365Stats) {
          if (THROTTLE_STATUS_CODES.has(response.status)) {
            recordThrottle(endpointCategory, host, response.status);
          } else {
            recordFailure(endpointCategory, host, response.status);
          }
        }

        this.logger.error(
          `[Agent365Exporter] Failed with status ${response.status}, correlation: ${correlationId}`,
        );
        return { ok: false, correlationId };
      } catch (error) {
        if (recordA365Stats) {
          recordDuration(endpointCategory, host, (Date.now() - startTime) / 1000);
          recordException(
            endpointCategory,
            host,
            error instanceof Error
              ? error.name || error.constructor.name || "Error"
              : typeof error,
          );
        }
        this.logger.error("[Agent365Exporter] Request error:", error);
        if (attempt < DEFAULT_MAX_RETRIES) {
          await sleep(200 * (attempt + 1));
          continue;
        }
        return { ok: false, correlationId: lastCorrelationId };
      }
    }

    return { ok: false, correlationId: lastCorrelationId };
  }

  private mapAndTruncateSpans(spans: ReadableSpan[]): MappedSpan[] {
    return spans.map((sp) => {
      const scope = sp.instrumentationScope;
      const scopeName = scope?.name ?? "unknown";
      const scopeVersion = scope?.version ?? "";
      return {
        span: truncateSpan(this.mapSpan(sp)),
        scopeKey: `${scopeName}:${scopeVersion}`,
        scopeName,
        scopeVersion: scopeVersion || undefined,
      };
    });
  }

  private getResourceAttributes(spans: ReadableSpan[]): Record<string, unknown> {
    if (spans.length > 0 && spans[0].resource?.attributes) {
      return { ...spans[0].resource.attributes };
    }
    return {};
  }

  private buildEnvelope(
    mappedSpans: MappedSpan[],
    resourceAttrs: Record<string, unknown>,
  ): OTLPExportRequest {
    const scopeMap = new Map<string, OTLPSpan[]>();

    for (const ms of mappedSpans) {
      const existing = scopeMap.get(ms.scopeKey) || [];
      existing.push(ms.span);
      scopeMap.set(ms.scopeKey, existing);
    }

    const scopeSpans: ScopeSpan[] = [];
    for (const [scopeKey, spans] of scopeMap) {
      const representative = mappedSpans.find((ms) => ms.scopeKey === scopeKey)!;
      scopeSpans.push({
        scope: {
          name: representative.scopeName,
          version: representative.scopeVersion,
        },
        spans,
      });
    }

    return {
      resourceSpans: [
        {
          resource: {
            attributes: Object.keys(resourceAttrs).length > 0 ? resourceAttrs : null,
          },
          scopeSpans,
        },
      ],
    };
  }

  private mapSpan(sp: ReadableSpan): OTLPSpan {
    const ctx = sp.spanContext();

    let parentSpanId: string | undefined;
    if (sp.parentSpanContext?.spanId && sp.parentSpanContext.spanId !== "0000000000000000") {
      parentSpanId = hexSpanId(sp.parentSpanContext.spanId);
    }

    const attrs = sp.attributes ? { ...sp.attributes } : {};

    const events: OTLPEvent[] = (sp.events ?? []).map((ev) => {
      const timeNs = Array.isArray(ev.time)
        ? ev.time[0] * 1_000_000_000 + ev.time[1]
        : (ev.time as number);
      const evAttrs =
        ev.attributes && Object.keys(ev.attributes).length > 0 ? { ...ev.attributes } : null;
      return { timeUnixNano: timeNs, name: ev.name, attributes: evAttrs };
    });

    const links: OTLPLink[] = (sp.links ?? []).map((ln) => {
      const lnAttrs =
        ln.attributes && Object.keys(ln.attributes).length > 0 ? { ...ln.attributes } : null;
      return {
        traceId: hexTraceId(ln.context.traceId),
        spanId: hexSpanId(ln.context.spanId),
        attributes: lnAttrs,
      };
    });

    const status: OTLPStatus = {
      code: statusName(sp.status?.code ?? 0),
      message: sp.status?.message || "",
    };

    const startTimeNs = Array.isArray(sp.startTime)
      ? sp.startTime[0] * 1_000_000_000 + sp.startTime[1]
      : (sp.startTime as number);
    const endTimeNs = Array.isArray(sp.endTime)
      ? sp.endTime[0] * 1_000_000_000 + sp.endTime[1]
      : (sp.endTime as number);

    return {
      traceId: hexTraceId(ctx.traceId),
      spanId: hexSpanId(ctx.spanId),
      parentSpanId,
      name: sp.name,
      kind: kindName(sp.kind),
      startTimeUnixNano: startTimeNs,
      endTimeUnixNano: endTimeNs,
      attributes: Object.keys(attrs).length > 0 ? attrs : null,
      events: events.length > 0 ? events : null,
      links: links.length > 0 ? links : null,
      status,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
  }

  async forceFlush(): Promise<void> {
    // No-op — spans are exported immediately on export() call
  }

  private logExporterEvent(
    eventType: ExporterEventNames,
    isSuccess: boolean,
    durationMs: number,
    message?: string,
    details?: Record<string, string>,
  ): void {
    const status = isSuccess ? "succeeded" : "failed";
    const messageInfo = message ? ` - ${message}` : "";
    const detailsInfo =
      details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
    const line = `[EVENT]: ${eventType} ${status} in ${durationMs}ms${messageInfo}${detailsInfo}`;

    if (isSuccess) {
      this.logger.info(line);
      return;
    }

    this.logger.error(line);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
