# Migrating to `@microsoft/opentelemetry`

This guide shows you how to migrate A365 observability code to use `@microsoft/opentelemetry`.

## 1. Install Package

```bash
npm install @microsoft/opentelemetry
```

## 2. Update Imports

Change your imports from `@microsoft/agents-a365-observability` to `@microsoft/opentelemetry`:

```typescript
import { 
  useMicrosoftOpenTelemetry,
  OpenTelemetryScope,
  InvokeAgentScope,
  BaggageBuilder,
  runWithExportToken,
  // ... other exports you need
} from "@microsoft/opentelemetry";
```

**Note:** `Request` type is now `A365Request`, `SpanDetails` is now `A365SpanDetails`, and `SpanProcessor` is now `A365SpanProcessor` to avoid name collisions.

## 3. Initialize Observability

Replace `Builder().build()` with `useMicrosoftOpenTelemetry()`:

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
  },
});
```

## 4. Use Scopes, Baggage, and Token Management

Usage is identical. Just update your imports:

```typescript
import { InvokeAgentScope, BaggageBuilder, runWithExportToken } from "@microsoft/opentelemetry";

// InvokeAgentScope usage (same API)
const scope = new InvokeAgentScope({
  agent: { id: "agent-123", name: "MyAgent" },
  request: { tenantId: "tenant-456" },
});
scope.start();
// ... work
scope.end();

// BaggageBuilder usage (same API)
const baggage = new BaggageBuilder()
  .tenantId("tenant-123")
  .agentId("agent-456")
  .build();

// Token context usage (same API)
runWithExportToken(token, () => {
  // ... work
});
```

## 5. A365 Configuration Options

Configure A365 via `useMicrosoftOpenTelemetry()`:

```typescript
useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
    clusterCategory: "prod",
    baggage: {
      propagationEnabled: true,
      enrichSpans: true,
    },
  },
});
```

## 6. Environment Variables

Use the same environment variables as before:

- `ENABLE_A365_OBSERVABILITY_EXPORTER`
- `A365_OBSERVABILITY_SCOPES_OVERRIDE`
- `A365_OBSERVABILITY_DOMAIN_OVERRIDE`
- `CLUSTER_CATEGORY`

## 7. Dual Export (Optional)

Send to both A365 and Azure Monitor:

```typescript
useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
=======
>>>>>>> upstream/main
  },
  azureMonitor: {
    azureMonitorExporterOptions: {
      connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    },
  },
});
```

## 8. Shutdown

<<<<<<< HEAD
Call shutdown on application exit:
=======
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

## Scopes

Scope usage is identical. Just update the import path:

### Before
>>>>>>> upstream/main

```typescript
import { shutdownMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

process.on("SIGTERM", async () => {
  await shutdownMicrosoftOpenTelemetry();
  process.exit(0);
});
```

## Checklist

- [ ] Install `@microsoft/opentelemetry`
- [ ] Replace all imports from `@microsoft/agents-a365-observability` with `@microsoft/opentelemetry`
- [ ] Replace `Builder().build()` with `useMicrosoftOpenTelemetry()`
- [ ] Rename `Request` to `A365Request`
- [ ] Rename `SpanDetails` to `A365SpanDetails`
- [ ] Rename `SpanProcessor` to `A365SpanProcessor`
- [ ] Test environment variables work as before
- [ ] Call `shutdownMicrosoftOpenTelemetry()` on app shutdown
- [ ] Remove `@microsoft/agents-a365-observability` dependency if no longer needed
