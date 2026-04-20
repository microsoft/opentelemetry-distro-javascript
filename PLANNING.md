# Planning

This document captures the minimum work needed to turn this repository into a working JavaScript/TypeScript distribution for Microsoft OpenTelemetry based on the referenced POC.

## Target Outcome

Provide an npm package that exposes a single `useMicrosoftOpenTelemetry()` entry point and can wire together:

- Azure Monitor export
- OTLP export
- Microsoft-specific exporter and span enrichment hooks
- optional GenAI instrumentations
- environment-variable based configuration

## Core Strategy: Migrate Azure Monitor Distro Code In-Repo

The team owns both this package and the Azure Monitor OpenTelemetry Distro (`@azure/monitor-opentelemetry`). Rather than depending on the published npm package and coordinating upstream changes, we will **migrate the Azure Monitor OpenTelemetry code directly into this repository**. This allows rapid iteration on new features and bug fixes without waiting on separate release cycles for the Azure Monitor Distro.

Key principles:

- **In-repo copy of Azure Monitor OpenTelemetry.** The relevant code from `@azure/monitor-opentelemetry` is vendored/migrated into this repository so it can be modified freely alongside the Microsoft distro code.
- **Dual maintenance during transition.** Both the standalone `@azure/monitor-opentelemetry` npm package and the in-repo copy will be maintained in parallel for a period. Bug fixes and new features should be applied to both until the standalone package is deprecated or consumers have migrated.
- **Direct control over customization.** With the code in-repo, customization hooks (exporter-optional setup, provider exposure, instrumentation enablement) can be implemented directly without requiring upstream PRs and coordinated releases.
- **Composition with full flexibility.** The `useMicrosoftOpenTelemetry()` function can directly wire provider creation, standard instrumentation, and exporter attachment using the in-repo Azure Monitor code, then layer on Microsoft-specific capabilities (OTLP export, GenAI instrumentations, agent observability extensions).
- **Path to single package.** Over time, the in-repo code becomes the authoritative source and the standalone Azure Monitor Distro package can either be deprecated or become a thin wrapper that re-exports from this package.

### Dual Maintenance Guidelines

- Any bug fix applied to the in-repo Azure Monitor code must also be backported to the standalone `@azure/monitor-opentelemetry` repository (and vice versa) until the transition is complete
- Keep a clear mapping between in-repo modules and their upstream counterparts to simplify cherry-picks
- Define a cutover milestone after which new features land only in this repository
- Existing users of the standalone `@azure/monitor-opentelemetry` package must not be broken — deprecation notices and migration guides will be provided before any removal

## Phase 1: Package Foundation

- ~~Finalize the published package name and import path~~ — **Decided: `@microsoft/opentelemetry` on npm**
- Supported Node.js versions follow the OpenTelemetry SDK/API supported versions — no independent decision needed
- Add package metadata (`package.json`), keywords, and Node.js version constraints matching OpenTelemetry
- Add lint, format, and test tooling (ESLint, Prettier, Jest/Vitest)
- Add CI for unit tests and package validation
- Configure TypeScript compilation and type declarations

## Phase 2: Configuration Surface

- Define the `useMicrosoftOpenTelemetry()` function signature
- Mirror the POC options that are core to the distro story
- Separate stable public options from experimental ones
- Add environment-variable parsing for all supported flags and endpoints
- Define validation and error messages for incompatible options

### Configuration Scoping

Each configuration option must be clearly identified by scope so consumers know which options are relevant to their scenario:

- **Global** — Options that apply to all setups regardless of backend (e.g., sampling rate, resource attributes, instrumentation enablement, log level, Node.js-level OTel settings)
- **Azure Monitor** — Options specific to Azure Monitor export and behavior (e.g., connection string, live metrics, browser SDK loader, Azure Monitor-specific processors)
- **A365** — Options specific to A365 agent observability (e.g., A365 exporter endpoint, baggage extensions, Microsoft Agent Framework instrumentation toggles, A365-specific span processors)
- **OTLP** — Options specific to OTLP export (e.g., OTLP endpoint, protocol, headers, compression)

Design guidelines:

