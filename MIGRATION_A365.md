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
    domainOverride: "optional.domain.com",
    authScopes: ["https://api.powerplatform.com/.default"],
    serviceNamespace: "my.app.namespace",           // NEW
    perRequestExport: true,
    exporterOptions: {                              // NEW
      maxQueueSize: 1024,
      maxExportBatchSize: 256,
      scheduledDelayMilliseconds: 1000,
    },
    observabilityLogLevel: "warn|error",            // NEW
    logger: customLogger,                           // NEW
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
- `ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT`
- `A365_OBSERVABILITY_SCOPES_OVERRIDE`
- `A365_OBSERVABILITY_DOMAIN_OVERRIDE`
- `CLUSTER_CATEGORY`
- `A365_OBSERVABILITY_LOG_LEVEL` (NEW)
- `A365_PER_REQUEST_MAX_TRACES`
- `A365_PER_REQUEST_MAX_SPANS_PER_TRACE`
- `A365_PER_REQUEST_MAX_CONCURRENT_EXPORTS`
- `A365_PER_REQUEST_FLUSH_GRACE_MS`
- `A365_PER_REQUEST_MAX_TRACE_AGE_MS`

## 7. Dual Export (Optional)

Send to both A365 and Azure Monitor:

```typescript
useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
  },
  azureMonitor: {
    azureMonitorExporterOptions: {
      connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    },
  },
});
```

## 8. Shutdown

Call shutdown on application exit:

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
