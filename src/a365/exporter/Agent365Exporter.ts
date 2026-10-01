// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { BufferConfig, ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

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
import {
  createDurableRecord,
  DurableDeliveryManager,
  type DeliveryAttempt,
  type DurableRecordV1,
  parseRetryAfterMs,
  PersistentStore,
} from "./durable/index.js";
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
  private durableManager?: DurableDeliveryManager;
  private durableInitializationPromise?: Promise<void>;
  private durableInitializationError?: unknown;
  private durableInitializationFailed = false;
  private shutdownPromise?: Promise<void>;
  private shutdownFinalized = false;
  private readonly activeExports = new Set<Promise<void>>();

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
    if (this.options.durableDelivery.enabled) {
      void this.startDurableInitialization();
    }
  }

  /**
   * Returns the {@link BufferConfig} the host should pass to its
   * `BatchSpanProcessor`. Any value the caller supplied wins; anything
   * omitted falls back to the A365 exporter's documented defaults
   * (not the upstream `BatchSpanProcessor` defaults).
   */
  getBufferConfig(): BufferConfig {
    return {
      maxQueueSize: this.options.maxQueueSize,
      scheduledDelayMillis: this.options.scheduledDelayMilliseconds,
      maxExportBatchSize: this.options.maxExportBatchSize,
      exportTimeoutMillis: this.options.exporterTimeoutMilliseconds,
    };
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
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): Promise<void> {
    if (this.closed) {
      resultCallback({ code: ExportResultCode.FAILED });
      return Promise.resolve();
    }

    const operation = this.exportInternal(spans, resultCallback);
    const tracked = operation.finally(() => {
      this.activeExports.delete(tracked);
    });
    this.activeExports.add(tracked);
    return tracked;
  }

  private async exportInternal(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
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

    const durableManager = await this.getDurableManager();
    if (durableManager) {
      await this.exportDurableGroup(
        durableManager,
        tenantId,
        agentId,
        spans,
        chunks,
        resourceAttrs,
        start,
      );
      return;
    }

    await this.exportNetworkGroup(tenantId, agentId, spans, chunks, resourceAttrs, start);
  }

  private async exportNetworkGroup(
    tenantId: string,
    agentId: string,
    spans: ReadableSpan[],
    chunks: MappedSpan[][],
    resourceAttrs: Record<string, unknown>,
    start: number,
  ): Promise<void> {
    const url = this.buildExportUrl({
      tenantId,
      agentId,
      useS2SEndpoint: this.options.useS2SEndpoint,
    });

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
    this.warnIfSendingBearerTokenToNonHttpsEndpoint(url);
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

  private async exportDurableGroup(
    manager: DurableDeliveryManager,
    tenantId: string,
    agentId: string,
    spans: ReadableSpan[],
    chunks: MappedSpan[][],
    resourceAttrs: Record<string, unknown>,
    start: number,
  ): Promise<void> {
    const agenticUserId = this.getAgenticUserId(spans);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const body = JSON.stringify(this.buildEnvelope(chunk, resourceAttrs));
      const record = createDurableRecord({
        tenantId,
        agentId,
        agenticUserId,
        useS2SEndpoint: this.options.useS2SEndpoint,
        body,
      });

      this.logger.info(
        `[Agent365Exporter] Delivering durable chunk ${i + 1} of ${chunks.length} (${chunk.length} spans)`,
      );

      if (await manager.deliver(record)) {
        continue;
      }

      this.logExporterEvent(
        ExporterEventNames.EXPORT_GROUP,
        false,
        Date.now() - start,
        `durable chunk ${i + 1} of ${chunks.length} failed`,
        { tenantId, agentId, correlationId: "durable" },
      );
      throw new Error(`Failed to durably export spans (chunk ${i + 1} of ${chunks.length})`);
    }

    this.logExporterEvent(
      ExporterEventNames.EXPORT_GROUP,
      true,
      Date.now() - start,
      `${chunks.length} chunk(s) delivered or persisted durably`,
      { tenantId, agentId, correlationId: "durable" },
    );
  }

  private async resolveToken(
    agentId: string,
    tenantId: string,
    spans: ReadableSpan[],
  ): Promise<string | null> {
    return this.resolveTokenForIdentity(agentId, tenantId, this.getAgenticUserId(spans));
  }

  private async resolveRecordToken(record: {
    agentId: string;
    tenantId: string;
    agenticUserId?: string;
  }): Promise<string | null> {
    return this.resolveTokenForIdentity(record.agentId, record.tenantId, record.agenticUserId);
  }

  private async resolveTokenForIdentity(
    agentId: string,
    tenantId: string,
    agenticUserId?: string,
  ): Promise<string | null> {
    if (this.options.contextualTokenResolver) {
      const identity: AgentIdentity = { agentId, agenticUserId };
      const context: TokenResolverContext = { identity, tenantId };
      const result = this.options.contextualTokenResolver(context);
      return (result instanceof Promise ? await result : result) ?? null;
    }

    if (!this.options.tokenResolver) return null;
    const result = this.options.tokenResolver(agentId, tenantId, this.options.authScopes);
    return result instanceof Promise ? result : result;
  }

  private buildExportUrl(endpoint: Agent365Endpoint): string {
    return buildAgent365Url(endpoint, this.options);
  }

  private buildReplayUrl(record: DurableRecordV1): string {
    return this.buildExportUrl({
      tenantId: record.tenantId,
      agentId: record.agentId,
      useS2SEndpoint: record.useS2SEndpoint,
    });
  }

  private warnIfSendingBearerTokenToNonHttpsEndpoint(url: string): void {
    if (endpointBearerTokenViolation(url) !== "non-https") {
      return;
    }

    this.logger.warn(
      `[Agent365Exporter] Live export endpoint must use HTTPS before sending a bearer token: ${url}`,
    );
  }

  private validateReplayRecord(record: DurableRecordV1): void {
    const error = createReplayEndpointError(this.buildReplayUrl(record));
    if (error) {
      throw error;
    }
  }

  private getAgenticUserId(spans: ReadableSpan[]): string | undefined {
    return spans.length > 0
      ? asStr(spans[0].attributes?.[OpenTelemetryConstants.GEN_AI_AGENT_AUID_KEY])
      : undefined;
  }

  private async getDurableManager(): Promise<DurableDeliveryManager | undefined> {
    if (this.closed) {
      throw new Error("Agent365 durable delivery has shut down");
    }

    if (!this.options.durableDelivery.enabled) {
      return undefined;
    }

    await this.startDurableInitialization();
    if (this.durableManager) {
      return this.durableManager;
    }

    if (this.durableInitializationFailed) {
      return undefined;
    }

    throw new Error("Agent365 durable delivery initialization did not create a manager");
  }

  private startDurableInitialization(): Promise<void> {
    if (!this.options.durableDelivery.enabled) {
      return Promise.resolve();
    }

    this.durableInitializationPromise ??= PersistentStore.create(
      this.options.durableDelivery,
      this.logger,
    )
      .then((store) => {
        const manager = new DurableDeliveryManager(
          this.options.durableDelivery,
          store,
          this.logger,
          {
            validateReplay: (record) => this.validateReplayRecord(record),
            resolveToken: (record) => this.resolveRecordToken(record),
            send: (record, token, signal) => this.postRecordOnce(record, token, signal),
          },
        );
        this.durableManager = manager;

        if (this.closed) {
          manager.beginShutdown();
          if (this.shutdownFinalized) {
            this.closeLateDurableManager(manager);
          }
          return;
        }

        manager.startReplay();
      })
      .catch((error) => {
        this.durableInitializationFailed = true;
        this.durableInitializationError = error;
        this.logger.error("[Agent365Exporter] Durable delivery initialization failed:", error);
      });

    return this.durableInitializationPromise;
  }

  private async postRecordOnce(
    record: DurableRecordV1,
    token: string,
    signal: AbortSignal,
  ): Promise<DeliveryAttempt> {
    const url = this.buildReplayUrl(record);
    const stats = createRequestStats(url);
    const requestStart = Date.now();
    let correlationId = "unknown";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-ms-tenant-id": record.tenantId,
    };

    try {
      this.warnIfSendingBearerTokenToNonHttpsEndpoint(url);
      headers["authorization"] = `Bearer ${token}`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: record.body,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.options.httpRequestTimeoutMilliseconds),
        ]),
      });
      correlationId =
        response.headers.get("x-ms-correlation-id") ??
        response.headers.get("x-correlation-id") ??
        "unknown";

      recordResponseStats(stats, response.status, requestStart);

      if (response.status >= 200 && response.status < 300) {
        return { kind: "success", correlationId };
      }
      if (
        [401, 408, 429].includes(response.status) ||
        (response.status >= 500 && response.status < 600)
      ) {
        return {
          kind: "retryable",
          correlationId,
          status: response.status,
          retryAfterMs: parseRetryAfterMs(response.headers) ?? undefined,
        };
      }
      return {
        kind: "permanent",
        correlationId,
        status: response.status,
        reason: `HTTP ${response.status}`,
      };
    } catch (error) {
      recordExceptionStats(stats, error, requestStart);
      this.logger.error("[Agent365Exporter] Request error:", error);
      return { kind: "retryable", correlationId };
    }
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
    const stats = createRequestStats(url);

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

        recordResponseStats(stats, response.status, requestStart);

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
        recordExceptionStats(stats, error, requestStart);
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
   * calls fail immediately. Accepted exports settle before shutdown completes
   * when they finish before the configured shutdown deadline; durable delivery
   * requests are aborted at that deadline.
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.closed = true;
      this.durableManager?.beginShutdown();
      this.shutdownPromise = this.shutdownInternal();
    }
    return this.shutdownPromise;
  }

  /**
   * Waits for accepted exports and drains pending durable records when durable
   * delivery is enabled.
   */
  async forceFlush(): Promise<void> {
    await this.waitForActiveExports();
    if (this.closed || !this.options.durableDelivery.enabled) {
      return;
    }

    await this.startDurableInitialization();
    if (this.durableInitializationFailed || !this.durableManager) {
      return;
    }

    await this.durableManager.forceFlush();
  }

  private async shutdownInternal(): Promise<void> {
    const deadline = Date.now() + this.options.durableDelivery.shutdownTimeoutMilliseconds;

    try {
      await this.waitForActiveExports(deadline, "waiting for accepted exports to settle");

      if (!this.options.durableDelivery.enabled) {
        return;
      }

      await this.waitForWithinShutdownDeadline(
        this.startDurableInitialization(),
        deadline,
        "starting durable delivery",
      );
      this.durableManager?.beginShutdown();
      if (this.durableManager) {
        await this.waitForWithinShutdownDeadline(
          this.durableManager.shutdown(),
          deadline,
          "waiting for durable delivery manager shutdown",
        );
      }
    } finally {
      this.shutdownFinalized = true;
      if (this.durableManager) {
        this.closeLateDurableManager(this.durableManager);
      }
    }
  }

  private async waitForActiveExports(
    deadline = Number.POSITIVE_INFINITY,
    operationName = "waiting for accepted exports to settle",
  ): Promise<void> {
    while (this.activeExports.size > 0) {
      if (deadline === Number.POSITIVE_INFINITY) {
        await Promise.allSettled([...this.activeExports]);
        continue;
      }

      await this.waitForWithinShutdownDeadline(
        Promise.allSettled([...this.activeExports]).then(() => undefined),
        deadline,
        operationName,
      );
    }
  }

  private async waitForWithinShutdownDeadline<T>(
    operation: Promise<T>,
    deadline: number,
    operationName: string,
  ): Promise<T> {
    const timeoutMessage = `Agent365 exporter shutdown timed out while ${operationName}`;
    const remainingMilliseconds = deadline - Date.now();
    if (remainingMilliseconds <= 0) {
      throw new Error(timeoutMessage);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(timeoutMessage)), remainingMilliseconds);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private closeLateDurableManager(manager: DurableDeliveryManager): void {
    void manager.shutdown().catch((error) => {
      this.logger.error("[Agent365Exporter] Durable delivery shutdown failed:", error);
    });
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

type Agent365Endpoint = Pick<DurableRecordV1, "tenantId" | "agentId" | "useS2SEndpoint">;
type Agent365Routing = Pick<ResolvedExporterOptions, "clusterCategory" | "domainOverride">;

interface RequestStats {
  host: string;
}

function buildAgent365Url(endpoint: Agent365Endpoint, routing: Agent365Routing): string {
  const servicePrefix = endpoint.useS2SEndpoint ? "/observabilityService" : "/observability";
  const endpointPath = `${servicePrefix}/tenants/${encodeURIComponent(endpoint.tenantId)}/otlp/agents/${encodeURIComponent(endpoint.agentId)}/traces`;
  const baseUrl = routing.domainOverride ?? resolveAgent365Endpoint(routing.clusterCategory);
  return `${baseUrl}${endpointPath}?api-version=1`;
}

function createReplayEndpointError(url: string): Error | undefined {
  const violation = endpointBearerTokenViolation(url);
  if (!violation) {
    return undefined;
  }

  if (violation === "malformed") {
    return createEndpointValidationError(
      "ReplayEndpointError",
      `Replay endpoint is invalid or malformed before resolving a bearer token: ${url}`,
    );
  }

  return createEndpointValidationError(
    "ReplayEndpointError",
    `Replay endpoint must use HTTPS before resolving a bearer token: ${url}`,
  );
}

function endpointBearerTokenViolation(url: string): "malformed" | "non-https" | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "malformed";
  }

  return parsed.protocol === "https:" ? undefined : "non-https";
}

