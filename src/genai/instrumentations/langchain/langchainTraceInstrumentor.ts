// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-langchain
// Adapted: removed ObservabilityManager dependency, uses diag logger instead of A365 logger

import type * as CallbackManagerModule from "@langchain/core/callbacks/manager";
import { diag, trace, Tracer } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationConfig,
  InstrumentationModuleDefinition,
  isWrapped,
} from "@opentelemetry/instrumentation";
import { LangChainTracer } from "./tracer.js";

type CallbackManagerModuleType = typeof CallbackManagerModule;
type LangChainTracerCtor = new (tracer: Tracer) => LangChainTracer;

class LangChainTraceInstrumentorImpl extends InstrumentationBase<InstrumentationConfig> {
  private static _instance: LangChainTraceInstrumentorImpl | null = null;
  private _hasBeenEnabled = false;
  private _isPatched = false;
  protected otelTracer: Tracer;
  // Statically bound at module load. A previous lazy `import("./tracer.js")`
  // resolved on a later microtask, so any `_configureSync` call that landed
  // in that window (typically the first compiled-graph `invoke` after distro
  // startup) silently fell through with no tracer attached, dropping the
  // outer `invoke_agent LangGraph` wrapper span and fragmenting the trace.
  // A static import is safe: by the time `patch()` runs, the callbacks
  // manager module is already loaded (it is the `module` argument).
  private _tracerCtor: LangChainTracerCtor = LangChainTracer;

  private constructor() {
    if (LangChainTraceInstrumentorImpl._instance !== null) {
      throw new Error("LangChainTraceInstrumentor can only be instantiated once.");
    }

    super("microsoft-otel-langchain-instrumentor", "1.0.0", {
      enabled: true,
    });

    this.otelTracer = trace.getTracer("microsoft-otel-langchain", "1.0.0");

    LangChainTraceInstrumentorImpl._instance = this;
    diag.info("[LangChainTraceInstrumentor] Initialized and automatically enabled");
  }

  static getInstance(): LangChainTraceInstrumentorImpl {
    if (!LangChainTraceInstrumentorImpl._instance) {
      LangChainTraceInstrumentorImpl._instance = new LangChainTraceInstrumentorImpl();
    }
    return LangChainTraceInstrumentorImpl._instance;
  }

  static hasInstance(): boolean {
    return LangChainTraceInstrumentorImpl._instance !== null;
  }

  static resetInstance(): void {
    if (LangChainTraceInstrumentorImpl._instance) {
      LangChainTraceInstrumentorImpl._instance._isPatched = false;
    }
    LangChainTraceInstrumentorImpl._instance = null;
  }

  protected init(): InstrumentationModuleDefinition {
    return {
      name: "@langchain/core/callbacks/manager",
      supportedVersions: [">=0.2.0"],
      files: [],
      patch: this.patch.bind(this),
      unpatch: this.unpatch.bind(this),
    };
  }

  private unpatch(moduleExports: Record<string, unknown>): void {
    const CallbackManager =
      moduleExports?.CallbackManager as typeof CallbackManagerModule.CallbackManager;
    if (!CallbackManager || !isWrapped(CallbackManager._configureSync)) {
      return;
    }

    this._unwrap(CallbackManager, "_configureSync");
    this._isPatched = false;
    diag.info("[LangChainTraceInstrumentor] Unpatched OTEL LangChain instrumentation");
  }

  patch(module: CallbackManagerModuleType): CallbackManagerModuleType {
    if (this._isPatched) {
      return module;
    }

    const { CallbackManager } = module as CallbackManagerModuleType;
    if (!CallbackManager || !("_configureSync" in CallbackManager)) {
      return module;
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentor = this;
    this._wrap(CallbackManager, "_configureSync", (original) => {
      return function (
        this: CallbackManagerModuleType,
        ...args: Parameters<(typeof CallbackManager)["_configureSync"]>
      ) {
        args[0] = addTracerToHandlers(instrumentor.otelTracer, args[0], instrumentor._tracerCtor);
        diag.debug("[LangChainTraceInstrumentor] _configureSync wrapped to add LangChainTracer");
        return original.apply(this, args);
      };
    });

    diag.info("[LangChainTraceInstrumentor] Patched OTEL LangChain instrumentation");
    this._isPatched = true;
    return module;
  }

  manuallyInstrumentImpl(module: CallbackManagerModuleType): void {
    diag.info("[LangChainTraceInstrumentor] Manually instrumenting CallbackManagerModule");
    this.patch(module);
  }

  public instrumentationDependencies(): readonly string[] {
    return ["@langchain/core >= 0.2.0"] as const;
  }

  public override enable(): void {
    if (this._hasBeenEnabled) {
      return;
    }
    this._hasBeenEnabled = true;
    diag.info("[LangChainTraceInstrumentor] Enabled LangChain instrumentation");
    super.enable();
  }

  public override disable(): void {
    this._hasBeenEnabled = false;
    diag.info("[LangChainTraceInstrumentor] Disabled LangChain instrumentation");
    super.disable();
  }
}

/**
 * Static wrapper for LangChain tracing instrumentation
 */
export class LangChainTraceInstrumentor {
  private static throwNotInitialized(): never {
    throw new Error(
      "LangChainTraceInstrumentor must be initialized first. " +
        "Call LangChainTraceInstrumentor.instrument() before using enable/disable.",
    );
  }

  /**
   * Initialize and auto-instrument for LangChain
   * @param module The CallbackManager module to instrument
   * @param options Optional configuration options
   */
  static instrument(module: CallbackManagerModuleType): void {
    LangChainTraceInstrumentorImpl.getInstance().manuallyInstrumentImpl(module);
  }

  /**
   * Enable LangChain instrumentation
   */
  static enable(): void {
    if (!LangChainTraceInstrumentorImpl.hasInstance()) {
      this.throwNotInitialized();
    }
    LangChainTraceInstrumentorImpl.getInstance().enable();
  }

  /**
   * Disable LangChain instrumentation
   */
  static disable(): void {
    if (!LangChainTraceInstrumentorImpl.hasInstance()) {
      this.throwNotInitialized();
    }
    LangChainTraceInstrumentorImpl.getInstance().disable();
  }

  /**
   * Reset the instrumentor instance (for testing)
   */
  static resetInstance(): void {
    LangChainTraceInstrumentorImpl.resetInstance();
  }
}

export function addTracerToHandlers(
  tracer: Tracer,
  handlers: CallbackManagerModule.Callbacks | undefined,
  tracerCtor: LangChainTracerCtor,
): CallbackManagerModule.Callbacks {
  if (handlers == null) {
    return [new tracerCtor(tracer)];
  }

  if (Array.isArray(handlers)) {
    if (!handlers.some((h) => h instanceof tracerCtor)) {
      handlers.push(new tracerCtor(tracer));
    }
    return handlers;
  }

  if (!handlers.inheritableHandlers.some((h) => h instanceof tracerCtor)) {
    handlers.addHandler(new tracerCtor(tracer), true);
  }
  return handlers;
}
