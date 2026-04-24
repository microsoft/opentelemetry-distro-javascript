# Release History

## [0.1.0-alpha.6] - 2026-04-24

### Breaking Changes
- Remove undocumented A365 config options that were stored but never consumed: `a365.baggage.propagationEnabled`, `a365.baggage.enrichSpans`, `a365.hosting.enabled`, `a365.hosting.adapter`, and `a365.hosting.enableOutputLogging`. This aligns the distro A365 surface with `@microsoft/agents-a365-observability`. ([#66](https://github.com/microsoft/opentelemetry-distro-javascript/pull/66))

### Features Added
- Add `configureA365Hosting(adapter, options?)` helper for one-line A365 hosting middleware setup. ([#55](https://github.com/microsoft/opentelemetry-distro-javascript/pull/55))
- Add built-in `AgenticTokenCache` support for A365 hosting token exchange, including expiry-aware caching, retries, eviction, a default singleton instance, and public re-exports from hosting, A365, and top-level entrypoints. ([#68](https://github.com/microsoft/opentelemetry-distro-javascript/pull/68))
- Add an internal per-request export compatibility path via `ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT`, migrating buffered trace export and context token fallback behavior for A365 scenarios without re-exposing `PerRequestSpanProcessor` in the public API. ([#70](https://github.com/microsoft/opentelemetry-distro-javascript/pull/70))

### Other Changes
- Always register `A365SpanProcessor` when A365 export is enabled and remove obsolete tests/docs tied to the deleted undocumented config options. ([#66](https://github.com/microsoft/opentelemetry-distro-javascript/pull/66))
- Extend A365 migration guidance with self-service instructions for reproducing per-request export behavior through supported public APIs. ([#70](https://github.com/microsoft/opentelemetry-distro-javascript/pull/70))


## [0.1.0-alpha.5] - 2026-04-24 

### Breaking Changes
- Remove Azure Functions auto-instrumentation support from this package. The `instrumentationOptions.azureFunctions` option is no longer available. ([#45](https://github.com/microsoft/opentelemetry-distro-javascript/pull/45))
- Remove JSON configuration support (`applicationinsights.json`, `APPLICATIONINSIGHTS_CONFIGURATION_FILE`, and `APPLICATIONINSIGHTS_CONFIGURATION_CONTENT`). Configuration now comes only from programmatic options and environment variables. ([#49](https://github.com/microsoft/opentelemetry-distro-javascript/pull/49))
- Remove `PerRequestSpanProcessor` and `PerRequestSpanProcessorOptions` from the public API. ([#47](https://github.com/microsoft/opentelemetry-distro-javascript/pull/47))

### Features Added
- Expose additional A365 public configuration options through `A365Options`: `serviceNamespace`, `exporterOptions`, `observabilityLogLevel`, and `logger`.
- Add A365 logger configuration support with injectable `ILogger`, `configureA365Logger`, `getA365Logger`, and env override via `A365_OBSERVABILITY_LOG_LEVEL`.
- Apply A365 exporter tuning options to batch processor/exporter wiring and support global `service.namespace` resource merge when configured via A365 options.

### Bugs Fixed
- Prevent ESM/CJS interop regressions by removing the problematic Azure Functions instrumentation path and adding explicit built-ESM import regression coverage. ([#45](https://github.com/microsoft/opentelemetry-distro-javascript/pull/45))
- Remove startup noise caused by implicit JSON config file probing in the Microsoft distro. ([#49](https://github.com/microsoft/opentelemetry-distro-javascript/pull/49))

### Other Changes
- Expand PR validation checks to run unit tests, functional tests, and a built ESM import smoke test. ([#45](https://github.com/microsoft/opentelemetry-distro-javascript/pull/45))
- Bump hono from 4.12.12 to 4.12.14. ([#19](https://github.com/microsoft/opentelemetry-distro-javascript/pull/19))
- Expand PR validation checks to run unit tests, functional tests, and a built ESM import smoke test.
- Update README and A365 migration guide with actionable configuration documentation, including `a365.exporterOptions` details and migration-focused steps.

## [0.1.0-alpha.4] - 2026-04-22

### Breaking Changes
- Remove `PerRequestSpanProcessor` and its `PerRequestSpanProcessorOptions` from the public API. The `perRequestExport` option on `A365Options` and the `ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT` environment variable have also been removed. ([#40](https://github.com/microsoft/opentelemetry-distro-javascript/pull/40))
  - **Migration:** If you were relying on per-request export behaviour, use the now-public `Agent365Exporter` together with any OTel-compatible `SpanProcessor`. See the [migration guide](./MIGRATION_A365.md#custom-span-export) for an example.

### Features Added
- Export `Agent365Exporter`, `Agent365ExporterOptions`, and `TokenResolver` as public API to enable custom span processor configurations. ([#40](https://github.com/microsoft/opentelemetry-distro-javascript/pull/40))
- Add console exporter ([#35](https://github.com/microsoft/opentelemetry-distro-javascript/pull/35))
- Conditional azure monitor and readme updates ([#33](https://github.com/microsoft/opentelemetry-distro-javascript/pull/33))
- Add a365 hosting middleware ([#29](https://github.com/microsoft/opentelemetry-distro-javascript/pull/29))

### Bugs Fixed
- Fix A365 scopes producing no-op spans with zeroed trace/span IDs after distro initialization. ([#41](https://github.com/microsoft/opentelemetry-distro-javascript/pull/41))
- Remove legacy useAzureMonitor API and add Azure Monitor E2E tests([#38](https://github.com/microsoft/opentelemetry-distro-javascript/pull/38))

## [0.1.0-alpha.3] - 2026-04-21

### Features Added
- Vendor A365 observability code in-repo: scopes, exporter, processors, baggage, context propagation, and configuration ([#27](https://github.com/microsoft/opentelemetry-distro-javascript/pull/27))
- Add Azure Monitor disable flag ([#30](https://github.com/microsoft/opentelemetry-distro-javascript/pull/30))

### Bugs Fixed
- Fix dual ESM/CJS output ([#30](https://github.com/microsoft/opentelemetry-distro-javascript/pull/30))
- Fix samples build: use local package reference, add `skipLibCheck`, replace deprecated `ChatOpenAI` with `AzureChatOpenAI` ([#28](https://github.com/microsoft/opentelemetry-distro-javascript/pull/28))


## [0.1.0-alpha.2] - 2026-04-20

### Features Added
- Integrate A365 observability with the distro ([#25](https://github.com/microsoft/opentelemetry-distro-javascript/pull/25))
- Move Azure Monitor files into src/azureMonitor/ subdirectory ([#23](https://github.com/microsoft/opentelemetry-distro-javascript/pull/23))
- Add OpenAI Agents SDK instrumentation. ([#14](https://github.com/microsoft/opentelemetry-distro-javascript/pull/14))

## [0.1.0-alpha.1] - 2026-04-10

### Features Added
- `useMicrosoftOpenTelemetry` entry point with Azure Monitor integration.
- `shutdownMicrosoftOpenTelemetry` for clean teardown.
- Modular setup architecture with extension points for OTLP and A365.
- Migrated `@azure/monitor-opentelemetry` distro code in-repo for direct iteration.
- Microsoft OpenTelemetry distro rebranding and configuration support.
- Add langchain instrumentation. ([#10](https://github.com/microsoft/opentelemetry-distro-javascript/pull/10))

### Other Changes
- Initial project scaffolding with TypeScript, ESLint, and Vitest.
- PR validation CI workflow.
- Added `azure-monitor-opentelemetry` package source for Azure Monitor OpenTelemetry distro integration.
