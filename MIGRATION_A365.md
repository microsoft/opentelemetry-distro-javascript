# Migrating from `@microsoft/agents-a365-observability` to `@microsoft/opentelemetry`

Migration guide for existing Agent365 observability customers moving to the production-ready distro.

For A365 documentation (scopes, baggage, scenarios), see [A365_DOCUMENTATION.md](./A365_DOCUMENTATION.md).

Reference docs: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability?tabs=nodejs

---

## 1) Package and import changes

| Before | After |
|---|---|
| `npm install @microsoft/agents-a365-observability` | `npm install @microsoft/opentelemetry` |
| `import { ... } from "@microsoft/agents-a365-observability"` | `import { ... } from "@microsoft/opentelemetry"` |

If you used hosting helpers:

| Before | After |
|---|---|
| `@microsoft/agents-a365-observability-hosting` | `@microsoft/opentelemetry` |

---

## 2) Initialization migration

### Before

```typescript
import { Builder } from "@microsoft/agents-a365-observability";

new Builder({
  tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
  clusterCategory: "prod",
}).build();
```

### After

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

---

## 3) API renames

| Before | After |
|---|---|
| `Request` | `A365Request` |
| `SpanDetails` | `A365SpanDetails` |
| `SpanProcessor` (A365 class) | `A365SpanProcessor` |

---

## 4) Token management: `AgenticTokenCache`

New built-in token cache for per-agent-per-tenant token acquisition and refresh.

### Using the shared singleton

```typescript
import {
  useMicrosoftOpenTelemetry,
  AgenticTokenCacheInstance,
} from "@microsoft/opentelemetry";

// Register token once per agent+tenant
AgenticTokenCacheInstance.register(agentId, tenantId, {
  authorization: AGENT_APP.auth,
  turnContext: context,
  scopes: ["https://api.powerplatform.com/.default"],
});

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) =>
      AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId),
  },
});
```

### Custom instance

```typescript
import { AgenticTokenCache } from "@microsoft/opentelemetry";

const tokenCache = new AgenticTokenCache({
  authScopes: ["https://api.powerplatform.com/.default"],
});
```

---

## 5) Scopes and baggage

If you use A365 scopes or baggage propagation, see [A365_DOCUMENTATION.md](./A365_DOCUMENTATION.md) for pattern details.

Quick example:

```typescript
import { BaggageScope } from "@microsoft/opentelemetry";

const baggage = new BaggageScope({
  tenantId: "my-tenant",
  channelId: "my-channel",
});

baggage.run(() => {
  // Baggage automatically propagated to child spans
  invokeAgent();
});
```

---

## 6) Custom span export

Use `Agent365Exporter` with standard OTel `SpanProcessor`:

```typescript
import { useMicrosoftOpenTelemetry, Agent365Exporter } from "@microsoft/opentelemetry";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
  },
  spanProcessors: [
    new BatchSpanProcessor(
      new Agent365Exporter({
        tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
      })
    ),
  ],
});
```

---

## 7) Middleware migration

### Before

```typescript
import { ObservabilityHostingManager } from "@microsoft/agents-a365-observability-hosting";

const manager = new ObservabilityHostingManager();
manager.configure(adapter, {
  enableBaggage: true,
  enableOutputLogging: true,
});
```

### After (one-liner)

```typescript
import { configureA365Hosting } from "@microsoft/opentelemetry";

configureA365Hosting(adapter, {
  enableBaggage: true,
  enableOutputLogging: true,
});
```

### Or explicit form

```typescript
import { ObservabilityHostingManager } from "@microsoft/opentelemetry";

new ObservabilityHostingManager().configure(adapter, {
  enableBaggage: true,
  enableOutputLogging: true,
});
```

---

## 8) Logging level migration

| Old | New |
|---|---|
| `A365_OBSERVABILITY_LOG_LEVEL=none` | `OTEL_LOG_LEVEL=NONE` |
| `A365_OBSERVABILITY_LOG_LEVEL=info` | `OTEL_LOG_LEVEL=INFO` |
| `A365_OBSERVABILITY_LOG_LEVEL=warn` | `OTEL_LOG_LEVEL=WARN` |
| `A365_OBSERVABILITY_LOG_LEVEL=error` | `OTEL_LOG_LEVEL=ERROR` |

Before:

```bash
set A365_OBSERVABILITY_LOG_LEVEL=info|warn|error
```

After:

```bash
set OTEL_LOG_LEVEL=INFO
set AZURE_LOG_LEVEL=info
```

---

## 9) Environment variables

A365 core variables:

| Variable | Description |
|---|---|
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | Enable/disable A365 export |
| `A365_OBSERVABILITY_SCOPES_OVERRIDE` | Space-separated OAuth scopes |
| `A365_OBSERVABILITY_DOMAIN_OVERRIDE` | Override A365 service domain |
| `CLUSTER_CATEGORY` | Cluster category: `prod`, `dev`, `test` |
| `A365_OBSERVABILITY_LOG_LEVEL` | A365 log filter: `none`, `info`, `warn`, `error` |

---

## 10) Migration checklist

**Packages & initialization:**
- [ ] Replace `@microsoft/agents-a365-observability` with `@microsoft/opentelemetry`
- [ ] Replace hosting imports: `@microsoft/agents-a365-observability-hosting` → `@microsoft/opentelemetry`
- [ ] Replace `new Builder(...).build()` with `useMicrosoftOpenTelemetry({ a365: { ... } })`

**API renames:**
- [ ] `Request` → `A365Request`
- [ ] `SpanDetails` → `A365SpanDetails`
- [ ] A365 `SpanProcessor` → `A365SpanProcessor`

**Token management:**
- [ ] Consider using `AgenticTokenCache` or `AgenticTokenCacheInstance` for token caching

**Middleware:**
- [ ] Migrate to `configureA365Hosting(adapter, ...)` or `ObservabilityHostingManager`

**Logging:**
- [ ] Set `OTEL_LOG_LEVEL` for distro diagnostics
- [ ] Optionally set `AZURE_LOG_LEVEL` for Azure SDK alignment

**Verification:**
- [ ] Run unit tests to confirm API usage
- [ ] Validate A365 export in logs or telemetry backend
- [ ] Test token refresh with long-running agents
