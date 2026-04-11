// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

import type { Agent365ExporterOptions } from "./Agent365ExporterOptions.js";
import { ResolvedExporterOptions } from "./Agent365ExporterOptions.js";
import {
  partitionByIdentity,
  parseIdentityKey,
  hexTraceId,
  hexSpanId,
  kindName,
  statusName,
  resolveAgent365Endpoint,
  truncateSpan,
} from "./utils.js";
import { Logger } from "../../shared/logging/index.js";

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
  private readonly logger = Logger.getInstance();

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
      this.logger.info(`[Agent365Exporter] Exporting ${spans.length} spans`);
      const groups = partitionByIdentity(spans);

      if (groups.size === 0) {
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
      resultCallback({
        code: anyFailure ? ExportResultCode.FAILED : ExportResultCode.SUCCESS,
      });
    } catch (err) {
      this.logger.error("[Agent365Exporter] Export failed:", err);
      resultCallback({ code: ExportResultCode.FAILED });
    }
  }

  private async exportGroup(identityKey: string, spans: ReadableSpan[]): Promise<void> {
    const { tenantId, agentId } = parseIdentityKey(identityKey);

    const payload = this.buildExportRequest(spans);
    const body = JSON.stringify(payload);

    const endpointPath = this.options.useS2SEndpoint
      ? `/observabilityService/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/traces`
      : `/observability/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/traces`;

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
      return;
    }
    headers["authorization"] = `Bearer ${token}`;

    const { ok } = await this.postWithRetries(url, body, headers);
    if (!ok) {
      throw new Error(`Failed to export spans for ${tenantId}/${agentId}`);
    }
  }

  private async resolveToken(agentId: string, tenantId: string): Promise<string | null> {
    if (!this.options.tokenResolver) return null;
    const result = this.options.tokenResolver(agentId, tenantId);
    return result instanceof Promise ? result : result;
  }

  private async postWithRetries(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; correlationId: string }> {
    let lastCorrelationId = "unknown";

    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.options.httpRequestTimeoutMilliseconds),
        });

        const correlationId =
          response.headers.get("x-ms-correlation-id") ??
          response.headers.get("x-correlation-id") ??
          "unknown";
        lastCorrelationId = correlationId;

        if (response.status >= 200 && response.status < 300) {
          return { ok: true, correlationId };
        }

        // Retry on transient errors
        if (
          [408, 429].includes(response.status) ||
          (response.status >= 500 && response.status < 600)
        ) {
          if (attempt < DEFAULT_MAX_RETRIES) {
            const sleepMs = 200 * (attempt + 1) + Math.floor(Math.random() * 100);
            this.logger.warn(
              `[Agent365Exporter] Transient error ${response.status}, retrying after ${sleepMs}ms`,
            );
            await sleep(sleepMs);
            continue;
          }
        }

        this.logger.error(
          `[Agent365Exporter] Failed with status ${response.status}, correlation: ${correlationId}`,
        );
        return { ok: false, correlationId };
      } catch (error) {
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

  private buildExportRequest(spans: ReadableSpan[]): OTLPExportRequest {
    const scopeMap = new Map<string, OTLPSpan[]>();

    for (const sp of spans) {
      const scope = sp.instrumentationScope;
      const scopeKey = `${scope?.name ?? "unknown"}:${scope?.version ?? ""}`;
      let existing = scopeMap.get(scopeKey);
      if (!existing) {
        existing = [];
        scopeMap.set(scopeKey, existing);
      }
      existing.push(truncateSpan(this.mapSpan(sp)));
    }

    const scopeSpans: ScopeSpan[] = [];
    for (const [scopeKey, mappedSpans] of scopeMap) {
      const [name, version] = scopeKey.split(":");
      scopeSpans.push({
        scope: { name, version: version || undefined },
        spans: mappedSpans,
      });
    }

    let resourceAttrs: Record<string, unknown> = {};
    if (spans.length > 0 && spans[0].resource?.attributes) {
      resourceAttrs = { ...spans[0].resource.attributes };
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
