# A365 Integration Implementation Plan

## Overview

This document details the plan for migrating the A365 observability runtime from `microsoft/Agent365-nodejs` into the Microsoft OpenTelemetry JavaScript distro (`@microsoft/opentelemetry`). Per PLANNING.md Phase 6 (A365 Convergence), A365 code is **migrated as source** — not consumed as an npm dependency — under a clearly defined internal module boundary (`_a365/`).

This plan covers both **Phase 5 (GenAI Instrumentations)** and **Phase 6 (A365 Convergence)** from PLANNING.md. The GenAI instrumentations (OpenAI, OpenAI Agents SDK, LangChain) are Phase 5 deliverables but are sourced from A365's existing implementations, so they are coordinated here. The core A365 infrastructure (exporter, processors, scopes, hosting) is Phase 6.

Phases 1–4 are now substantially complete:
- ~~**Phase 1 (Package Foundation):** Published as `@microsoft/opentelemetry`, with ESLint, Vitest, and CI configured.~~
- **Phase 2 (Configuration Surface):** `MicrosoftOpenTelemetryOptions` is defined in `src/distro/types.ts` with a backend-scoped pattern (`azureMonitor?: AzureMonitorOpenTelemetryOptions`). The A365 scope (`a365?: A365Options`) follows this established pattern. Per PLANNING.md, A365-scoped configuration includes: A365 exporter endpoint, baggage extensions, Microsoft Agent Framework instrumentation toggles, and A365-specific span processors.
- **Phase 3 (Azure Monitor Migration):** Azure Monitor distro code has been fully migrated in-repo under `src/` (traces, metrics, logs, browser SDK loader, statsbeat, etc.).
- **Phase 4 (Core OTel Setup):** `useMicrosoftOpenTelemetry()` in `src/distro/distro.ts` orchestrates NodeSDK creation with Azure Monitor handlers. The entry point has explicit `// TODO` placeholders for OTLP and A365 integration.

This plan builds on the established architecture.
---

## Source Packages (Agent365-nodejs)

