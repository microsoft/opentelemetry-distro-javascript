# Improvements

## Logger Consolidation

Currently, A365 has a custom `ILogger` abstraction (`configureA365Logger()`, `getA365Logger()` in `src/a365/logging.ts`). The distro should consolidate all logging to use OpenTelemetry's standard logger API (`@opentelemetry/api`) instead of maintaining custom logger implementations.

**Future improvement:** Replace `A365Logger` with OTel's `DiagLogger` and remove the custom logging interface.

---

## serviceNamespace Configuration

Currently, `serviceNamespace` is nested under A365 options (`a365.serviceNamespace`), but it's semantically a global resource attribute that applies to all telemetry (all exporters: Azure Monitor, OTLP, A365).

**Future improvement:** Move `serviceNamespace` to root `MicrosoftOpenTelemetryOptions` so it's configured via the resource passed to the root config, not as an A365-specific option. This decouples global resource configuration from A365-specific settings.

**Current implementation:** Works correctly and will not be removed, but can be refactored in a future release to be root-level instead.
