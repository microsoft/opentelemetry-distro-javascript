# Migrating from `@microsoft/agents-a365-observability` to `@microsoft/opentelemetry`

This guide covers migrating agent observability code from the standalone `@microsoft/agents-a365-observability` package (in [Agent365-nodejs](https://github.com/microsoft/Agent365-nodejs)) to the `@microsoft/opentelemetry` distribution.

## Quick Start

### Before (Agent365-nodejs)

```typescript
import { Builder } from "@microsoft/agents-a365-observability";

const manager = new Builder({
  tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
  clusterCategory: "prod",
}).build();
```

### After (@microsoft/opentelemetry)

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
    clusterCategory: "prod",
  },
});
```

## Package Changes

| Before | After |
|---|---|
| `npm install @microsoft/agents-a365-observability` | `npm install @microsoft/opentelemetry` |
| `import { ... } from "@microsoft/agents-a365-observability"` | `import { ... } from "@microsoft/opentelemetry"` |

## Import Mapping

All public APIs are re-exported from the root `@microsoft/opentelemetry` package:

| `@microsoft/agents-a365-observability` | `@microsoft/opentelemetry` |
|---|---|
| `OpenTelemetryConstants` | `OpenTelemetryConstants` |
| `OpenTelemetryScope` | `OpenTelemetryScope` |
| `InvokeAgentScope` | `InvokeAgentScope` |
| `ExecuteToolScope` | `ExecuteToolScope` |
| `InferenceScope` | `InferenceScope` |
| `OutputScope` | `OutputScope` |
| `BaggageBuilder` | `BaggageBuilder` |
| `BaggageScope` | `BaggageScope` |
| `runWithExportToken` | `runWithExportToken` |
| `updateExportToken` | `updateExportToken` |
| `getExportToken` | `getExportToken` |
| `runWithParentSpanRef` | `runWithParentSpanRef` |
| `createContextWithParentSpanRef` | `createContextWithParentSpanRef` |
| `injectContextToHeaders` | `injectContextToHeaders` |
| `extractContextFromHeaders` | `extractContextFromHeaders` |
| `runWithExtractedTraceContext` | `runWithExtractedTraceContext` |
| `MessageRole` | `MessageRole` |
| `FinishReason` | `FinishReason` |
| `InferenceOperationType` | `InferenceOperationType` |

### Types

| `@microsoft/agents-a365-observability` | `@microsoft/opentelemetry` |
|---|---|
| `Request` | `A365Request` (renamed to avoid collision with global `Request`) |
| `SpanDetails` | `A365SpanDetails` (renamed for clarity) |
| `AgentDetails` | `AgentDetails` |
| `UserDetails` | `UserDetails` |
| `CallerDetails` | `CallerDetails` |
| `Channel` | `Channel` |
| `ServiceEndpoint` | `ServiceEndpoint` |
| `InvokeAgentScopeDetails` | `InvokeAgentScopeDetails` |
| `ToolCallDetails` | `ToolCallDetails` |
| `InferenceDetails` | `InferenceDetails` |
| `InferenceResponse` | `InferenceResponse` |
| `OutputResponse` | `OutputResponse` |
| `ParentSpanRef` | `ParentSpanRef` |
| `ParentContext` | `ParentContext` |
| `ChatMessage` | `ChatMessage` |
| `HeadersCarrier` | `HeadersCarrier` |

### Processor Classes

| `@microsoft/agents-a365-observability` | `@microsoft/opentelemetry` | Notes |
|---|---|---|
| `SpanProcessor` (from `processors/`) | `A365SpanProcessor` | Renamed to avoid collision with OTel `SpanProcessor` |

## Initialization

### Before: `ObservabilityBuilder`

The Agent365-nodejs package used `ObservabilityBuilder` / `ObservabilityManager`:

```typescript
import { Builder } from "@microsoft/agents-a365-observability";

const manager = new Builder({
  tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
  clusterCategory: "prod",
}).build();
```

### After: `useMicrosoftOpenTelemetry`

The new package uses a unified initialization call:

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
    clusterCategory: "prod",
  },
  // Optional: also send to Azure Monitor
  azureMonitor: {
    azureMonitorExporterOptions: {
      connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    },
  },
});
```

