// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

import type { Agent365ExporterOptions } from "./Agent365ExporterOptions.js";
import { ResolvedExporterOptions } from "./Agent365ExporterOptions.js";
import type { TokenResolverContext } from "./TokenResolverContext.js";
import type { AgentIdentity } from "./AgentIdentity.js";
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
  asStr,
} from "./utils.js";
import { getA365Logger } from "../logging.js";
import { OpenTelemetryConstants } from "../constants.js";
import {
  isSdkStatsEnabled,
  recordSuccess,
  recordFailure,
  recordRetry,
  recordThrottle,
  recordException,
  recordDuration,
  classifyStatusCode,
  shortHost,
} from "../../sdkstats/index.js";
import {
  A365_ENDPOINT_CATEGORY,
  EXC_TIMEOUT,
  EXC_NETWORK,
  EXC_CLIENT,
} from "../../sdkstats/constants.js";

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

  /**
   * Creates a new Agent365 span exporter.
   *
   * @param options Optional exporter configuration (token resolution, endpoint
   * overrides, batching, and payload limits). When omitted, defaults are applied.
   */
  constructor(options?: Agent365ExporterOptions) {
    this.options = new ResolvedExporterOptions(options);
  }

  /**
   * Exports a batch of spans to the Agent365 observability service.
   *
   * Partitions the spans by (tenantId, agentId), builds OTLP-like JSON payloads,
   * and POSTs them with bearer authentication. Invokes `resultCallback` with
   * `ExportResultCode.SUCCESS` when all groups export successfully, or
   * `ExportResultCode.FAILED` when the exporter is shut down or any group fails.
   *
   * @param spans The spans to export.
   * @param resultCallback Callback invoked with the export result.
   */
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
    const token = await this.resolveToken(agentId, tenantId, spans);
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

  private async resolveToken(
    agentId: string,
    tenantId: string,
    spans: ReadableSpan[],
  ): Promise<string | null> {
    // Prefer ContextualTokenResolver when set; extract agentic user ID from the
    // first span in the group (1:1 relationship between agent and agentic user).
    if (this.options.contextualTokenResolver) {
      const agenticUserId =
        spans.length > 0
          ? asStr(spans[0].attributes?.[OpenTelemetryConstants.GEN_AI_AGENT_AUID_KEY])
          : undefined;
      const identity: AgentIdentity = { agentId, agenticUserId };
      const context: TokenResolverContext = { identity, tenantId };
      const result = this.options.contextualTokenResolver(context);
      return (result instanceof Promise ? await result : result) ?? null;
    }

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
    const endpointCategory = A365_ENDPOINT_CATEGORY;
    let host = url;
    if (recordA365Stats) {
      host = shortHost(url);
    }

    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      const requestStart = Date.now();
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

        if (recordA365Stats) {
          recordDuration(endpointCategory, host, Date.now() - requestStart);
          const kind = classifyStatusCode(response.status);
          switch (kind) {
            case "success":
              recordSuccess(endpointCategory, host);
              break;
            case "retry":
              recordRetry(endpointCategory, host, response.status);
              break;
            case "throttle":
              recordThrottle(endpointCategory, host, response.status);
              break;
            case "failure":
              recordFailure(endpointCategory, host, response.status);
              break;
            case "ignored":
              break;
          }
        }

        if (response.status >= 200 && response.status < 300) {
          return { ok: true, correlationId };
        }

        // Retry on transient errors
        if (
          [408, 429].includes(response.status) ||
          (response.status >= 500 && response.status < 600)
        ) {
          if (attempt < DEFAULT_MAX_RETRIES) {
            const defaultBackoffMs = 200 * (attempt + 1) + Math.floor(Math.random() * 100);
            const retryAfterMs = parseRetryAfterMs(response.headers);
            const sleepMs =
              retryAfterMs !== null ? Math.max(retryAfterMs, defaultBackoffMs) : defaultBackoffMs;
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
        if (recordA365Stats) {
          recordDuration(endpointCategory, host, Date.now() - requestStart);
          recordException(endpointCategory, host, classifyExceptionType(error));
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

  /**
   * Shuts down the exporter. After this resolves, subsequent {@link export}
   * calls fail immediately. Any in-flight exports are not awaited.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
  }

  /**
   * Flushes any pending spans. This is a no-op because spans are exported
   * immediately on each {@link export} call rather than being buffered.
   */
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

/**
 * Classify a thrown fetch error into a stable SDKStats `exceptionType`
 * label so the dimension cardinality stays bounded. Mirrors the buckets
 * the AzMon exporter's statsbeat uses (`ExceptionType` enum in
 * `@azure/monitor-opentelemetry-exporter`).
 */
function classifyExceptionType(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name;
    if (name === "AbortError" || name === "TimeoutError") return EXC_TIMEOUT;
    if (name === "TypeError") return EXC_NETWORK;
    return name || EXC_CLIENT;
  }
  return EXC_CLIENT;
}

/**
 * Parse the Retry-After header value into milliseconds.
 * Supports both delay-seconds (e.g. "120") and HTTP-date formats (RFC 7231 §7.1.3).
 * Returns null if the header is absent or unparseable.
 */
function parseRetryAfterMs(headers: Pick<Headers, "get">): number | null {
  // fetch Headers.get() is case-insensitive, but Map.get() (used in tests) is not.
  const value = headers.get("retry-after") ?? headers.get("Retry-After");
  if (value == null) return null;

  const trimmed = value.trim();

  // Try numeric (delay-seconds)
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return seconds * 1000;
  }

  // Try HTTP-date
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    const delayMs = dateMs - Date.now();
    return delayMs > 0 ? delayMs : 0;
  }

  return null;
}
