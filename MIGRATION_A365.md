# Migrating from `@microsoft/agents-a365-observability` to `@microsoft/opentelemetry`

This guide is for **existing Agent365 observability customers** migrating from the previous packages in Agent365-nodejs to `@microsoft/opentelemetry`.

It focuses only on migration deltas:

- package/import changes
- initialization replacement
- middleware migration
- logging-level migration

## 1) Package and import changes

| Before | After |
|---|---|
| `npm install @microsoft/agents-a365-observability` | `npm install @microsoft/opentelemetry` |
| `import { ... } from "@microsoft/agents-a365-observability"` | `import { ... } from "@microsoft/opentelemetry"` |

If you also used hosting helpers, migrate those imports too:

| Before | After |
|---|---|
| `@microsoft/agents-a365-observability-hosting` | `@microsoft/opentelemetry` |

## 2) Initialization migration

### Before (Agent365-nodejs)

```typescript
import { Builder } from "@microsoft/agents-a365-observability";

new Builder({
  tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
  clusterCategory: "prod",
}).build();
```

### After (`@microsoft/opentelemetry`)

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

## 3) API rename map

Most A365 APIs keep the same names after import-path migration. The main type/class renames are:

| Before (`@microsoft/agents-a365-observability`) | After (`@microsoft/opentelemetry`) |
|---|---|
| `Request` | `A365Request` |
| `SpanDetails` | `A365SpanDetails` |
| `SpanProcessor` (A365 class) | `A365SpanProcessor` |

## 4) Middleware migration (new example)

If your app previously used hosting middleware with `@microsoft/agents-hosting`, migrate as follows.

### Before (Agent365-nodejs hosting package)

```typescript
import { ObservabilityHostingManager } from "@microsoft/agents-a365-observability-hosting";

const manager = new ObservabilityHostingManager();
manager.configure(adapter, {
  enableBaggage: true,
  enableOutputLogging: true,
});
```

### After (`@microsoft/opentelemetry` one-liner)

```typescript
import { configureA365Hosting } from "@microsoft/opentelemetry";

configureA365Hosting(adapter, {
  enableBaggage: true,
  enableOutputLogging: true,
});
```

### Equivalent explicit form (also valid)

```typescript
import { ObservabilityHostingManager } from "@microsoft/opentelemetry";

new ObservabilityHostingManager().configure(adapter, {
  enableBaggage: true,
  enableOutputLogging: true,
});
```

## 5) Logging-level migration (new example)

### What changed

- A365 SDK logging used `A365_OBSERVABILITY_LOG_LEVEL` (`none`, `info`, `warn`, `error`, including pipe combinations like `info|warn|error`).
- New distro diagnostics use OpenTelemetry/Azure logger levels:
  - `OTEL_LOG_LEVEL` (recommended)
  - `APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL` (also supported)
  - `AZURE_LOG_LEVEL` (Azure SDK logger fallback)

### Migration map

| A365 SDK setting | New setting |
|---|---|
| `A365_OBSERVABILITY_LOG_LEVEL=none` | `OTEL_LOG_LEVEL=NONE` |
| `A365_OBSERVABILITY_LOG_LEVEL=info` | `OTEL_LOG_LEVEL=INFO` |
| `A365_OBSERVABILITY_LOG_LEVEL=warn` | `OTEL_LOG_LEVEL=WARN` |
| `A365_OBSERVABILITY_LOG_LEVEL=error` | `OTEL_LOG_LEVEL=ERROR` |

> `A365_OBSERVABILITY_LOG_LEVEL` is still supported for A365 internal logger filtering, but migration validation should set `OTEL_LOG_LEVEL` for distro diagnostics. If you also need Azure SDK logger alignment, set `AZURE_LOG_LEVEL` explicitly.

### Before/after example

Before (A365 SDK):

```bash
set A365_OBSERVABILITY_LOG_LEVEL=info|warn|error
```

After (new distro):

```bash
set OTEL_LOG_LEVEL=INFO
set AZURE_LOG_LEVEL=info
```

## 6) A365 environment variables

Core A365 export variables continue to work:

| Environment Variable | Description |
|---|---|
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | Enable/disable A365 exporter (`true`, `1`, `yes`, `on`) |
| `A365_OBSERVABILITY_SCOPES_OVERRIDE` | Space-separated OAuth scopes |
| `A365_OBSERVABILITY_DOMAIN_OVERRIDE` | Override A365 service domain |
| `CLUSTER_CATEGORY` | Cluster category (`prod`, `dev`, `test`, etc.) |
| `A365_OBSERVABILITY_LOG_LEVEL` | A365 internal log filter (`none`, `info`, `warn`, `error`, pipe combinations) |

## 7) Migration checklist

- [ ] Replace `@microsoft/agents-a365-observability` with `@microsoft/opentelemetry`
- [ ] If used, replace `@microsoft/agents-a365-observability-hosting` imports with `@microsoft/opentelemetry`
- [ ] Replace `new Builder(...).build()` with `useMicrosoftOpenTelemetry({ a365: { ... } })`
- [ ] Rename `Request` to `A365Request`
- [ ] Rename `SpanDetails` to `A365SpanDetails`
- [ ] Rename A365 `SpanProcessor` usage to `A365SpanProcessor`
- [ ] Migrate middleware setup to `configureA365Hosting(adapter, ...)` (or `ObservabilityHostingManager`)
- [ ] Set new diagnostics logging variables for rollout validation (`OTEL_LOG_LEVEL`; optionally `AZURE_LOG_LEVEL`)