- Use clear naming conventions or prefixes to signal scope (e.g., `azureMonitor*`, `a365*`, `otlp*` for scoped options; no prefix for global)
- Environment variables should follow the same scoping convention (e.g., `MICROSOFT_OTEL_AZURE_MONITOR_*`, `MICROSOFT_OTEL_A365_*`)
- Validation should warn when scope-specific options are set but the corresponding backend/feature is not enabled
- Documentation and help text for each option must state its scope

## Phase 3: Azure Monitor Code Migration

- Migrate the relevant Azure Monitor OpenTelemetry Distro code into this repository under a well-defined module boundary
- Refactor the migrated code to support exporter-optional setup (skip automatic Azure Monitor exporter attachment when not needed)
- Expose provider instances (TracerProvider, MeterProvider, LoggerProvider) after setup so the distro can add exporters
- Ensure instrumentation enablement can be driven by the distro configuration without pulling in Azure Monitor-specific export
- Validate that the migrated code produces identical behavior to the standalone `@azure/monitor-opentelemetry` package
- Establish a synchronization process for backporting fixes between this repo and the standalone package during the dual-maintenance period

## Phase 4: Core OpenTelemetry Setup (This Package)

- Use the in-repo Azure Monitor code directly for provider creation and standard instrumentation
- When Azure Monitor export is requested, attach the Azure Monitor exporter using the migrated code
- When Azure Monitor export is not requested, create providers without the exporter (now trivial since the code is in-repo)
- Add OTLP export for traces, logs, and metrics on top of the providers
- Add hooks for custom span processors, log processors, metric readers, and views
- Add sampling configuration support

## Phase 5: Additional Instrumentation (This Package Only)

### GenAI Instrumentation Strategy

The OpenTelemetry JavaScript contrib GenAI instrumentations are significantly outdated compared to the Python equivalents. The LangChain instrumentation in contrib is skeleton code with no real functionality. Rather than depend on incomplete upstream packages, we will **host A365's existing GenAI instrumentations in this repository** until the OpenTelemetry JS contrib packages reach a usable state.

- Add GenAI instrumentations sourced from A365's existing implementations:
  - **OpenAI instrumentation** — migrated from A365 internal instrumentation (the `@opentelemetry/instrumentation-openai` contrib package is outdated and not usable as-is)
  - **OpenAI Agents SDK instrumentation** — migrated from A365 internal instrumentation
  - **LangChain instrumentation** — migrated from A365 internal instrumentation (the contrib LangChain package is skeleton-only with no functionality)
- Do NOT depend on `@opentelemetry/instrumentation-openai` or other contrib GenAI packages until they are brought up to parity with semantic conventions and have real functionality
- Do NOT include Traceloop instrumentations (these use the `opentelemetry` namespace but are not official OpenTelemetry contrib packages)
- Do NOT include Arize instrumentations as direct dependencies
- Add Microsoft-specific observability extensions for agent workloads
- Standard Node.js instrumentations (Express, Fastify, http, undici, etc.) are provided by the in-repo Azure Monitor code — do NOT reimplement them in a separate layer
- Decide whether GenAI instrumentations are hard dependencies or optional peer dependencies
- Make instrumentation enablement explicit and debuggable

### In-Repo GenAI Instrumentations

All GenAI instrumentations will be hosted in this repository, sourced primarily from A365's existing working implementations. This is a pragmatic decision driven by the state of the JS ecosystem:

- **OpenTelemetry JS contrib GenAI packages are outdated** — they lag significantly behind the Python equivalents in functionality and semantic convention compliance
- **LangChain contrib is skeleton-only** — no usable instrumentation exists in the JS contrib repo
- **A365 has working instrumentations** — battle-tested in production agent observability scenarios

Instrumentations to host in-repo:

1. **OpenAI instrumentation** — based on A365 internal implementation, following GenAI semantic conventions
2. **OpenAI Agents SDK instrumentation** — based on A365 internal implementation
3. **LangChain instrumentation** — based on A365 internal implementation, supplemented by Azure LangChain SDK observability hooks

Design guidelines:

