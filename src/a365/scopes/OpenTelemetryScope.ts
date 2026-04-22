// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Base class for OpenTelemetry tracing scopes.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability/src/tracing/scopes/OpenTelemetryScope.ts
 */

import type { Span, SpanContext, AttributeValue, TimeInput } from "@opentelemetry/api";
import { trace, SpanKind, SpanStatusCode, context } from "@opentelemetry/api";
import { OpenTelemetryConstants } from "../constants.js";
import type {
  AgentDetails,
  UserDetails,
  SpanDetails,
  InputMessagesParam,
  OutputMessagesParam,
} from "../contracts.js";
import { createContextWithParentSpanRef, isParentSpanRef } from "../context.js";
import {
  normalizeInputMessages,
  normalizeOutputMessages,
  serializeMessages,
} from "../message-utils.js";
import { Logger } from "../../shared/logging/index.js";

/**
 * Base class for OpenTelemetry tracing scopes.
 *
 * Subclasses: `InvokeAgentScope`, `ExecuteToolScope`, `InferenceScope`, `OutputScope`.
 */
export abstract class OpenTelemetryScope {
  /**
   * Returns a tracer from the current global TracerProvider.
   *
   * This **must not** be stored in a static field because the distro's
   * `useMicrosoftOpenTelemetry()` resets the global API state
   * (`trace.disable()` + global-object deletion) before starting the
   * NodeSDK. A static field would capture a `ProxyTracer` bound to the
   * old `ProxyTracerProvider` whose delegate is never set, producing
   * `NoopSpan` instances with zeroed trace/span IDs.
   */
  private static getTracer() {
    return trace.getTracer(OpenTelemetryConstants.SOURCE_NAME);
  }

  protected readonly span: Span;
  private readonly wallClockStartMs: number;
  private customStartTime?: TimeInput;
  private customEndTime?: TimeInput;
  private errorType?: string;
  private hasEnded = false;
  private readonly logger = Logger.getInstance();

  /**
   * @param operationName The name of the operation being traced.
   * @param spanName The display name of the span.
   * @param agentDetails Optional agent details. Tenant ID is read from `agentDetails.tenantId`.
   * @param spanDetails Optional span configuration including parent context, start/end times, span kind, and span links.
   * @param userDetails Optional human caller identity details.
   */
  protected constructor(
    operationName: string,
    spanName: string,
    agentDetails?: AgentDetails,
    spanDetails?: SpanDetails,
    userDetails?: UserDetails,
  ) {
    const parentContext = spanDetails?.parentContext;
    const startTime = spanDetails?.startTime;
    const endTime = spanDetails?.endTime;
    const spanLinks = spanDetails?.spanLinks;
    const kind = spanDetails?.spanKind ?? SpanKind.CLIENT;

    let currentContext = context.active();
    if (parentContext) {
      if (isParentSpanRef(parentContext)) {
        currentContext = createContextWithParentSpanRef(currentContext, parentContext);
      } else {
        currentContext = parentContext;
      }
    }

    this.span = OpenTelemetryScope.getTracer().startSpan(
      spanName,
      {
        kind,
        startTime,
        links: spanLinks,
        attributes: {
          [OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY]: operationName,
        },
      },
      currentContext,
    );

    this.wallClockStartMs = Date.now();
    if (startTime !== undefined) {
      this.customStartTime = startTime;
    }
    this.customEndTime = endTime;

    // Set agent details
    if (agentDetails) {
      this.setTagMaybe(OpenTelemetryConstants.GEN_AI_AGENT_ID_KEY, agentDetails.agentId);
      this.setTagMaybe(OpenTelemetryConstants.GEN_AI_AGENT_NAME_KEY, agentDetails.agentName);
      this.setTagMaybe(
        OpenTelemetryConstants.GEN_AI_AGENT_DESCRIPTION_KEY,
        agentDetails.agentDescription,
      );
      this.setTagMaybe(
        OpenTelemetryConstants.GEN_AI_AGENT_PLATFORM_ID_KEY,
        agentDetails.platformId,
      );
      this.setTagMaybe(OpenTelemetryConstants.GEN_AI_ICON_URI_KEY, agentDetails.iconUri);
      this.setTagMaybe(OpenTelemetryConstants.GEN_AI_AGENT_AUID_KEY, agentDetails.agentAUID);
      this.setTagMaybe(OpenTelemetryConstants.GEN_AI_AGENT_EMAIL_KEY, agentDetails.agentEmail);
      this.setTagMaybe(
        OpenTelemetryConstants.GEN_AI_AGENT_BLUEPRINT_ID_KEY,
        agentDetails.agentBlueprintId,
      );
      this.setTagMaybe(OpenTelemetryConstants.GEN_AI_AGENT_VERSION_KEY, agentDetails.agentVersion);
    }

    // Set tenant ID
    this.setTagMaybe(OpenTelemetryConstants.TENANT_ID_KEY, agentDetails?.tenantId);

    // Set caller details
    if (userDetails) {
      this.setTagMaybe(OpenTelemetryConstants.USER_ID_KEY, userDetails.userId);
      this.setTagMaybe(OpenTelemetryConstants.USER_EMAIL_KEY, userDetails.userEmail);
      this.setTagMaybe(OpenTelemetryConstants.USER_NAME_KEY, userDetails.userName);
      this.setTagMaybe(
        OpenTelemetryConstants.GEN_AI_CALLER_CLIENT_IP_KEY,
        userDetails.callerClientIp,
      );
    }
  }

