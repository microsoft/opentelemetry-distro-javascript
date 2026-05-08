import { diag, SpanKind, SpanStatusCode, HrTime } from '@opentelemetry/api';
import {
  SpanExporter,
  ReadableSpan,
  ExportResult,
  ExportResultCode,
} from '@opentelemetry/sdk-trace-base';

import { TokenResolver } from './auth';
import { A365_ATTR_TENANT_ID, A365_ATTR_AGENT_ID } from './baggage';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the A365 SpanExporter.
 */
export interface A365ExporterOptions {
  /**
   * Async function that returns a Bearer token for the given agent and tenant.
   * Return null to skip exporting spans for that group.
   */
  tokenResolver: TokenResolver;

  /**
   * Base URL of the A365 Observability Service.
   * Default: "https://agent365.svc.cloud.microsoft"
   */
  endpoint?: string;

  /**
   * HTTP request timeout in milliseconds.
   * Default: 30000
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = 'https://agent365.svc.cloud.microsoft';
const DEFAULT_TIMEOUT_MS = 30_000;
const NANOSECONDS_PER_SECOND = 1_000_000_000;

// ---------------------------------------------------------------------------
// OTLP JSON helpers
// ---------------------------------------------------------------------------

/** Convert an HrTime tuple [seconds, nanoseconds] to a nanosecond string. */
function hrTimeToNanos(hr: HrTime): string {
  const nanos = BigInt(hr[0]) * BigInt(NANOSECONDS_PER_SECOND) + BigInt(hr[1]);
  return nanos.toString();
}

/** Map SDK SpanKind enum to the OTLP integer value. */
function spanKindToOtlp(kind: SpanKind): number {
  switch (kind) {
    case SpanKind.INTERNAL:
      return 1;
    case SpanKind.SERVER:
      return 2;
    case SpanKind.CLIENT:
      return 3;
    case SpanKind.PRODUCER:
      return 4;
    case SpanKind.CONSUMER:
      return 5;
    default:
      return 0; // SPAN_KIND_UNSPECIFIED
  }
}

/** Map SDK SpanStatusCode to the OTLP status code integer. */
function statusCodeToOtlp(code: SpanStatusCode): number {
  switch (code) {
    case SpanStatusCode.OK:
      return 1;
    case SpanStatusCode.ERROR:
      return 2;
    default:
      return 0; // STATUS_CODE_UNSET
  }
}

/** Encode a single attribute value into OTLP JSON AnyValue shape. */
function encodeAttributeValue(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { intValue: value }
      : { doubleValue: value };
  }
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value
          .map((v) => encodeAttributeValue(v))
          .filter((v) => v !== undefined),
      },
    };
  }
  return undefined;
}

/** Convert a record of attributes to the OTLP KeyValue[] format. */
function encodeAttributes(
  attrs: Record<string, unknown> | undefined,
): Array<{ key: string; value: Record<string, unknown> }> {
  if (!attrs) {
    return [];
  }
  const result: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, raw] of Object.entries(attrs)) {
    const value = encodeAttributeValue(raw);
    if (value !== undefined) {
      result.push({ key, value });
    }
  }
  return result;
}

/** Convert a ReadableSpan to the OTLP JSON Span shape. */
function spanToOtlp(span: ReadableSpan): Record<string, unknown> {
  const otlpSpan: Record<string, unknown> = {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanId || '',
    name: span.name,
    kind: spanKindToOtlp(span.kind),
    startTimeUnixNano: hrTimeToNanos(span.startTime),
    endTimeUnixNano: hrTimeToNanos(span.endTime),
    attributes: encodeAttributes(
      span.attributes as Record<string, unknown> | undefined,
    ),
    status: {
      code: statusCodeToOtlp(span.status.code),
      message: span.status.message || '',
    },
    events: span.events.map((event) => ({
      timeUnixNano: hrTimeToNanos(event.time),
      name: event.name,
      attributes: encodeAttributes(
        event.attributes as Record<string, unknown> | undefined,
      ),
    })),
    links: span.links.map((link) => ({
      traceId: link.context.traceId,
      spanId: link.context.spanId,
      attributes: encodeAttributes(
        link.attributes as Record<string, unknown> | undefined,
      ),
    })),
  };

  return otlpSpan;
}

// ---------------------------------------------------------------------------
// Grouping key
// ---------------------------------------------------------------------------

interface SpanGroupKey {
  tenantId: string;
  agentId: string;
}

function groupKeyOf(span: ReadableSpan): SpanGroupKey | null {
  const attrs = span.attributes;
  const tenantId = attrs[A365_ATTR_TENANT_ID];
  const agentId = attrs[A365_ATTR_AGENT_ID];
  if (typeof tenantId !== 'string' || typeof agentId !== 'string') {
    return null;
  }
  return { tenantId, agentId };
}