- Follow OpenTelemetry GenAI semantic conventions so the output is compatible with any OTel-compliant backend
- Structure the code as standard OpenTelemetry instrumentors (implement `InstrumentationBase`) so they can be swapped out cleanly
- Keep instrumentations in clearly marked internal modules (e.g., `_openai/`, `_langchain/`) with explicit documentation that they are hosted temporarily
- When the upstream OpenTelemetry JS contrib GenAI packages reach functional parity, migrate to them and deprecate the in-repo versions
- Track upstream contrib progress and maintain a checklist of gaps for each instrumentation


## Phase 6: A365 Convergence

A365 observability is consumed as **npm package dependencies**, not vendored code. The distro depends on:

- `@microsoft/agents-a365-observability` — scopes, constants, contracts, baggage, context propagation, `ObservabilityManager`/`Builder`, exporter, and span processors
- `@microsoft/agents-a365-runtime` — `ClusterCategory` enum, configuration infrastructure, `IConfigurationProvider`

### Integration Approach

The distro's `useMicrosoftOpenTelemetry()` function creates the OpenTelemetry `NodeSDK` first, then calls `ObservabilityManager.start()` which detects the existing global `TracerProvider` and adds A365's baggage-enricher + exporter processors without creating a second SDK instance. This is the same approach used by `agents-a365-observability-hosting`.

Key integration points:

- **`A365Options` interface** — defined in `src/types.ts` as the distro's own public configuration surface. Maps to the npm package's `BuilderOptions` internally.
- **Environment variable bridge** — the distro sets `ENABLE_A365_OBSERVABILITY_EXPORTER`, `ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT`, and `A365_OBSERVABILITY_DOMAIN_OVERRIDE` programmatically from `A365Options` before calling `ObservabilityManager.start()`.
- **Config provider** — when `domainOverride` or `authScopes` are specified, the distro creates a custom `IConfigurationProvider<ObservabilityConfiguration>` and passes it to the builder.
- **Re-exports** — `src/index.ts` re-exports the public API surface from the npm packages (scopes, constants, enums, context propagation, baggage, message utilities, types) so consumers import from `@microsoft/opentelemetry`.

### What is NOT in scope

The following `agent365-nodejs` packages are **not included** because they are not telemetry/observability concerns:

- `agents-a365-runtime` — consumed only for `ClusterCategory` and `IConfigurationProvider`; the full runtime (auth service, API discovery, operation types) is out of scope
- `agents-a365-tooling` — MCP tool server configuration, not telemetry
- `agents-a365-notifications` — agent notification handling, not telemetry

### Hosting Integration (agents-a365-observability-hosting)

The `agents-a365-observability-hosting` package provides middleware and utilities for integrating A365 observability into Microsoft Bot Framework / Agents hosting environments. This is an **optional add-on** that will be consumed as an npm dependency when needed:

- `@microsoft/agents-a365-observability-hosting` — `BaggageMiddleware`, `OutputLoggingMiddleware`, `ObservabilityHostingManager`, `BaggageBuilderUtils`, `ScopeUtils`

This package requires `@microsoft/agents-hosting` as a peer dependency. The distro will re-export hosting utilities when the hosting package is available, but will not hard-depend on it to avoid pulling in the full agents-hosting stack for non-hosting scenarios.

### Extension Packages

GenAI-specific extension packages from the A365 ecosystem are handled in Phase 5 (GenAI instrumentation), not here:

- `agents-a365-observability-extensions-langchain` — LangChain instrumentation extensions
- `agents-a365-observability-extensions-openai` — OpenAI instrumentation extensions

## Phase 7: Testing

- Unit tests for configuration parsing and defaults
- Unit tests for exporter and instrumentation enablement combinations
- Tests for environment-variable driven setup
- Tests for missing optional dependencies and graceful failures
- Smoke tests for the public import path and basic configuration call

## Phase 8: Documentation and Sample Apps

- Add quick start examples for Azure Monitor only, OTLP only, and combined setups
- Document supported parameters and environment variables
- Document optional dependency groups if peer dependencies are used
- Document troubleshooting for missing dependencies and duplicate instrumentation
- Add migration guidance from manual OpenTelemetry setup

### Sample Applications