function createEndpointValidationError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function createRequestStats(url: string): RequestStats | undefined {
  return isSdkStatsEnabled() ? { host: shortHost(url) } : undefined;
}

function recordResponseStats(
  stats: RequestStats | undefined,
  statusCode: number,
  requestStart: number,
): void {
  if (!stats) {
    return;
  }

  recordDuration(A365_ENDPOINT_CATEGORY, stats.host, Date.now() - requestStart);
  switch (classifyStatusCode(statusCode)) {
    case "success":
      recordSuccess(A365_ENDPOINT_CATEGORY, stats.host);
      break;
    case "retry":
      recordRetry(A365_ENDPOINT_CATEGORY, stats.host, statusCode);
      break;
    case "throttle":
      recordThrottle(A365_ENDPOINT_CATEGORY, stats.host, statusCode);
      break;
    case "failure":
      recordFailure(A365_ENDPOINT_CATEGORY, stats.host, statusCode);
      break;
    case "ignored":
      break;
  }
}

function recordExceptionStats(
  stats: RequestStats | undefined,
  error: unknown,
  requestStart: number,
): void {
  if (!stats) {
    return;
  }

  recordDuration(A365_ENDPOINT_CATEGORY, stats.host, Date.now() - requestStart);
  recordException(A365_ENDPOINT_CATEGORY, stats.host, classifyExceptionType(error));
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