function groupKeyString(key: SpanGroupKey): string {
  return `${key.tenantId}::${key.agentId}`;
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

/**
 * A365SpanExporter sends spans to the Agent 365 Observability Service.
 *
 * Spans are grouped by (tenant_id, agent_id) attributes and exported as
 * OTLP JSON to the per-agent trace ingestion endpoint.
 */
export class A365SpanExporter implements SpanExporter {
  private readonly tokenResolver: TokenResolver;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private isShutdown = false;

  constructor(options: A365ExporterOptions) {
    this.tokenResolver = options.tokenResolver;
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Export a batch of spans. Spans are grouped by (tenant_id, agent_id) and
   * each group is sent as a separate HTTP request.
   */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.isShutdown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('Exporter is shut down') });
      return;
    }

    this.exportAsync(spans)
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        diag.error('A365SpanExporter: export failed', error);
        resultCallback({ code: ExportResultCode.FAILED, error });
      });
  }

  /**
   * Attempt to flush any pending exports. This exporter sends spans
   * immediately in export(), so forceFlush is a no-op.
   */
  async forceFlush(): Promise<void> {
    // Spans are sent synchronously inside export(); nothing to flush.
  }

  /**
   * Shut down the exporter. After this call, export() will return FAILED.
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async exportAsync(spans: ReadableSpan[]): Promise<void> {
    // Group spans by (tenant_id, agent_id)
    const groups = new Map<string, { key: SpanGroupKey; spans: ReadableSpan[] }>();
    let skipped = 0;

    for (const span of spans) {
      const key = groupKeyOf(span);
      if (!key) {
        skipped++;
        continue;
      }
      const ks = groupKeyString(key);
      let group = groups.get(ks);
      if (!group) {
        group = { key, spans: [] };
        groups.set(ks, group);
      }
      group.spans.push(span);
    }

    if (skipped > 0) {
      diag.debug(
        `A365SpanExporter: skipped ${skipped} span(s) missing tenant_id or agent_id attributes`,
      );
    }

    if (groups.size === 0) {
      return;
    }

    // Export each group in parallel
    const results = await Promise.allSettled(
      Array.from(groups.values()).map((group) =>
        this.exportGroup(group.key, group.spans),
      ),
    );

    // Collect errors
    const errors: Error[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        const reason = result.reason;
        errors.push(reason instanceof Error ? reason : new Error(String(reason)));
      }
    }

    if (errors.length > 0) {
      const message = errors.map((e) => e.message).join('; ');
      throw new Error(`A365SpanExporter: ${errors.length} group(s) failed: ${message}`);
    }
  }

  private async exportGroup(
    key: SpanGroupKey,
    spans: ReadableSpan[],
  ): Promise<void> {
    // Resolve token
    const token = await this.tokenResolver(key.agentId, key.tenantId);
    if (token === null) {
      diag.debug(
        `A365SpanExporter: tokenResolver returned null for agent=${key.agentId} tenant=${key.tenantId}, skipping`,
      );
      return;
    }

    // Build OTLP JSON body
    const body = this.buildOtlpBody(spans);

    // Build URL
    const url =
      `${this.endpoint}/observabilityService/tenants/${encodeURIComponent(key.tenantId)}` +
      `/otlp/agents/${encodeURIComponent(key.agentId)}/traces`;

    // Send request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        throw new Error(
          `A365SpanExporter: HTTP ${response.status} from ${url}: ${responseText}`,
        );
      }

      diag.debug(
        `A365SpanExporter: exported ${spans.length} span(s) for agent=${key.agentId} tenant=${key.tenantId}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildOtlpBody(
    spans: ReadableSpan[],
  ): Record<string, unknown> {
    // Group spans by instrumentationLibrary (scope)
    const scopeMap = new Map<
      string,
      { name: string; version: string; spans: Record<string, unknown>[] }
    >();

    for (const span of spans) {
      const lib = span.instrumentationLibrary;
      const scopeKey = `${lib.name}::${lib.version ?? ''}`;

      let entry = scopeMap.get(scopeKey);
      if (!entry) {
        entry = {
          name: lib.name,
          version: lib.version ?? '',
          spans: [],
        };
        scopeMap.set(scopeKey, entry);
      }

      entry.spans.push(spanToOtlp(span));
    }

    // Build scopeSpans array
    const scopeSpans = Array.from(scopeMap.values()).map((entry) => ({
      scope: {
        name: entry.name,
        version: entry.version,
      },
      spans: entry.spans,
    }));

    // Build resource from the first span (all spans in a group share a resource)
    const firstSpan = spans[0];
    const resourceAttrs = firstSpan?.resource?.attributes
      ? encodeAttributes(firstSpan.resource.attributes as Record<string, unknown>)
      : [];

    return {
      resourceSpans: [
        {
          resource: {
            attributes: resourceAttrs,
          },
          scopeSpans,
        },
      ],
    };
  }
}