  /** Makes this span active for the duration of the async callback execution. */
  public withActiveSpanAsync<T>(callback: () => Promise<T>): Promise<T> {
    const newContext = trace.setSpan(context.active(), this.span);
    return context.with(newContext, callback);
  }

  /** Gets the span context for this scope. */
  public getSpanContext(): SpanContext {
    return this.span.spanContext();
  }

  /** Records an error that occurred during the operation. */
  public recordError(error: Error): void {
    if ("status" in error && typeof (error as Record<string, unknown>).status === "number") {
      this.errorType = String((error as Record<string, unknown>).status);
    } else {
      this.errorType = error.constructor.name;
    }

    this.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
    this.span.recordException(error);
  }

  /** Records multiple attribute key/value pairs. */
  public recordAttributes(
    attributes:
      | Iterable<[string, AttributeValue]>
      | Record<string, AttributeValue>
      | null
      | undefined,
  ): void {
    if (!attributes) return;

    if (Symbol.iterator in Object(attributes) && typeof attributes !== "string") {
      for (const [key, value] of attributes as Iterable<[string, AttributeValue]>) {
        if (key && typeof key === "string" && key.trim()) {
          this.span.setAttribute(key, value);
        }
      }
    } else if (typeof attributes === "object") {
      for (const key of Object.keys(attributes as Record<string, AttributeValue>)) {
        if (key && key.trim()) {
          this.span.setAttribute(key, (attributes as Record<string, AttributeValue>)[key]);
        }
      }
    }
  }

  /** Records the input messages for telemetry tracking. */
  protected recordInputMessages(messages: InputMessagesParam): void {
    const wrapper = normalizeInputMessages(messages);
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_INPUT_MESSAGES_KEY, serializeMessages(wrapper));
  }

  /** Records the output messages for telemetry tracking. */
  protected recordOutputMessages(messages: OutputMessagesParam): void {
    const wrapper = normalizeOutputMessages(messages);
    this.setTagMaybe(OpenTelemetryConstants.GEN_AI_OUTPUT_MESSAGES_KEY, serializeMessages(wrapper));
  }

  /** Sets a tag on the span if the value is not null or undefined. */
  protected setTagMaybe<T extends string | number | boolean | string[] | number[]>(
    name: string,
    value: T | null | undefined,
  ): void {
    if (value != null) {
      this.span.setAttributes({
        [name]: value as string | number | boolean | string[] | number[],
      });
    }
  }

  /**
   * Sets a custom end time for the scope.
   * When set, `dispose()` will pass this value to `span.end()` instead of using wall-clock time.
   */
  public setEndTime(endTime: TimeInput): void {
    this.customEndTime = endTime;
  }

  /** Records a cancellation event on the span. */
  public recordCancellation(reason?: string): void {
    const message = reason ?? "Task was cancelled";
    this.span.setStatus({ code: SpanStatusCode.ERROR, message });
    this.errorType = OpenTelemetryConstants.ERROR_TYPE_CANCELLED;
  }

  /** Converts a TimeInput value to milliseconds since epoch. */
  private static timeInputToMs(t: TimeInput): number {
    if (typeof t === "number") return t;
    if (t instanceof Date) return t.getTime();
    if (Array.isArray(t) && t.length === 2) return t[0] * 1000 + t[1] / 1_000_000;
    return Date.now();
  }

  private end(): void {
    if (this.hasEnded) return;

    const startMs =
      this.customStartTime !== undefined
        ? OpenTelemetryScope.timeInputToMs(this.customStartTime)
        : this.wallClockStartMs;
    const endMs =
      this.customEndTime !== undefined
        ? OpenTelemetryScope.timeInputToMs(this.customEndTime)
        : Date.now();
    const durationMs = Math.max(0, endMs - startMs);

    if (this.errorType) {
      this.span.setAttributes({ [OpenTelemetryConstants.ERROR_TYPE_KEY]: this.errorType });
    }

    this.hasEnded = true;
    this.logger.info(
      `[A365] Ending span[${this.span.spanContext().spanId}], duration: ${(durationMs / 1000).toFixed(3)}s`,
    );
  }

  /** Disposes the scope and finalizes telemetry data collection. */
  public [Symbol.dispose](): void {
    if (!this.hasEnded) {
      this.end();
      if (this.customEndTime !== undefined) {
        this.span.end(this.customEndTime);
      } else {
        this.span.end();
      }
    }
  }

  /** Legacy dispose method for compatibility. */
  public dispose(): void {
    this[Symbol.dispose]();
  }
}
