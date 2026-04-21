# azure-monitor-opentelemetry (Temporary)

> **This is a temporary staging area for the `@azure/monitor-opentelemetry` package source.**

This directory exists solely to validate the integration between the Microsoft OpenTelemetry distro and the Azure Monitor OpenTelemetry pipeline. It allows us to iterate on the distro configuration surface and understand the required changes before they are finalized upstream.

## Important

- **This is not the source of truth.** The canonical source for `@azure/monitor-opentelemetry` lives in the [Azure SDK for JavaScript](https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/monitor/monitor-opentelemetry) repository.
- **Do not make long-lived changes here.** Any changes required in `@azure/monitor-opentelemetry` should be developed in parallel in the actual Azure SDK repository.
- **This copy will be removed** once the upstream package exposes the necessary APIs and the distro can depend on a published release, or once the code is fully migrated into `src/`.

## Migration Plan

Per the distro planning document (see [PLANNING.md](../PLANNING.md) Phase 3), the Azure Monitor OpenTelemetry code will be migrated directly into this repository so it can be modified freely alongside the Microsoft distro code. Key goals:

- Refactor for exporter-optional setup (skip Azure Monitor exporter attachment when not needed)
- Expose provider instances (`TracerProvider`, `MeterProvider`, `LoggerProvider`) after setup so the distro can layer additional exporters (OTLP, A365)
- Enable instrumentation activation to be driven by the distro configuration without requiring Azure Monitor-specific export
- Establish a synchronization process for backporting fixes between this repo and the standalone package during the dual-maintenance period
