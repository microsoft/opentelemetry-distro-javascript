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

The A365 observability runtime will be **migrated as code into this repository**, not consumed as an npm dependency. This includes the A365 exporter, custom processors, and all relevant observability extensions.

### A365 Code to Migrate In-Repo

- **A365 exporter** — integrate into the distro configuration surface as an in-repo module
- **Microsoft Agent Framework instrumentation** — instrumentation for Microsoft's internal agent framework, brought in as source code
- **Baggage extensions** — A365 baggage propagation and enrichment extensions
- **Custom span processors** — processors required by A365 agent observability scenarios
- **Other internal observability extensions** — any remaining A365 runtime components needed for agent workloads

### Migration and Convergence Plan

- Migrate A365 observability runtime code under a clearly defined internal module boundary (e.g., `_a365/`)
- A365 GenAI instrumentations (OpenAI, OpenAI Agents, LangChain) are migrated in Phase 5 — coordinate with the A365 team to keep them aligned
- Audit migrated A365 instrumentations and determine which can be contributed to upstream OpenTelemetry contrib
- For instrumentations that have OpenTelemetry equivalents, plan migration path and deprecation timeline
- For instrumentations with no upstream equivalent (e.g., Microsoft Agent Framework), keep as Microsoft-specific extensions in this repo and evaluate contributing them to OpenTelemetry
- Validate that existing A365 telemetry pipelines continue to work under the new distro setup with the in-repo code
- Coordinate with the A365 team on dual maintenance during the transition period (similar to the Azure Monitor Distro approach)

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

## TODO: A365 Gap Analysis (agent365-nodejs parity)

Comparison of our in-repo A365 code against the full `agent365-nodejs` SDK. Items marked ✅ are implemented; ❌ items need to be built.

### agents-a365-observability (core) — Gaps

| File | Description | Status |
|------|-------------|--------|
| `PerRequestSpanProcessorConfiguration.ts` | Dedicated config for per-request processor | ❌ Missing |
| `PerRequestSpanProcessorConfigurationOptions.ts` | Options interface for above | ❌ Missing |
| `PerRequestProcessorInternalOverrides.ts` | Internal overrides for per-request processor | ❌ Missing |
| `trace-context-propagation.ts` | Distributed tracing context propagation | ❌ Missing |
| `ObservabilityBuilder.ts` | Builder pattern for observability setup | ❌ Missing |
| `ObservabilityManager.ts` | Lifecycle manager for observability | ❌ Missing |
| `utils/logging.ts` | ILogger event helpers | ❌ Missing |
| `util.ts` (root tracing) | May differ from our `exporter/utils.ts` / `processors/util.ts` | ⚠️ Review |

### agents-a365-observability-hosting (entire package missing)

| File | Description | Status |
|------|-------------|--------|
| `middleware/ObservabilityHostingManager.ts` | Hosting lifecycle manager | ❌ Missing |
| `middleware/BaggageMiddleware.ts` | HTTP baggage middleware | ❌ Missing |
| `middleware/OutputLoggingMiddleware.ts` | Output logging middleware | ❌ Missing |
| `utils/BaggageBuilderUtils.ts` | Baggage builder utilities | ❌ Missing |
| `utils/ScopeUtils.ts` | Scope utility helpers | ❌ Missing |
| `utils/TurnContextUtils.ts` | Turn context utilities | ❌ Missing |
| `caching/AgenticTokenCache.ts` | Agentic token cache | ❌ Missing |

### agents-a365-runtime (entire package missing)

| File | Description | Status |
|------|-------------|--------|
| `environment-utils.ts` | Environment utilities | ❌ Missing |
| `power-platform-api-discovery.ts` | Power Platform API discovery | ❌ Missing |
| `agentic-authorization-service.ts` | Agentic authorization service | ❌ Missing |
| `operation-error.ts` | Operation error types | ❌ Missing |
| `operation-result.ts` | Operation result types | ❌ Missing |
| `utility.ts` | General utilities | ❌ Missing |
| `configuration/` | Config provider | ❌ Missing |

### agents-a365-tooling (entire package missing)

| File | Description | Status |
|------|-------------|--------|
| `McpToolServerConfigurationService.ts` | MCP tool server configuration | ❌ Missing |
| `contracts.ts` | Tooling contracts | ❌ Missing |
| `Utility.ts` | Tooling utilities | ❌ Missing |
| `configuration/` | Tooling configuration | ❌ Missing |
| `models/` | Tooling models | ❌ Missing |

### agents-a365-notifications (entire package missing)

| File | Description | Status |
|------|-------------|--------|
| `agent-notification.ts` | Agent notification handler | ❌ Missing |
| `constants.ts` | Notification constants | ❌ Missing |
| `extensions/` | Notification extensions | ❌ Missing |
| `models/` | Notification models | ❌ Missing |

### Extension packages (all missing)

| Package | Status |
|---------|--------|
| `agents-a365-observability-extensions-langchain` | ❌ Missing |
| `agents-a365-observability-extensions-openai` | ❌ Missing |
| `agents-a365-tooling-extensions-claude` | ❌ Missing |
| `agents-a365-tooling-extensions-langchain` | ❌ Missing |
| `agents-a365-tooling-extensions-openai` | ❌ Missing |

### Priority Order

1. **Core observability gaps** — `trace-context-propagation`, `PerRequestSpanProcessorConfiguration*`, `ObservabilityBuilder/Manager`, `utils/logging`
2. **Hosting middleware** — `ObservabilityHostingManager`, baggage/output middleware, scope utils
3. **Runtime** — env utils, API discovery, auth service
4. **Tooling** — MCP tool server config
5. **Notifications** — agent notifications
6. **Extension packages** — langchain/openai/claude integrations
