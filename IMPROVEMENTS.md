# Improvements

## Logger Consolidation

Currently, A365 has a custom `ILogger` abstraction (`configureA365Logger()`, `getA365Logger()` in `src/a365/logging.ts`). The distro should consolidate all logging to use OpenTelemetry's standard logger API (`@opentelemetry/api`) instead of maintaining custom logger implementations.

**Future improvement:** Replace `A365Logger` with OTel's `DiagLogger` and remove the custom logging interface.

---

## serviceNamespace Configuration

Currently, `serviceNamespace` is nested under A365 options (`a365.serviceNamespace`), but it's semantically a global resource attribute that applies to all telemetry (all exporters: Azure Monitor, OTLP, A365).

**Future improvement:** Move `serviceNamespace` to root `MicrosoftOpenTelemetryOptions` so it's configured via the resource passed to the root config, not as an A365-specific option. This decouples global resource configuration from A365-specific settings.

**Current implementation:** Works correctly and will not be removed, but can be refactored in a future release to be root-level instead.

---

## GenAI Instrumentation Lifecycle Unification

Currently, GenAI instrumentation (`langchain`, `openaiAgents`) is initialized through a manual bootstrap path in `useMicrosoftOpenTelemetry()` instead of being created by the same `createInstrumentations()` pipeline used for core instrumentations (`http`, `mongoDb`, `redis`, etc.).

**Why the current approach exists:**
1. Both GenAI integrations depend on optional packages (`@langchain/core`, `@openai/agents`) that may not be installed in every app using this distro.
2. The integrations are not pure require-hook instrumentations: LangChain is manually attached to `CallbackManager`, and OpenAI Agents registers an SDK trace processor via `setTraceProcessors(...)`.
3. The initial implementation prioritized graceful opt-in behavior and optional-dependency safety over lifecycle consistency with the main NodeSDK instrumentation factory.

This split lifecycle increases the risk of startup-order issues (for example, instrumentors capturing a tracer before the SDK provider is fully registered) and makes behavior less consistent with the rest of the distro.

**Future improvement:** Align GenAI with the standard OTel instrumentation model used in this distro:
1. GenAI instrumentations are created by the same instrumentation factory path and passed to `sdkConfig.instrumentations`.
2. Distro startup must never crash due to missing target SDKs.
3. Runtime behavior should match other instrumentations: if a target library is not present, instrumentation is a no-op (with diagnostic warning), not a startup failure.

**Design note:**
The distro package itself can include instrumentation implementations, but those implementations must avoid hard runtime imports that can throw at startup when target SDKs are absent. This keeps behavior consistent with OTel expectations while preserving type-safe public config.

**Suggested acceptance criteria:**
1. GenAI options are resolved via the same instrumentation factory path as other instrumentations.
2. Missing target SDKs remain non-fatal and log a clear warning.
3. Startup/shutdown ordering is deterministic and validated with functional tests for both LangChain and OpenAI Agents.
4. Public config semantics for `instrumentationOptions.langchain` and `instrumentationOptions.openaiAgents` remain unchanged.