Provide runnable sample apps covering the main scenarios:

- **Azure Monitor + Web App** — Express or Fastify app exporting to Azure Monitor (traces, metrics, logs)
- **OTLP + Web App** — Web app exporting via OTLP to a local collector or backend
- **Azure Monitor + OTLP combined** — Dual-export setup showing both backends simultaneously
- **OpenAI Agents** — App using OpenAI Agents SDK with agent observability enabled
- **LangChain** — App using LangChain with the internal instrumentation
- **A365 agent workload** — Sample demonstrating A365 exporter, Microsoft Agent Framework instrumentation, and baggage extensions
- **GenAI multi-framework** — App combining multiple GenAI instrumentations (e.g., OpenAI + LangChain)

## Phase 9: External Instrumentation Normalization

- Define a normalization layer that can consume telemetry from third-party GenAI instrumentations (Traceloop, Arize, etc.) and align it to the expected semantic conventions
- Map external instrumentation span attributes and naming to OpenTelemetry GenAI semantic conventions
- Provide adapters or processors that normalize non-standard telemetry without taking a direct dependency on external instrumentation packages
- Document which external instrumentations are supported for normalization and any known gaps

## A365 Integration Status

A365 observability is consumed via npm packages. The gap analysis below reflects what is integrated vs. what remains.

### agents-a365-observability (core) — ✅ Integrated

Consumed as `@microsoft/agents-a365-observability` npm dependency. All core observability features are available:

| Feature | Status |
|---------|--------|
| Scopes (OpenTelemetryScope, InvokeAgentScope, etc.) | ✅ Re-exported |
| Constants (OpenTelemetryConstants) | ✅ Re-exported |
| Enums (MessageRole, FinishReason, InferenceOperationType) | ✅ Re-exported |
| Context propagation (runWithParentSpanRef, etc.) | ✅ Re-exported |
| Baggage (BaggageBuilder, BaggageScope) | ✅ Re-exported |
| Token context (runWithExportToken, etc.) | ✅ Re-exported |
| Message utilities (serializeMessages, etc.) | ✅ Re-exported |
| ObservabilityManager / Builder | ✅ Integrated in distro.ts |
| Agent365Exporter | ✅ Internal to npm package |
| A365SpanProcessor | ✅ Internal to npm package |
| PerRequestSpanProcessor | ✅ Internal to npm package |
| ObservabilityConfiguration | ✅ Used for domainOverride/authScopes |

### agents-a365-runtime — ✅ Partially Integrated

Consumed as `@microsoft/agents-a365-runtime` npm dependency. Only telemetry-relevant exports are used:

| Feature | Status |
|---------|--------|
| ClusterCategory enum | ✅ Re-exported |
| IConfigurationProvider | ✅ Used internally |
| PowerPlatformApiDiscovery | ⬜ Not needed (not telemetry) |
| AgenticAuthenticationService | ⬜ Not needed (not telemetry) |
| RuntimeConfiguration | ⬜ Not needed (not telemetry) |

### agents-a365-observability-hosting — ⬜ Not yet integrated

Will be consumed as `@microsoft/agents-a365-observability-hosting` npm dependency. Requires `@microsoft/agents-hosting` peer dependency.

| Feature | Status |
|---------|--------|
| ObservabilityHostingManager | ⬜ Pending |
| BaggageMiddleware | ⬜ Pending |
| OutputLoggingMiddleware | ⬜ Pending |
| BaggageBuilderUtils | ⬜ Pending |
| ScopeUtils | ⬜ Pending |

### Out of Scope Packages

These packages are **not telemetry** and will not be integrated:

| Package | Reason |
|---------|--------|
| `agents-a365-tooling` | MCP tool server configuration |
| `agents-a365-notifications` | Agent notification handling |
| `agents-a365-tooling-extensions-*` | Tooling extensions (Claude, LangChain, OpenAI) |

### Extension Packages — Handled in Phase 5

| Package | Status |
|---------|--------|
| `agents-a365-observability-extensions-langchain` | Handled via in-repo GenAI instrumentation |
| `agents-a365-observability-extensions-openai` | Handled via in-repo GenAI instrumentation |