### A365 Configuration Coverage

All A365 observability options are available through `a365`:

| Option | Type | Default | Notes |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Enables A365 exporter path |
| `tokenResolver` | `(agentId, tenantId, authScopes?) => string \| Promise<string>` | — | Required when exporting to A365 |
| `clusterCategory` | `ClusterCategory` | `"prod"` | Same category values as Agent365-nodejs |
| `domainOverride` | `string` | — | Optional endpoint override (applied by exporter) |
| `authScopes` | `string[]` | `["https://api.powerplatform.com/.default"]` | Passed to `tokenResolver` as the third argument |
| `perRequestExport` | `boolean` | `false` | Export per trace when root span completes |
| `baggage.propagationEnabled` | `boolean` | `true` | Controls baggage middleware auto-registration when hosting is enabled |
| `baggage.enrichSpans` | `boolean` | `true` | Copy baggage values onto span attributes via `A365SpanProcessor` |
| `hosting.enabled` | `boolean` | `false` | Enables hosting middleware auto-registration when `hosting.adapter` is provided |

## Hosting Middleware Setup

If your app uses `@microsoft/agents-hosting` and expects hosting-layer middleware (`BaggageMiddleware`, `OutputLoggingMiddleware`), attach middleware to the adapter explicitly.

### Current one-liner

```typescript
import { configureA365Hosting } from "@microsoft/opentelemetry";

configureA365Hosting(adapter);
```

## Environment Variables

Environment variable names are **unchanged** from Agent365-nodejs:

| Environment Variable | Description |
|---|---|
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | Enable/disable A365 exporter (`true`, `1`, `yes`, `on`) |
| `A365_OBSERVABILITY_SCOPES_OVERRIDE` | Space-separated list of OAuth scopes |
| `A365_OBSERVABILITY_DOMAIN_OVERRIDE` | Override service domain |
| `CLUSTER_CATEGORY` | Cluster category (`prod`, `dev`, `test`, etc.) |

## Custom Span Export

If your previous setup used `perRequestExport: true` (buffering spans per trace and exporting when a trace completes), use a custom `SpanProcessor` with the exported `Agent365Exporter`.
`BatchSpanProcessor` and `SimpleSpanProcessor` are supported, but they change export timing compared to the removed per-request behavior.
To keep equivalent timing semantics, implement a custom span processor.

```typescript
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { useMicrosoftOpenTelemetry, Agent365Exporter } from "@microsoft/opentelemetry";

const exporter = new Agent365Exporter({
  clusterCategory: "prod",
  tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
});

// Disable built-in A365 exporter to avoid double exporting when using custom processors.
process.env.ENABLE_A365_OBSERVABILITY_EXPORTER = "false";

// Supply any OTel-compatible SpanProcessor wrapping Agent365Exporter.
// Note: BatchSpanProcessor does not export on root-span completion.
useMicrosoftOpenTelemetry({
  a365: { enabled: false },
  spanProcessors: [new BatchSpanProcessor(exporter)],
});
```

> **Note:** `Agent365Exporter` is a standard `SpanExporter`. You can wrap it with any
> `SpanProcessor` from `@opentelemetry/sdk-trace-base` (e.g. `BatchSpanProcessor`,
> `SimpleSpanProcessor`) or a custom implementation.

### Logging Level Configuration

During migration, these environment variables control SDK diagnostics:

| Environment Variable | Values | Behavior |
|---|---|---|
| `APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL` | `ALL`, `VERBOSE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `NONE` | Primary switch for OpenTelemetry diagnostics; also maps Azure logger levels for `VERBOSE`, `INFO`, `WARN`, `ERROR` |
| `OTEL_LOG_LEVEL` | `ALL`, `VERBOSE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `NONE` | Used when `APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL` is not set |
| `AZURE_LOG_LEVEL` | `verbose`, `info`, `warning`, `error` | Controls Azure logger level when the App Insights logging level variable is not mapped/absent |

Example:

```bash
set APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL=INFO
```

### Console Exporters During Migration

You can keep local visibility while migrating by using console exporters.

