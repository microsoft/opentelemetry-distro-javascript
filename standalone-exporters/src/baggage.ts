import {
  context,
  propagation,
  Baggage,
  BaggageEntry,
  Span,
  diag,
} from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Well-known attribute keys
// ---------------------------------------------------------------------------

/** Span attribute key for the Azure AD tenant ID. */
export const A365_ATTR_TENANT_ID = 'tenant_id';

/** Span attribute key for the agent ID. */
export const A365_ATTR_AGENT_ID = 'agent_id';

/** Span attribute key for the conversation ID. */
export const A365_ATTR_CONVERSATION_ID = 'conversation_id';

// ---------------------------------------------------------------------------
// Baggage key constants (used internally by the builder)
// ---------------------------------------------------------------------------

const BAGGAGE_KEY_TENANT_ID = 'a365.tenant_id';
const BAGGAGE_KEY_AGENT_ID = 'a365.agent_id';
const BAGGAGE_KEY_CONVERSATION_ID = 'a365.conversation_id';

// ---------------------------------------------------------------------------
// BaggageBuilder
// ---------------------------------------------------------------------------

/**
 * Result of BaggageBuilder.build(). Provides a `run` method that executes
 * a function within an OpenTelemetry context carrying the configured baggage.
 */
interface BaggageScope {
  /**
   * Execute `fn` with the baggage entries active in the current OTel context.
   * The baggage is only visible to code executing synchronously inside `fn`
   * (or in async continuations that preserve the context).
   */
  run<T>(fn: () => T): T;
}

/**
 * Fluent builder for A365-specific OpenTelemetry baggage entries.
 *
 * Example:
 * ```typescript
 * new BaggageBuilder()
 *   .tenantId('00000000-0000-0000-0000-000000000000')
 *   .agentId('my-agent-id')
 *   .conversationId('conv-123')
 *   .build()
 *   .run(() => {
 *     // spans created here will carry the baggage
 *   });
 * ```
 */
export class BaggageBuilder {
  private entries: Record<string, BaggageEntry> = {};

  /**
   * Set the Azure AD tenant ID baggage entry.
   */
  tenantId(value: string): this {
    this.entries[BAGGAGE_KEY_TENANT_ID] = { value };
    return this;
  }

  /**
   * Set the agent ID baggage entry.
   */
  agentId(value: string): this {
    this.entries[BAGGAGE_KEY_AGENT_ID] = { value };
    return this;
  }

  /**
   * Set the conversation ID baggage entry.
   */
  conversationId(value: string): this {
    this.entries[BAGGAGE_KEY_CONVERSATION_ID] = { value };
    return this;
  }

  /**
   * Build the baggage and return a scope runner.
   */
  build(): BaggageScope {
    const parentBaggage = propagation.getBaggage(context.active());
    let baggage: Baggage;

    if (parentBaggage) {
      // Merge into existing baggage
      baggage = parentBaggage;
      for (const [key, entry] of Object.entries(this.entries)) {
        baggage = baggage.setEntry(key, entry);
      }
    } else {
      baggage = propagation.createBaggage(this.entries);
    }

    const ctx = propagation.setBaggage(context.active(), baggage);

    return {
      run<T>(fn: () => T): T {
        return context.with(ctx, fn);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Direct attribute helpers
// ---------------------------------------------------------------------------

/**
 * Set the A365 tenant_id and agent_id attributes directly on a span.
 *
 * Use this when you want explicit control rather than relying on baggage
 * propagation. The A365SpanExporter reads these attributes to route spans
 * to the correct ingestion endpoint.
 *
 * @param span - The active span to annotate.
 * @param tenantId - Azure AD tenant ID (GUID string).
 * @param agentId - Agent ID.
 */
export function setA365SpanAttributes(
  span: Span,
  tenantId: string,
  agentId: string,
): void {
  if (!tenantId || !agentId) {
    diag.warn(
      'setA365SpanAttributes: tenantId and agentId are required; skipping',
    );
    return;
  }
  span.setAttribute(A365_ATTR_TENANT_ID, tenantId);
  span.setAttribute(A365_ATTR_AGENT_ID, agentId);
}
