// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Per-request baggage builder for OpenTelemetry context propagation.
 *
 * Provides a fluent API for setting baggage values that will be propagated
 * in the OpenTelemetry context and stamped onto spans by the SpanProcessor.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability/src/tracing/middleware/BaggageBuilder.ts
 */

import { propagation, context as otelContext } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { OpenTelemetryConstants } from "../constants.js";

/**
 * Fluent builder for setting OpenTelemetry baggage values.
 *
 * @example
 * ```typescript
 * const scope = new BaggageBuilder()
 *   .tenantId("tenant-123")
 *   .agentId("agent-456")
 *   .build();
 *
 * scope.run(() => {
 *   // Baggage is active in this context
 * });
 * ```
 */
export class BaggageBuilder {
  private pairs: Map<string, string> = new Map();

  /** Set the operation source baggage value (e.g., ATG, ACF). */
  operationSource(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.SERVICE_NAME_KEY, value);
    return this;
  }

  /** Set the tenant ID baggage value. */
  tenantId(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.TENANT_ID_KEY, value);
    return this;
  }

  /** Set the agent ID baggage value. */
  agentId(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY, value);
    return this;
  }

  /** Set the agent AUID baggage value. */
  agentAuid(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_AGENT_AUID_KEY, value);
    return this;
  }

  /** Set the agent email baggage value. */
  agentEmail(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_AGENT_EMAIL_KEY, value);
    return this;
  }

  /** Set the agent blueprint ID baggage value. */
  agentBlueprintId(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_AGENT_BLUEPRINT_ID_KEY, value);
    return this;
  }

  /** Set the session ID baggage value. */
  sessionId(value: string): BaggageBuilder {
    this.set(OpenTelemetryConstants.SESSION_ID_KEY, value);
    return this;
  }

  /** Set the user ID baggage value. */
  userId(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.USER_ID_KEY, value);
    return this;
  }

  /** Set the agent name baggage value. */
  agentName(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_AGENT_NAME_KEY, value);
    return this;
  }

  /** Set the agent description baggage value. */
  agentDescription(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_AGENT_DESCRIPTION_KEY, value);
    return this;
  }

  /** Set the agent platform ID baggage value. */
  agentPlatformId(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_AGENT_PLATFORM_ID_KEY, value);
    return this;
  }

  /** Set the agent version baggage value. */
  agentVersion(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_AGENT_VERSION_KEY, value);
    return this;
  }

  /** Set the session description baggage value. */
  sessionDescription(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.SESSION_DESCRIPTION_KEY, value);
    return this;
  }

  /** Set the user name baggage value. */
  userName(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.USER_NAME_KEY, value);
    return this;
  }

  /** Set the user email baggage value. */
  userEmail(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.USER_EMAIL_KEY, value);
    return this;
  }

  /** Set the caller client IP baggage value. */
  callerClientIp(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_CALLER_CLIENT_IP_KEY, value);
    return this;
  }

  /** Set the caller agent platform ID baggage value. */
  callerAgentPlatformId(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_CALLER_AGENT_PLATFORM_ID_KEY, value);
    return this;
  }

  /** Set the conversation ID baggage value. */
  conversationId(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_CONVERSATION_ID_KEY, value);
    return this;
  }

  /** Set the conversation item link baggage value. */
  conversationItemLink(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.GEN_AI_CONVERSATION_ITEM_LINK_KEY, value);
    return this;
  }

  /** Set the channel name (e.g., Teams, Slack). */
  channelName(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.CHANNEL_NAME_KEY, value);
    return this;
  }

  /** Set the channel link/URL. */
  channelLink(value: string | null | undefined): BaggageBuilder {
    this.set(OpenTelemetryConstants.CHANNEL_LINK_KEY, value);
    return this;
  }

  /**
   * Sets the invoke agent server address and port baggage values.
   * @param address The server address (hostname) of the target agent service.
   * @param port Optional server port. Only recorded when different from 443.
   */
  invokeAgentServer(address: string | null | undefined, port?: number): BaggageBuilder {
    this.set(OpenTelemetryConstants.SERVER_ADDRESS_KEY, address);
    if (port !== undefined && port !== 443) {
      this.set(OpenTelemetryConstants.SERVER_PORT_KEY, port.toString());
    } else {
      this.pairs.delete(OpenTelemetryConstants.SERVER_PORT_KEY);
    }
    return this;
  }

  /**
   * Set multiple baggage pairs from a dictionary or iterable.
   * @param pairs Dictionary or iterable of key-value pairs
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setPairs(
    pairs: Record<string, any> | Iterable<[string, any]> | null | undefined,
  ): BaggageBuilder {
    if (!pairs) {
      return this;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let entries: Iterable<[string, any]>;
    if (Symbol.iterator in Object(pairs)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      entries = pairs as Iterable<[string, any]>;
    } else {
      entries = Object.entries(pairs);
    }

    for (const [key, value] of entries) {
      if (value !== null && value !== undefined) {
        this.set(key, String(value));
      }
    }

    return this;
  }

  /**
   * Apply the collected baggage to the current context.
   * @returns A BaggageScope that can run callbacks under the baggage context
   */
  build(): BaggageScope {
    return new BaggageScope(this.pairs);
  }

  /**
   * Add a baggage key/value if the value is not null or whitespace.
   */
  private set(key: string, value: string | null | undefined): void {
    if (value !== null && value !== undefined) {
      const trimmed = value.trim();
      if (trimmed) {
        this.pairs.set(key, trimmed);
      }
    }
  }

  /**
   * Convenience method to begin a request baggage scope with common fields.
   * @param tenantId The tenant ID
   * @param agentId The agent ID
   * @returns A BaggageScope with tenant and agent ID set
   */
  static setRequestContext(tenantId?: string | null, agentId?: string | null): BaggageScope {
    return new BaggageBuilder().tenantId(tenantId).agentId(agentId).build();
  }
}

/**
 * Context manager for baggage scope.
 *
 * Manages the lifecycle of baggage values, setting them in the OTel context
 * and restoring the previous context when the scope ends.
 */
export class BaggageScope {
  /** @internal Exposed for testing. */
  readonly contextWithBaggage: Context;

  constructor(pairs: Map<string, string>) {
    // 1. Start from current active context
    const currentCtx = otelContext.active();

    // 2. Build merged baggage
    let bag = propagation.getBaggage(currentCtx) ?? propagation.createBaggage({});
    for (const [key, value] of pairs.entries()) {
      if (value && value.trim()) {
        bag = bag.setEntry(key, { value });
      }
    }

    // 3. Create a new context that carries that baggage
    this.contextWithBaggage = propagation.setBaggage(currentCtx, bag);
  }

  /**
   * Execute a synchronous function under this baggage scope.
   * Automatically restores previous context afterward.
   */
  run<T>(fn: () => T): T {
    return otelContext.with(this.contextWithBaggage, fn);
  }

  /**
   * Dispose is a no-op because OpenTelemetry JS automatically restores
   * the previous context after `context.with()` completes.
   */
  [Symbol.dispose](): void {
    // Nothing to detach manually; context restoration happens automatically.
  }

  /** Manual cleanup alternative if caller isn't using `using`. */
  dispose(): void {
    this[Symbol.dispose]();
  }
}
