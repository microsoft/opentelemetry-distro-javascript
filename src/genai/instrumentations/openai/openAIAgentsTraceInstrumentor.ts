// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-openai
// Adapted: removed ObservabilityManager dependency, uses diag logger instead of A365 logger

import { diag, trace, Tracer } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationConfig,
  InstrumentationModuleDefinition,
} from "@opentelemetry/instrumentation";
import { setTraceProcessors, setTracingDisabled, TracingProcessor } from "@openai/agents";
import { OpenAIAgentsTraceProcessor } from "./openAIAgentsTraceProcessor.js";

/**
 * Configuration options for the OpenAI Agents instrumentor.
 */
export interface OpenAIAgentsInstrumentationConfig extends InstrumentationConfig {
  /**
   * When true, the gen_ai.input.messages attribute containing LLM input
   * messages will be suppressed and not attached to spans in InvokeAgent scopes.
   * @default false
   */
  suppressInvokeAgentInput?: boolean;
  /**
   * Whether to enable content recording (input/output messages, tool args, etc.).
   * @default false
   */
  isContentRecordingEnabled?: boolean;
}

/**
 * Internal singleton implementation.
 */
class OpenAIAgentsTraceInstrumentorImpl extends InstrumentationBase<OpenAIAgentsInstrumentationConfig> {
  private static _instance: OpenAIAgentsTraceInstrumentorImpl | null = null;
  private _hasBeenEnabled = false;
  private processor?: OpenAIAgentsTraceProcessor;
  protected otelTracer: Tracer;

  private constructor(config: OpenAIAgentsInstrumentationConfig = {}) {
    if (OpenAIAgentsTraceInstrumentorImpl._instance !== null) {
      throw new Error("OpenAIAgentsTraceInstrumentor can only be instantiated once.");
    }

    super("microsoft-otel-openai-agents-instrumentor", "1.0.0", {
      enabled: true,
      ...config,
    });

    this.otelTracer = trace.getTracer("microsoft-otel-openai-agents", "1.0.0");

    OpenAIAgentsTraceInstrumentorImpl._instance = this;
    diag.info("[OpenAIAgentsTraceInstrumentor] Initialized");
  }

  static getInstance(
    config?: OpenAIAgentsInstrumentationConfig,
  ): OpenAIAgentsTraceInstrumentorImpl {
    if (!OpenAIAgentsTraceInstrumentorImpl._instance) {
      OpenAIAgentsTraceInstrumentorImpl._instance = new OpenAIAgentsTraceInstrumentorImpl(config);
    }
    return OpenAIAgentsTraceInstrumentorImpl._instance;
  }

  static hasInstance(): boolean {
    return OpenAIAgentsTraceInstrumentorImpl._instance !== null;
  }

  static resetInstance(): void {
    const inst = OpenAIAgentsTraceInstrumentorImpl._instance;
    if (inst) {
      void inst.processor?.shutdown();
      inst.processor = undefined;
    }
    OpenAIAgentsTraceInstrumentorImpl._instance = null;
  }

  protected init(): InstrumentationModuleDefinition {
    return {
      name: "@openai/agents",
      supportedVersions: [">=0.1.5"],
      files: [],
    };
  }

  public instrumentationDependencies(): readonly string[] {
    return ["@openai/agents >= 0.1.5"] as const;
  }

  /**
   * Enable instrumentation.
   * Sets up the trace processor and registers it with the OpenAI Agents SDK.
   */
  public override enable(): void {
    if (this._hasBeenEnabled) {
      return;
    }
    this._hasBeenEnabled = true;

    // Enable tracing in the OpenAI Agents SDK
    setTracingDisabled(false);

    this.processor = new OpenAIAgentsTraceProcessor(this.otelTracer, {
      suppressInvokeAgentInput: this._config.suppressInvokeAgentInput ?? false,
      isContentRecordingEnabled: this._config.isContentRecordingEnabled ?? false,
    });

    try {
      setTraceProcessors([this.processor as TracingProcessor]);
    } catch (error) {
      diag.error(
        `[OpenAIAgentsTraceInstrumentor] Failed to register trace processor: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    diag.info("[OpenAIAgentsTraceInstrumentor] Enabled OpenAI Agents instrumentation");
    super.enable();
  }

  /**
   * Disable instrumentation.
   */
  public override disable(): void {
    if (this.processor) {
      void this.processor.shutdown();
      this.processor = undefined;
    }

    this._hasBeenEnabled = false;

    try {
      setTraceProcessors([]);
    } catch (error) {
      diag.error(
        `[OpenAIAgentsTraceInstrumentor] Failed to clear trace processors: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    diag.info("[OpenAIAgentsTraceInstrumentor] Disabled OpenAI Agents instrumentation");
    super.disable();
  }

  public getProcessor(): OpenAIAgentsTraceProcessor | undefined {
    return this.processor;
  }
}

/**
 * Static wrapper for OpenAI Agents SDK tracing instrumentation.
 *
 * Usage:
 * ```ts
 * OpenAIAgentsTraceInstrumentor.instrument({ isContentRecordingEnabled: true });
 * ```
 */
export class OpenAIAgentsTraceInstrumentor {
  private static throwNotInitialized(): never {
    throw new Error(
      "OpenAIAgentsTraceInstrumentor must be initialized first. " +
        "Call OpenAIAgentsTraceInstrumentor.instrument() before using enable/disable.",
    );
  }

  /**
   * Initialize and auto-enable the OpenAI Agents instrumentation.
   */
  static instrument(options?: OpenAIAgentsInstrumentationConfig): void {
    OpenAIAgentsTraceInstrumentorImpl.getInstance(options).enable();
  }

  /**
   * Enable OpenAI Agents instrumentation.
   */
  static enable(): void {
    if (!OpenAIAgentsTraceInstrumentorImpl.hasInstance()) {
      this.throwNotInitialized();
    }
    OpenAIAgentsTraceInstrumentorImpl.getInstance().enable();
  }

  /**
   * Disable OpenAI Agents instrumentation.
   */
  static disable(): void {
    if (!OpenAIAgentsTraceInstrumentorImpl.hasInstance()) {
      this.throwNotInitialized();
    }
    OpenAIAgentsTraceInstrumentorImpl.getInstance().disable();
  }

  /**
   * Reset the instrumentor instance (for testing).
   */
  static resetInstance(): void {
    OpenAIAgentsTraceInstrumentorImpl.resetInstance();
  }
}
