# Release History

## [Unreleased]

### Other Changes
- Lazy-load LangChain tracer to avoid eager import of `@langchain/core` before instrumentation hooks register. Removed noise when openai and langchain packages are not installed [#98](https://github.com/microsoft/opentelemetry-distro-javascript/pull/98)
- Accept beta versions of azure monitor exporter but not preview versions [#110](https://github.com/microsoft/opentelemetry-distro-javascript/pull/110)

## [1.0.0] - 2026-04-30

First stable (GA) release. Promotes all functionality from the 0.1.0-beta series.

### Breaking Changes
- A365: `a365.enabled: true` now registers only the `A365SpanProcessor`. Set `a365.enableObservabilityExporter: true` (or `ENABLE_A365_OBSERVABILITY_EXPORTER=true`) to also add the A365 HTTP exporter. ([#93](https://github.com/microsoft/opentelemetry-distro-javascript/pull/93))
- A365: `ENABLE_A365_OBSERVABILITY_EXPORTER` env var now toggles only the HTTP exporter, not the master `a365.enabled` flag. ([#83](https://github.com/microsoft/opentelemetry-distro-javascript/pull/83), [#93](https://github.com/microsoft/opentelemetry-distro-javascript/pull/93))
- Remove `hostDetector` from default resource detectors. Host attributes (`host.name`, `host.id`, etc.) are no longer added by default. Opt back in via `OTEL_NODE_RESOURCE_DETECTORS=env,host,os`. ([#97](https://github.com/microsoft/opentelemetry-distro-javascript/pull/97))

### Features Added
- Add `a365.enableObservabilityExporter`, `a365.observabilityScopeOverride`, and `a365.logLevel` code options as equivalents of `ENABLE_A365_OBSERVABILITY_EXPORTER`, `A365_OBSERVABILITY_SCOPES_OVERRIDE`, and `A365_OBSERVABILITY_LOG_LEVEL`. Programmatic values take precedence over env vars. ([#93](https://github.com/microsoft/opentelemetry-distro-javascript/pull/93))
- Expose all A365 exporter/batching settings (`maxQueueSize`, `scheduledDelayMilliseconds`, `exporterTimeoutMilliseconds`, `httpRequestTimeoutMilliseconds`, `maxExportBatchSize`, `maxPayloadSizeInBytes`, `useS2SEndpoint`) in the main config through `A365Options`. ([#94](https://github.com/microsoft/opentelemetry-distro-javascript/pull/94))
- Make Statsbeat feature/instrumentation tracking universal across Azure Monitor, A365, and OTLP paths. Add a standalone SDKStats pipeline that emits Feature/Instrumentation SDKStats to the Application Insights Statsbeat ingestion endpoint. New distro feature bits: `A365_EXPORT` (512), `OTLP_EXPORT` (1024), `CONSOLE_EXPORT` (2048). ([#85](https://github.com/microsoft/opentelemetry-distro-javascript/pull/85))
- Report `mot` SDK version prefix to Azure Monitor and Quickpulse so `ai.internal.sdkVersion` surfaces the distro version. ([#86](https://github.com/microsoft/opentelemetry-distro-javascript/pull/86))

### Bugs Fixed
- `ENABLE_A365_OBSERVABILITY_EXPORTER` environment variable now correctly acts only as a secondary toggle within an already-configured A365 setup, preventing it from silently disabling HTTP instrumentation or creating a broken exporter. ([#83](https://github.com/microsoft/opentelemetry-distro-javascript/pull/83))
- Enable GenAI instrumentations (OpenAI Agents, LangChain) by default for all users. Previously they were only initialized when `instrumentationOptions` explicitly included them. ([#87](https://github.com/microsoft/opentelemetry-distro-javascript/pull/87))

### Other Changes
- Documentation updates for A365 observability. ([#82](https://github.com/microsoft/opentelemetry-distro-javascript/pull/82))
- Add custom SpanProcessor filtering scenario to A365 migration guide. ([#89](https://github.com/microsoft/opentelemetry-distro-javascript/pull/89))
- Update A365 documentation title, Learn docs links, and expand migration guide with resource config, auto-instrumentation behavior, and troubleshooting guidance. ([#96](https://github.com/microsoft/opentelemetry-distro-javascript/pull/96))
- Add issue templates, auto-label workflow, and code owner notification action. ([#60](https://github.com/microsoft/opentelemetry-distro-javascript/pull/60), [#62](https://github.com/microsoft/opentelemetry-distro-javascript/pull/62))

## [0.1.0-beta.1] - 2026-04-27

First beta release. Promotes all functionality from the 0.1.0-alpha series.

### Breaking Changes
- When A365 is enabled through configured A365 options, non-GenAI instrumentations are now disabled by default unless explicitly enabled in `instrumentationOptions`. `ENABLE_A365_OBSERVABILITY_EXPORTER` no longer activates A365 on its own; it only toggles the exporter within an already-configured A365 setup. ([#79](https://github.com/microsoft/opentelemetry-distro-javascript/pull/79))
- Align GenAI instrumentations with A365 observability schema: use structured message format, update span kinds and attributes (`gen_ai.agent.name`, `gen_ai.conversation.id`, `error.type`), and remove `isContentRecordingEnabled` option (content is now always recorded). ([#75](https://github.com/microsoft/opentelemetry-distro-javascript/pull/75))

### Features Added
- Add ESM loader entrypoint (`@microsoft/opentelemetry/loader`) and document ESM support. ([#74](https://github.com/microsoft/opentelemetry-distro-javascript/pull/74))

### Bugs Fixed
- `ENABLE_A365_OBSERVABILITY_EXPORTER` environment variable no longer activates A365 on its own. A365 options must be provided in code; the env var only toggles the exporter within an already-configured A365 setup. ([#43](https://github.com/microsoft/opentelemetry-distro-javascript/issues/43))
- Fix `Agent365Exporter` not emitting `[EVENT]:` export outcome logs to a logger configured via `configureA365Logger` after the exporter was constructed. The exporter previously cached the logger snapshot at construction time, so the distro-bootstrapped exporter never picked up partner-supplied loggers. ([#81](https://github.com/microsoft/opentelemetry-distro-javascript/pull/81))
- Register `A365SpanProcessor` for console fallback path so `telemetry.sdk.*` attributes and baggage-to-span enrichment are present when the A365 exporter is disabled. ([#78](https://github.com/microsoft/opentelemetry-distro-javascript/pull/78))
- Restore `AgenticTokenCache` that was accidentally removed in #66. ([#77](https://github.com/microsoft/opentelemetry-distro-javascript/pull/77))

### Other Changes
- Bump postcss from 8.5.8 to 8.5.10. ([#72](https://github.com/microsoft/opentelemetry-distro-javascript/pull/72))

## [0.1.0-alpha.6] - 2026-04-24

### Breaking Changes
- Remove `A365BaggageOptions` and `A365HostingOptions` configuration types and the `a365.baggage` and `a365.hosting` configuration options. These options were never hooked up to runtime behavior and do not exist in the baseline package. `A365SpanProcessor` is now unconditionally enabled whenever A365 export is enabled. See the [A365 migration guide](./MIGRATION_A365.md) for details. ([#66](https://github.com/microsoft/opentelemetry-distro-javascript/pull/66))

### Features Added
- Add `configureA365Hosting(adapter, options?)` helper for one-line A365 hosting middleware setup. ([#55](https://github.com/microsoft/opentelemetry-distro-javascript/pull/55))
- Add `AgenticTokenCache` for built-in token caching support. ([#68](https://github.com/microsoft/opentelemetry-distro-javascript/pull/68))
- Migrate `PerRequestSpanProcessor` from Agent365-nodejs. ([#70](https://github.com/microsoft/opentelemetry-distro-javascript/pull/70))

### Bugs Fixed
- Fix hosting middleware for plain CloudAdapter activities. ([#64](https://github.com/microsoft/opentelemetry-distro-javascript/pull/64))
- Restore A365 exporter event logs for export outcomes. ([#67](https://github.com/microsoft/opentelemetry-distro-javascript/pull/67))

### Other Changes
- Unify GenAI init order and add distro integration coverage. ([#63](https://github.com/microsoft/opentelemetry-distro-javascript/pull/63))
- Temporarily remove co-code owners. ([#65](https://github.com/microsoft/opentelemetry-distro-javascript/pull/65))
- Update A365 migration guide. ([#69](https://github.com/microsoft/opentelemetry-distro-javascript/pull/69))

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