```typescript
useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
  },
  enableConsoleExporters: true, // traces + metrics + logs to console
});
```

Behavior summary:

- `enableConsoleExporters: true`: always adds console exporters for traces, metrics, and logs.
- `enableConsoleExporters: false`: disables automatic console exporters.
- If **no** Azure Monitor/OTLP/A365 exporter is active, console exporters are auto-enabled.
- If `a365` options are provided but A365 is disabled (`a365.enabled` false/omitted), a span console exporter is added as a fallback so spans are still visible locally.

## Scopes

Scope usage is identical. Just update the import path:

### Before

```typescript
import { InvokeAgentScope } from "@microsoft/agents-a365-observability";

const scope = new InvokeAgentScope({
  agent: { id: "agent-123", name: "MyAgent" },
  request: { tenantId: "tenant-456" },
  invokeAgent: { targetAgentId: "target-789" },
});

scope.start();
try {
  // ... agent work
} finally {
  scope.end();
}
```

### After

```typescript
import { InvokeAgentScope } from "@microsoft/opentelemetry";

// Same API — just a different import path
const scope = new InvokeAgentScope({
  agent: { id: "agent-123", name: "MyAgent" },
  request: { tenantId: "tenant-456" },
  invokeAgent: { targetAgentId: "target-789" },
});

scope.start();
try {
  // ... agent work
} finally {
  scope.end();
}
```

## BaggageBuilder

The `BaggageBuilder` fluent API is identical:

```typescript
import { BaggageBuilder } from "@microsoft/opentelemetry";

const scope = new BaggageBuilder()
  .tenantId("tenant-123")
  .agentId("agent-456")
  .sessionId("session-789")
  .build();

scope.run(() => {
  // Baggage is active in this context
  // A365SpanProcessor copies baggage to span attributes automatically
});
```

## Token Context

Per-request token management is identical:

```typescript
import { runWithExportToken, updateExportToken } from "@microsoft/opentelemetry";

runWithExportToken(initialToken, async () => {
  // Start spans...

  // Refresh token before long-running request completes
  updateExportToken(refreshedToken);

  // End root span — export uses the refreshed token
});
```

## Hosting Middleware and Utilities

If you previously used hosting helpers with Agent365, they are also exported from `@microsoft/opentelemetry`:

- `BaggageMiddleware`
- `OutputLoggingMiddleware`
- `ObservabilityHostingManager`
- `BaggageBuilderUtils`
- `ScopeUtils`

Use the same APIs with updated imports:

```typescript
import {
  BaggageMiddleware,
  OutputLoggingMiddleware,
  ObservabilityHostingManager,
} from "@microsoft/opentelemetry";
```

## What's Not Migrated

The following Agent365-nodejs components are **not** included in `@microsoft/opentelemetry` because they are runtime/hosting concerns rather than observability:

| Component | Reason |
|---|---|
| `ObservabilityManager` / `ObservabilityBuilder` | Replaced by `useMicrosoftOpenTelemetry()` |
| `@microsoft/agents-a365-runtime` | Runtime configuration framework — not needed |
| `@microsoft/agents-hosting` | HTTP hosting middleware — separate concern |
| `IConfigurationProvider` | Replaced by direct options + env vars |
| `AgenticTokenCache` | Token caching is the caller's responsibility |

## Checklist

- [ ] Replace `@microsoft/agents-a365-observability` dependency with `@microsoft/opentelemetry`
- [ ] Update all imports to use `@microsoft/opentelemetry`
- [ ] Replace `Builder().build()` with `useMicrosoftOpenTelemetry({ a365: { ... } })`
- [ ] Rename `Request` type references to `A365Request`
- [ ] Rename `SpanDetails` type references to `A365SpanDetails`
- [ ] Rename `SpanProcessor` references to `A365SpanProcessor`
- [ ] Verify environment variables work (names are unchanged)
- [ ] Set diagnostic logging level (`APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL` or `OTEL_LOG_LEVEL`) for migration validation
- [ ] Decide whether to force console exporters (`enableConsoleExporters`) during rollout/debugging
- [ ] Remove `@microsoft/agents-a365-runtime` dependency if no longer needed