The following packages from [`microsoft/Agent365-nodejs/packages/`](https://github.com/microsoft/Agent365-nodejs/tree/main/packages) are in scope for migration:

| Package | Purpose | Key Files |
|---------|---------|-----------|
| `agents-a365-observability` | Core observability SDK — exporter, span processors, scopes, context propagation, configuration, constants/contracts | `ObservabilityBuilder.ts`, `ObservabilityManager.ts`, `configuration/`, `tracing/`, `internal/`, `utils/` |
| `agents-a365-observability-hosting` | Hosting integration — middleware, token caching, baggage propagation | `middleware/`, `caching/`, `utils/` |
| `agents-a365-observability-extensions-openai` | OpenAI Agents SDK instrumentation | `OpenAIAgentsTraceInstrumentor.ts`, `OpenAIAgentsTraceProcessor.ts`, `Constants.ts`, `Utils.ts`, `configuration/` |
| `agents-a365-observability-extensions-langchain` | LangChain instrumentation via callback handler patching | `LangChainTraceInstrumentor.ts`, `tracer.ts`, `Utils.ts` |
| `agents-a365-runtime` | Runtime configuration utilities (partial — only what observability depends on) | `environment-utils.ts`, `configuration/`, `ClusterCategory` |

---

## Target Module Structure

All A365 code lives under `src/_a365/` with clear internal module boundaries. GenAI instrumentations (Phase 5) live in separate top-level internal modules (`_openai/`, `_langchain/`) per PLANNING.md convention, but are sourced from A365's existing implementations and coordinated here. The setup orchestrator follows the established pattern of `src/azureMonitorSetup.ts` (a top-level setup helper called from `src/distro/distro.ts`):

```
src/
├── index.ts                          # Re-exports from distro; backward-compat useAzureMonitor()
├── distro/
│   ├── distro.ts                     # useMicrosoftOpenTelemetry() entry point — calls a365Setup
│   ├── types.ts                      # MicrosoftOpenTelemetryOptions (a365 scope here)
│   └── index.ts                      # Barrel export for distro
├── azureMonitorSetup.ts              # Azure Monitor setup helper (existing)
├── a365Setup.ts                      # A365 setup orchestrator (wires _a365/ into providers)
│
├── _a365/                            # Internal A365 module boundary (Phase 6)
│   ├── index.ts                      # Internal barrel export
│   │
│   ├── configuration/
│   │   ├── A365Configuration.ts      # From ObservabilityConfiguration + RuntimeConfiguration
│   │   └── A365ConfigurationOptions.ts
│   │
│   ├── exporter/
│   │   ├── Agent365Exporter.ts       # Custom SpanExporter → A365 service
│   │   └── Agent365ExporterOptions.ts
│   │
│   ├── processors/
│   │   ├── PerRequestSpanProcessor.ts  # Buffers spans per trace, exports on root completion
│   │   ├── SpanProcessor.ts            # Generic span processing
│   │   └── BaggageSpanProcessor.ts     # Copies baggage items to span attributes
│   │
│   ├── scopes/
│   │   ├── OpenTelemetryScope.ts       # Base span scope (Disposable)
│   │   ├── InvokeAgentScope.ts         # Agent invocation spans
│   │   ├── ExecuteToolScope.ts         # Tool execution spans
│   │   ├── InferenceScope.ts           # LLM inference spans
│   │   └── OutputScope.ts             # Output message spans
│   │
│   ├── context/
│   │   ├── tokenContext.ts             # runWithExportToken / getExportToken
│   │   ├── parentSpanContext.ts         # ParentSpanRef, manual parent linking
│   │   └── traceContextPropagation.ts  # W3C traceparent inject/extract
│   │
│   ├── contracts/
│   │   ├── messages.ts                 # ChatMessage, InputMessages, OutputMessages
│   │   ├── details.ts                  # AgentDetails, UserDetails, SpanDetails
│   │   └── types.ts                    # MessageRole, MessagePart union types
│   │
│   ├── constants.ts                    # OpenTelemetryConstants (semantic attribute keys)
│   │
│   ├── hosting/
│   │   ├── BaggageMiddleware.ts
│   │   ├── OutputLoggingMiddleware.ts
│   │   ├── ObservabilityHostingManager.ts
│   │   └── AgenticTokenCache.ts
│   │
│   ├── instrumentations/
│   │   └── MicrosoftAgentFrameworkInstrumentation.ts  # Microsoft Agent Framework instrumentation
│   │
│   └── utils/
│       ├── baggageBuilder.ts
│       ├── scopeUtils.ts
│       └── logger.ts
│
├── _openai/                          # OpenAI GenAI instrumentations (Phase 5 — sourced from A365)
│   ├── OpenAIAgentsTraceInstrumentor.ts
│   ├── OpenAIAgentsTraceProcessor.ts
│   ├── Constants.ts
│   ├── Utils.ts
│   └── configuration/
│       └── OpenAIObservabilityConfiguration.ts
│
└── _langchain/                       # LangChain GenAI instrumentations (Phase 5 — sourced from A365)
    ├── LangChainTraceInstrumentor.ts
    ├── tracer.ts
    └── Utils.ts
```

---

## Implementation Tasks

### Task 1: Migrate A365 Configuration Layer

**Source:** `agents-a365-observability/src/configuration/` + `agents-a365-runtime/src/configuration/`

**Work:**
- Create `_a365/configuration/A365Configuration.ts` — merge `ObservabilityConfiguration` and the runtime config it extends
- Extract only the config properties needed by observability (drop runtime-only concerns like authorization service, Power Platform API discovery)
- Define `A365ConfigurationOptions` interface for the distro's public `a365` config scope
- Map environment variables to the distro convention:

| A365 Original Env Var | Distro Env Var |
|----------------------|----------------|
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | `MICROSOFT_OTEL_A365_EXPORTER_ENABLED` |
| `ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT` | `MICROSOFT_OTEL_A365_PER_REQUEST_EXPORT` |
| `A365_OBSERVABILITY_SCOPES_OVERRIDE` | `MICROSOFT_OTEL_A365_AUTH_SCOPES` |
| `A365_OBSERVABILITY_DOMAIN_OVERRIDE` | `MICROSOFT_OTEL_A365_DOMAIN` |
| `A365_OBSERVABILITY_LOG_LEVEL` | `MICROSOFT_OTEL_A365_LOG_LEVEL` |
| `AGENT_CLUSTER_CATEGORY` | `MICROSOFT_OTEL_A365_CLUSTER_CATEGORY` |

- Integrate into the distro's `src/distro/types.ts` as the `a365` scope (following the established `azureMonitor` scoping pattern):

```typescript
// In src/distro/types.ts
export interface MicrosoftOpenTelemetryOptions {
  // ── Global options (already defined) ──
  resource?: Resource;
  samplingRatio?: number;
  tracesPerSecond?: number;
  instrumentationOptions?: InstrumentationOptions;
  logRecordProcessors?: LogRecordProcessor[];
  spanProcessors?: SpanProcessor[];
  metricReaders?: MetricReader[];
  views?: ViewOptions[];

  // ── Backend-scoped options ──
  azureMonitor?: AzureMonitorOpenTelemetryOptions;  // (already defined)
  a365?: A365Options;                                // NEW
}

export interface A365Options {
  enabled?: boolean;
  tokenResolver?: (agentId: string, tenantId: string) => string | Promise<string>;
  clusterCategory?: 'prod' | 'preprod';
  domainOverride?: string;
  authScopes?: string[];
  perRequestExport?: boolean;
  exporterOptions?: Partial<Agent365ExporterOptions>;
  logLevel?: 'none' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';
  baggage?: {
    propagationEnabled?: boolean;        // Enable baggage propagation middleware
    enrichSpans?: boolean;               // Copy baggage items to span attributes
  };
  instrumentations?: {
    openaiAgents?: boolean | OpenAIObservabilityConfiguration;
    langchain?: boolean | LangChainObservabilityConfiguration;
    microsoftAgentFramework?: boolean;   // Microsoft Agent Framework instrumentation
  };
  hosting?: {
    enabled?: boolean;                   // Enable hosting middleware (requires @microsoft/agents-hosting)
  };
}
```

**Depends on:** Phase 2 configuration surface (now complete — `MicrosoftOpenTelemetryOptions` with backend scoping is established in `src/distro/types.ts`)

---

### Task 2: Migrate Agent365 Exporter

**Source:** `agents-a365-observability/src/tracing/exporter/`

**Work:**
- Copy `Agent365Exporter.ts` and `Agent365ExporterOptions.ts` into `_a365/exporter/`
- The exporter implements `SpanExporter` from `@opentelemetry/sdk-trace-base`
- Key behavior to preserve:
  - Span partitioning by `(tenantId, agentId)` tuples
  - OTLP-like JSON payload construction (`resourceSpans → scopeSpans → spans`)
  - Dual endpoint styles: `/observability/...` and `/observabilityService/...` (S2S)
  - Token resolution: batch export via `tokenResolver()`, per-request via context `getExportToken()`
  - Automatic retry with exponential backoff
  - HTTP request timeout support
- **Adaptation:** Replace dependency on `agents-a365-runtime` config with the distro's `A365Configuration`
- **Adaptation:** Replace internal logger with distro's logging approach (`Logger` from `src/shared/logging/`)
- Add new dependency: native `fetch` (Node 18+) or `undici` for HTTP — check what the exporter currently uses

**Depends on:** Task 1

---

### Task 3: Migrate Span Processors

**Source:** `agents-a365-observability/src/tracing/`

**Work:**
- Copy `PerRequestSpanProcessor.ts` → `_a365/processors/PerRequestSpanProcessor.ts`
  - Buffers spans per traceId in `Map<traceId, TraceBuffer>`
  - Waits for root span to end + all children to complete
  - Grace period timeout for stuck spans
  - Concurrent export limiting
  - Stores OpenTelemetry Context for token retrieval at export time
- Copy `SpanProcessor.ts` → `_a365/processors/SpanProcessor.ts`
- Copy baggage builder → `_a365/processors/BaggageSpanProcessor.ts`
  - Extracts OTel baggage from context, copies to span attributes
- **Adaptation:** These implement `SpanProcessor` from `@opentelemetry/sdk-trace-base` — wire them into the distro's provider setup via `src/a365Setup.ts`
- The processor chain order must be preserved:
  1. BaggageSpanProcessor (enriches spans with baggage attributes)
  2. SpanProcessor (generic processing)
  3. PerRequestSpanProcessor or BatchSpanProcessor (export)

**Depends on:** Task 2

---

### Task 4: Migrate Scopes & Contracts

**Source:** `agents-a365-observability/src/tracing/scopes/` + `agents-a365-observability/src/tracing/contracts.ts` + `agents-a365-observability/src/tracing/constants.ts`

**Work:**
- Copy scope hierarchy into `_a365/scopes/`:
  - `OpenTelemetryScope` — base class with `Disposable`/`Symbol.dispose`, wraps OTel spans
  - `InvokeAgentScope` — agent invocation
  - `ExecuteToolScope` — tool execution
  - `InferenceScope` — LLM inference
  - `OutputScope` — output recording
- Copy contracts into `_a365/contracts/`:
  - `MessageRole` enum: system, user, assistant, tool
  - `MessagePart` union: TextPart, ToolCallRequestPart, ToolCallResponsePart, ReasoningPart, BlobPart, FilePart, UriPart, etc.
  - `ChatMessage`, `InputMessages`, `OutputMessages`
  - `AgentDetails`, `UserDetails`, `SpanDetails`
- Copy `OpenTelemetryConstants` into `_a365/constants.ts`:
  - Gen AI semantic convention attribute keys (`gen_ai.agent.id`, `gen_ai.agent.name`, etc.)
  - Microsoft-specific attributes (`microsoft.a365.caller.agent.*`, `microsoft.tenant.id`)
  - Tool/inference/message attributes
- **Decision needed:** Scopes are the primary public API surface for A365 consumers building agent frameworks — decide whether to re-export from the distro's top-level `index.ts` or keep internal

**Depends on:** Task 1

---

### Task 5: Migrate Context Propagation

**Source:** `agents-a365-observability/src/tracing/context/`

**Work:**
- Copy `token-context.ts` → `_a365/context/tokenContext.ts`
  - `runWithExportToken(token, callback)` — stores token in OTel context
  - `getExportToken()` — retrieves token from active context
  - `updateExportToken(token)` — updates token
- Copy `parent-span-context.ts` → `_a365/context/parentSpanContext.ts`
  - `ParentSpanRef` type (traceId, spanId)
  - `runWithParentSpanRef()` / `createContextWithParentSpanRef()`
- Copy `trace-context-propagation.ts` → `_a365/context/traceContextPropagation.ts`
  - W3C traceparent inject/extract to/from HTTP headers
- **Note:** These use `@opentelemetry/api` context APIs — no adaptation needed beyond import paths

**Depends on:** None (standalone utilities)

---

### Task 6: Migrate OpenAI Agents Instrumentation

**Source:** `agents-a365-observability-extensions-_openai/src/`

**Work:**
- Per PLANNING.md Phase 5, GenAI instrumentations go into clearly marked internal modules
- Copy into `src/_openai/` (separate from `_a365/` per PLANNING.md convention):
  - `OpenAIAgentsTraceInstrumentor.ts` — extends `InstrumentationBase`, targets `@_openai/agents >= 0.1.5`
  - `OpenAIAgentsTraceProcessor.ts` — implements OpenAI's `TracingProcessor` interface
  - `Constants.ts` — OpenAI-specific constants
  - `Utils.ts` — OpenAI utilities
  - `configuration/OpenAIObservabilityConfiguration.ts`
- Key behavior:
  - `enable()` → gets tracer, creates processor, calls OpenAI's `setTraceProcessors([processor])`
  - Config options: `suppressInvokeAgentInput`, `isContentRecordingEnabled`
  - Maps OpenAI agent events to A365 scope types (InvokeAgent, ExecuteTool, Inference, Output)
- **Adaptation:** Replace `@microsoft/agents-a365-observability` imports with `../_a365/` imports
- **Adaptation:** Replace `@microsoft/agents-a365-runtime` imports with distro config
- **Dependency:** `@_openai/agents` as optional peer dependency
- Wire into distro config: `a365.instrumentations.openaiAgents`

**Depends on:** Task 4 (scopes/contracts)

---

### Task 7: Migrate LangChain Instrumentation

**Source:** `agents-a365-observability-extensions-_langchain/src/`

**Work:**
- Copy into `src/_langchain/` (separate from `_a365/` per PLANNING.md convention):
  - `LangChainTraceInstrumentor.ts` — singleton instrumentor
  - `tracer.ts` — `LangChainTracer` implementing LangChain callback handler
  - `Utils.ts` — LangChain utilities
- Key behavior:
  - Patches `@_langchain/core/callbacks/manager.CallbackManager._configureSync()`
  - Injects `LangChainTracer` into callback handlers
  - Listens to `on_chain_start`, `on_chain_end`, `on_tool_start`, etc.
  - Creates/manages spans for chain invocations and tool calls
  - Config: `isContentRecordingEnabled`
- **Adaptation:** Replace `@microsoft/agents-a365-observability` imports with `../_a365/` imports
- **Dependency:** `@_langchain/core` as optional peer dependency
- Wire into distro config: `a365.instrumentations.langchain`

**Depends on:** Task 4 (scopes/contracts)

---

### Task 8: Migrate Hosting Integration

**Source:** `agents-a365-observability-hosting/src/`

**Work:**
- Copy into `_a365/hosting/`:
  - `AgenticTokenCache.ts` — TTL-based token caching for A365 service authentication
  - `BaggageMiddleware.ts` — propagates baggage from request headers to span context
  - `OutputLoggingMiddleware.ts` — records output, injects parent span info into response headers
  - `ObservabilityHostingManager.ts` — lifecycle management in hosting environments
  - `BaggageBuilderUtils.ts`, `ScopeUtils.ts`, `TurnContextUtils.ts`
- **Adaptation:** Replace `@microsoft/agents-hosting` dependency:
  - Evaluate whether hosting middleware should be directly included or behind a feature flag
  - The hosting package depends on `@microsoft/agents-hosting` (Microsoft Agent Framework) — this is a tight coupling
  - **Option A:** Keep hosting code but make `@microsoft/agents-hosting` an optional peer dependency
  - **Option B:** Defer hosting integration until the distro has a hosting story
- **Recommendation:** Option A — migrate the code, gate behind `a365.hosting.enabled` config flag, declare `@microsoft/agents-hosting` as optional peer dependency

**Depends on:** Tasks 1, 3, 5

---

### Task 8b: Migrate Microsoft Agent Framework Instrumentation

**Source:** Microsoft Agent Framework internal instrumentation code (from A365 observability extensions or hosting package)

Per PLANNING.md Phase 6: *"Microsoft Agent Framework instrumentation — instrumentation for Microsoft's internal agent framework, brought in as source code."* This is a Microsoft-specific instrumentation with no upstream OpenTelemetry equivalent.

**Work:**
- Create `_a365/instrumentations/MicrosoftAgentFrameworkInstrumentation.ts`
- Implement as a standard OpenTelemetry instrumentor (extend `InstrumentationBase`) so it follows the same pattern as the GenAI instrumentations
- Auto-instrument Microsoft Agent Framework lifecycle events (agent creation, turn processing, activity handling) into OpenTelemetry spans
- Use semantic attribute keys from `_a365/constants.ts` (e.g., `microsoft.a365.caller.agent.*`)
- **Dependency:** `@microsoft/agents-hosting` as optional peer dependency (shared with Task 8)
- Wire into distro config: `a365.instrumentations.microsoftAgentFramework`
- Per PLANNING.md: *"For instrumentations with no upstream equivalent (e.g., Microsoft Agent Framework), keep as Microsoft-specific extensions in this repo and evaluate contributing them to OpenTelemetry"* — document this as a long-term contribution candidate

**Depends on:** Tasks 1, 4 (scopes/contracts)

---

### Task 9: Create A365 Setup Orchestrator

**Source:** New code — `src/a365Setup.ts`

**Work:**
- This is the glue that wires `_a365/` modules into the distro's provider setup
- Follows the established pattern of `src/azureMonitorSetup.ts` (a helper function called from `src/distro/distro.ts`)
- Replace `ObservabilityBuilder` and `ObservabilityManager` with distro-native setup:

```typescript
// src/a365Setup.ts
import type { A365Options } from "./distro/types.js";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Set up A365 observability components.
 * Returns span processors to be registered with the NodeSDK,
 * and a dispose callback for shutdown.
 */
export function setupA365Components(
  options: A365Options,
): { spanProcessors: SpanProcessor[]; dispose: () => void } {
  if (!options.enabled) return { spanProcessors: [], dispose: () => {} };

  const config = resolveA365Configuration(options);

  // 1. Create the Agent365 exporter
  const exporter = new Agent365Exporter({
    tokenResolver: options.tokenResolver,
    clusterCategory: config.clusterCategory,
    domainOverride: config.domainOverride,
    // ...
  });

  // 2. Create span processor chain
  const processors: SpanProcessor[] = [];

  if (options.baggage?.enrichSpans !== false) {
    processors.push(new BaggageSpanProcessor());
  }

  const exportProcessor = options.perRequestExport
    ? new PerRequestSpanProcessor(exporter, config)
    : new BatchSpanProcessor(exporter, config);
  processors.push(exportProcessor);

  // 3. Register GenAI instrumentations if configured
  if (options.instrumentations?.openaiAgents) {
    const openaiConfig = typeof options.instrumentations.openaiAgents === 'object'
      ? options.instrumentations.openaiAgents
      : {};
    const instrumentor = new OpenAIAgentsTraceInstrumentor(openaiConfig);
    instrumentor.enable();
  }

  if (options.instrumentations?.langchain) {
    const langchainConfig = typeof options.instrumentations.langchain === 'object'
      ? options.instrumentations.langchain
      : {};
    LangChainTraceInstrumentor.instrument(langchainConfig);
  }

  // 4. Register Microsoft Agent Framework instrumentation if configured
  if (options.instrumentations?.microsoftAgentFramework) {
    const mafInstrumentor = new MicrosoftAgentFrameworkInstrumentation();
    mafInstrumentor.enable();
  }

  return {
    spanProcessors: processors,
    dispose: () => { /* cleanup */ },
  };
}
```

- Integration in `src/distro/distro.ts` follows the existing pattern:

```typescript
// In useMicrosoftOpenTelemetry():
import { setupA365Components } from "../a365Setup.js";

// After Azure Monitor setup, before NodeSDK creation:
const a365 = options?.a365 ? setupA365Components(options.a365) : undefined;

const sdkConfig: Partial<NodeSDKConfiguration> = {
  // ...existing config...
  spanProcessors: [
    traceHandler.getAzureMonitorSpanProcessor(),
    ...(a365?.spanProcessors ?? []),
    ...spanProcessors,
    traceHandler.getBatchSpanProcessor(),
  ],
};
```

- This replaces the A365 `ObservabilityBuilder.build().start()` pattern with the distro's `useMicrosoftOpenTelemetry({ a365: {...} })` flow
- A365 span processors are injected into the NodeSDK config alongside Azure Monitor processors
- The `dispose` callback is called during `shutdownMicrosoftOpenTelemetry()`
- Called from `useMicrosoftOpenTelemetry()` in `src/distro/distro.ts` (which already has a `// TODO` placeholder for A365)

**Depends on:** Tasks 1–8b

---

### Task 10: Testing

**Work:**
- Unit tests for each migrated module (maintain test parity with Agent365-nodejs):
  - `_a365/exporter/` — mock HTTP, verify payload format, retry behavior
  - `_a365/processors/` — verify buffering, grace period, concurrent export limits
  - `_a365/scopes/` — verify span attributes, lifecycle, disposable pattern
  - `_a365/context/` — verify context propagation, token storage/retrieval
  - `_a365/configuration/` — verify env var parsing, defaults, validation
  - `_a365/instrumentations/` — verify Microsoft Agent Framework instrumentation lifecycle
  - `_openai/` — mock `@_openai/agents`, verify trace processor registration
  - `_langchain/` — mock `@_langchain/core`, verify callback patching
  - `a365Setup.ts` — integration test for full A365 setup flow
- Use Vitest (confirmed — already configured in `vitest.config.ts` with tests under `test/`)
- Tests for missing optional peer dependencies (graceful failures when `@_openai/agents`, `@_langchain/core`, or `@microsoft/agents-hosting` not installed)
- Tests for disabled A365 scenario (no processors registered, no exporter created)
- **Telemetry pipeline validation** (per PLANNING.md Phase 6): Validate that existing A365 telemetry pipelines continue to work under the new distro setup with the in-repo code:
  - Verify span attribute fidelity: spans produced by the migrated code must have identical attributes, naming, and structure to those produced by the standalone `Agent365-nodejs` packages
  - Verify exporter payload compatibility: the JSON payloads sent to the A365 service endpoint must be wire-compatible
  - Verify processor chain ordering produces the same enrichment results
  - Verify context propagation (token context, parent span ref, W3C traceparent) works identically
  - Smoke test: run a representative agent workload through the distro and compare telemetry output with the same workload through the standalone A365 SDK

**Depends on:** Tasks 1–9

---

### Task 11: Dual Maintenance & Synchronization Process

Per PLANNING.md: *"Coordinate with the A365 team on dual maintenance during the transition period (similar to the Azure Monitor Distro approach)."*

**Work:**
- Establish a clear mapping between in-repo `_a365/` modules and their upstream counterparts in `Agent365-nodejs/packages/`:
  - `_a365/exporter/` ↔ `agents-a365-observability/src/tracing/exporter/`
  - `_a365/processors/` ↔ `agents-a365-observability/src/tracing/`
  - `_a365/scopes/` ↔ `agents-a365-observability/src/tracing/scopes/`
  - `_a365/context/` ↔ `agents-a365-observability/src/tracing/context/`
  - `_a365/hosting/` ↔ `agents-a365-observability-hosting/src/`
  - `_openai/` ↔ `agents-a365-observability-extensions-_openai/src/`
  - `_langchain/` ↔ `agents-a365-observability-extensions-_langchain/src/`
- Any bug fix applied to the in-repo code must also be backported to `Agent365-nodejs` (and vice versa) until the transition is complete
- Define a cutover milestone after which new features land only in this repository
- Existing users of the standalone A365 observability packages must not be broken — deprecation notices and migration guides will be provided before any removal
- Document the synchronization process in a CONTRIBUTING.md section or dedicated sync guide

**Depends on:** Task 9 (once orchestrator is integrated, dual maintenance begins)

---

### Task 12: Upstream Contribution Audit & Deprecation Tracking

Per PLANNING.md Phase 5 and Phase 6, the in-repo GenAI instrumentations are temporary — hosted here until upstream OpenTelemetry JS contrib packages reach functional parity.

**Work:**
- **Audit each migrated instrumentation** and classify:
  - **Has upstream OTel equivalent (outdated):** OpenAI instrumentation (`@opentelemetry/instrumentation-openai`), LangChain instrumentation — track upstream progress, plan migration when they reach parity
  - **No upstream equivalent:** Microsoft Agent Framework instrumentation — keep as Microsoft-specific, evaluate contributing to OpenTelemetry contrib
  - **A365-specific (no OTel equivalent):** Exporter, per-request processor, scopes, contracts — remain in-repo as Microsoft distro components
- **Create a gap checklist** for each GenAI instrumentation vs. its upstream counterpart:
  - Semantic convention compliance
  - Feature coverage (which events/operations are instrumented)
  - Configuration options
  - Production readiness and test coverage
- **Track upstream OTel JS contrib GenAI progress** — monitor repos for releases that close gaps
- **Plan deprecation timeline** for in-repo instrumentations once upstream packages are viable:
  - Announce deprecation with migration guide
  - Keep in-repo versions as fallback for one major version cycle
  - Remove after migration period
- **Phase 9 forward-look:** Per PLANNING.md Phase 9, a normalization layer for third-party GenAI instrumentations (Traceloop, Arize, etc.) will be needed to align non-standard telemetry to OTel GenAI semantic conventions. This task's gap checklist feeds into the normalization layer design.

**Depends on:** Tasks 6, 7, 8b

---

## Dependency Impact

### New Production Dependencies

| Dependency | Reason | Notes |
|------------|--------|-------|
| `@opentelemetry/sdk-trace-base` | SpanExporter, SpanProcessor interfaces | **Already present** from Azure Monitor migration |
| `@opentelemetry/resources` | Resource construction for exporter | **Already present** |
| `@opentelemetry/semantic-conventions` | Semantic convention constants | **Already present** |

### New Optional Peer Dependencies

| Dependency | Reason | Required When |
|------------|--------|---------------|
| `@_openai/agents` (>= 0.1.5) | OpenAI Agents SDK instrumentation | `a365.instrumentations.openaiAgents` enabled |
| `@_langchain/core` | LangChain instrumentation | `a365.instrumentations.langchain` enabled |
| `@microsoft/agents-hosting` | Hosting middleware + Microsoft Agent Framework instrumentation | `a365.hosting.enabled` or `a365.instrumentations.microsoftAgentFramework` enabled |

### Dependencies NOT Carried Over

| Dropped Dependency | Reason |
|-------------------|--------|
| `@microsoft/agents-a365-runtime` | Config and utilities absorbed into `_a365/configuration/` — only the parts needed by observability |
| `@opentelemetry/sdk-node` | Distro manages NodeSDK at the top level, not inside A365 module |
| `@opentelemetry/exporter-trace-otlp-http` | A365 exporter uses its own HTTP transport, not the OTLP exporter |

---

## Public API Surface

### Exported from `@microsoft/opentelemetry` (Top-Level)

These A365 types should be re-exported from the distro's `src/distro/index.ts` barrel (which is then re-exported by `src/index.ts`) for consumers building agent frameworks:

```typescript
// Scopes — primary API for creating agent observability spans
export { OpenTelemetryScope } from './_a365/scopes/OpenTelemetryScope';
export { InvokeAgentScope } from './_a365/scopes/InvokeAgentScope';
export { ExecuteToolScope } from './_a365/scopes/ExecuteToolScope';
export { InferenceScope } from './_a365/scopes/InferenceScope';
export { OutputScope } from './_a365/scopes/OutputScope';

// Contracts — message and detail types
export type { ChatMessage, InputMessages, OutputMessages } from './_a365/contracts/messages';
export type { AgentDetails, UserDetails, SpanDetails } from './_a365/contracts/details';
export { MessageRole } from './_a365/contracts/types';

// Context propagation utilities
export { runWithExportToken, getExportToken } from './_a365/context/tokenContext';
export { injectContextToHeaders, extractContextFromHeaders } from './_a365/context/traceContextPropagation';

// Configuration types
export type { A365Options } from './distro/types';

// Constants
export { OpenTelemetryConstants } from './_a365/constants';
```

### NOT Exported (Internal Only)

- `Agent365Exporter` — wired internally by `a365Setup.ts`
- `PerRequestSpanProcessor` — wired internally
- `BaggageSpanProcessor` — wired internally
- `MicrosoftAgentFrameworkInstrumentation` — wired internally by `a365Setup.ts`
- `ObservabilityBuilder` / `ObservabilityManager` — replaced by `setupA365Components()` in distro orchestration
- Hosting middleware — used internally by hosting setup

---

## Migration Sequence

```
Task 5 (Context Propagation) ──────────────────────────────────────────────┐
                                                                           │
Task 1 (Configuration) ──→ Task 2 (Exporter) ──→ Task 3 (Processors) ─────┤
                      │                                                    │
                      ├──→ Task 4 (Scopes/Contracts) ──→ Task 6 (OpenAI) ─┤
                      │                            └──→ Task 7 (LangChain) ├──→ Task 9 (Orchestrator) ──→ Task 10 (Tests) ──→ Task 11 (Dual Maint.)
                      │                            └──→ Task 8b (MAF Inst.)│                                               └──→ Task 12 (Upstream Audit)
                      │                                                    │
Task 8 (Hosting) [depends on Tasks 1, 3, 5] ──────────────────────────────┘
```

**Parallelizable work:**
- Tasks 1 + 5 can start simultaneously
- Tasks 6 + 7 + 8b can proceed in parallel (all depend on Task 4)
- Task 8 can proceed independently once Tasks 1, 3, 5 are done
- Tasks 11 + 12 can proceed in parallel after Task 10

---

## Resolved Decisions

Decisions resolved by PLANNING.md guidance:

1. **Environment variable prefix:** Confirmed as `MICROSOFT_OTEL_A365_*`. The distro already uses `AZURE_MONITOR_*` for Azure Monitor env vars, and PLANNING.md explicitly specifies this convention. No backward compatibility with `A365_OBSERVABILITY_*` vars — the distro is a new package with its own env var namespace.

2. **GenAI instrumentation module paths:** Confirmed as `_openai/` and `_langchain/` at the `src/` level, separate from `_a365/`. PLANNING.md Phase 5 specifies: *"Keep instrumentations in clearly marked internal modules (e.g., `_openai/`, `_langchain/`)"*. These are Phase 5 deliverables that happen to be sourced from A365 code.

3. **GenAI instrumentation structure:** Per PLANNING.md Phase 5: *"Structure the code as standard OpenTelemetry instrumentors (implement `InstrumentationBase`) so they can be swapped out cleanly."* All GenAI instrumentations must implement `InstrumentationBase`.

4. **GenAI instrumentation lifecycle:** Per PLANNING.md Phase 5: *"When the upstream OpenTelemetry JS contrib GenAI packages reach functional parity, migrate to them and deprecate the in-repo versions."* These are explicitly temporary — Task 12 tracks the deprecation timeline.

5. **Microsoft Agent Framework instrumentation disposition:** Per PLANNING.md Phase 6: *"For instrumentations with no upstream equivalent (e.g., Microsoft Agent Framework), keep as Microsoft-specific extensions in this repo and evaluate contributing them to OpenTelemetry."* This is a long-term in-repo component.

---

## Open Questions

1. **Scope re-exports:** Should `InvokeAgentScope`, `ExecuteToolScope`, etc. be part of the distro's public API, or should they remain internal with a higher-level API wrapping them?

2. **Hosting gating:** Is hosting middleware (depends on `@microsoft/agents-hosting`) in scope for the initial distro release, or should it be deferred?

3. **Per-request vs. batch export default:** The original A365 SDK defaults to batch export. Should the distro keep this default, or change it?

4. **Token resolution pattern:** The A365 exporter uses a `tokenResolver(agentId, tenantId)` callback. Should this remain the same, or should it be adapted to a more standard auth pattern (e.g., Azure Identity `TokenCredential`)?

5. **Dual maintenance cutover:** How long should the migrated code remain synchronized with `Agent365-nodejs`? What's the cutover milestone? (Task 11 formalizes the process, but the timeline requires a team decision. This mirrors the Azure Monitor dual-maintenance model described in PLANNING.md.)

6. **InternalConfig integration:** Should A365 configuration be merged into the existing `InternalConfig` class (`src/shared/config.ts`) — which already handles global + Azure Monitor scoped options — or should A365 config resolution be kept separate in `src/a365Setup.ts`? Keeping it separate is simpler and avoids coupling, but `InternalConfig` already provides JSON config and env var merge precedence that A365 would benefit from.
