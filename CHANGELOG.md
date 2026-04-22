# Release History

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
