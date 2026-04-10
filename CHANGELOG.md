# Release History

## [0.1.0] - Unreleased

### Features Added
- Add langchain isntrumentation.([#10](https://github.com/microsoft/opentelemetry-distro-javascript/pull/10))
- Add OpenAI Agents SDK instrumentation.([#12](https://github.com/microsoft/opentelemetry-distro-javascript/pull/12))

### Breaking Changes

### Bugs Fixed

### Other Changes
- Initial project scaffolding with TypeScript, ESLint, and Vitest.
- `useMicrosoftOpenTelemetry` entry point with Azure Monitor integration.
- `shutdownMicrosoftOpenTelemetry` for clean teardown.
- Modular setup architecture with extension points for OTLP and A365.
- PR validation CI workflow.
- Added `azure-monitor-opentelemetry` package source for Azure Monitor OpenTelemetry distro integration.
