# Migrating from `@microsoft/agents-a365-observability` to `@microsoft/opentelemetry`

Migration guide for existing Agent365 observability customers moving to the production-ready distro.

For A365 documentation (scopes, baggage, scenarios), see [A365_DOCUMENTATION.md](./A365_DOCUMENTATION.md).

Reference docs: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/microsoft-opentelemetry?tabs=nodejs

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

## 3) Resource configuration (service identity)

The Agent365 Observability SDK used `ObservabilityManager.configure(builder => builder.withService('name', 'version'))` to set the service name and version. In the distro, use the standard OpenTelemetry `resource` option:

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";
import { resourceFromAttributes } from "@opentelemetry/resources";

useMicrosoftOpenTelemetry({
  resource: resourceFromAttributes({
    "service.name": "my-agent-service",
    "service.version": "1.0.0",
    "service.namespace": "my-namespace", // optional
  }),
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
  },
});
```

Alternatively, use the `OTEL_RESOURCE_ATTRIBUTES` environment variable:

```bash
# Linux / macOS
export OTEL_RESOURCE_ATTRIBUTES=service.name=my-agent-service,service.version=1.0.0

# Windows cmd
set OTEL_RESOURCE_ATTRIBUTES=service.name=my-agent-service,service.version=1.0.0
```

Without explicit configuration, the service name defaults to `unknown_service:<process name>`.

---

## 4) Auto-instrumentation behavior change

The distro auto-discovers and instruments supported GenAI frameworks (OpenAI Agents SDK, LangChain) without explicit `instrumentor.enable()` calls. This is a key difference from the Agent365 Observability SDK.

**What is auto-instrumented by default:**

| Instrumentation | A365-only mode | A365 + Azure Monitor |
|---|---|---|
| OpenAI Agents SDK (`openaiAgents`) | enabled | enabled |
| LangChain (`langchain`) | enabled | enabled |
| HTTP, Azure SDK, databases, caches | **disabled** | enabled |
| Bunyan, Winston logging | disabled | disabled |

**Key differences from the Agent365 Observability SDK:**

- The Agent365 Observability SDK required explicit `instrumentor.enable()` calls (e.g., `new OpenAIAgentsTraceInstrumentor(...).enable()`). The distro handles this automatically.
- When A365 is enabled without Azure Monitor, non-GenAI instrumentations (HTTP, databases, etc.) are disabled by default to keep telemetry GenAI-focused.
- **Warning:** If your migrated code still calls `instrumentor.enable()` alongside the distro's auto-instrumentation, you may get duplicate spans. Remove explicit `instrumentor.enable()` calls after migration.

**To disable a specific auto-instrumentation:**

```typescript
useMicrosoftOpenTelemetry({
  a365: { enabled: true, tokenResolver: ... },
  instrumentationOptions: {
    openaiAgents: { enabled: false },
  },
});
```

**To re-enable non-GenAI instrumentations in A365 mode:**

```typescript
useMicrosoftOpenTelemetry({
  a365: { enabled: true, tokenResolver: ... },
  instrumentationOptions: {
    http: { enabled: true },
    azureSdk: { enabled: true },
    mongoDb: { enabled: true },
  },
});
```

---

## 5) API renames

| Before | After |
|---|---|
| `Request` | `A365Request` |
| `SpanDetails` | `A365SpanDetails` |
| `ObservabilityConfiguration` | `A365Configuration` |
| `ObservabilityConfigurationOptions` | `A365Options` |
| `BuilderOptions` | `A365Options` |
| `ObservabilityBuilder` / `Builder` | `useMicrosoftOpenTelemetry()` |

---

## 6) Token management: `AgenticTokenCache`

New built-in token cache for per-agent-per-tenant token acquisition and refresh.

**Migrating from `withTokenResolver()`:** The Agent365 Observability SDK's `builder.withTokenResolver()` pattern maps directly to the `tokenResolver` option in the distro. The distro does **not** auto-register a built-in cache — you must always provide a `tokenResolver`. If you want built-in caching, use `AgenticTokenCacheInstance` as shown below.

### Using the shared singleton

```typescript
import {
  useMicrosoftOpenTelemetry,
  AgenticTokenCacheInstance,
} from "@microsoft/opentelemetry";

// Use the built-in AgenticTokenCacheInstance as the token resolver.
// No custom TokenCache class needed — the distro provides it out of the box.
const otelTokenResolver = async (agentId: string, tenantId: string): Promise<string> => {
  const token = AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId) ?? '';
  return token;
};

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: otelTokenResolver,
  },
});
```

### Migrating from a custom `tokenResolver`

If you previously used `withTokenResolver()` with custom logic, pass your resolver directly:

```typescript
// Before (Agent365 Observability SDK)
builder.withTokenResolver((agentId, tenantId) => myCustomTokenLogic(agentId, tenantId));

// After (distro) — same resolver, new location
useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => myCustomTokenLogic(agentId, tenantId),
  },
});
```

To switch from a custom resolver to the built-in cache, replace your custom logic with `AgenticTokenCacheInstance` as shown above.

### Custom instance

```typescript
import { AgenticTokenCache, useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

const tokenCache = new AgenticTokenCache({
  authScopes: ["https://api.powerplatform.com/.default"],
});

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) =>
      tokenCache.getObservabilityToken(agentId, tenantId),
  },
});
```

---

## 7) Scopes and baggage

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

## 8) Exporter customization

The Agent365 Observability SDK's `withExporterOptions()` pattern is replaced by flat properties on the `a365` options object.

| Agent365 Observability SDK (`Agent365ExporterOptions`) | Distro equivalent |
|---|---|
| `maxQueueSize` | `a365.maxQueueSize` (default: `2048`) |
| `scheduledDelayMilliseconds` | `a365.scheduledDelayMilliseconds` (default: `5000`) |
| `exporterTimeoutMilliseconds` | `a365.exporterTimeoutMilliseconds` (default: `90000`) |
| `httpRequestTimeoutMilliseconds` | `a365.httpRequestTimeoutMilliseconds` (default: `30000`) |
| `maxExportBatchSize` | `a365.maxExportBatchSize` (default: `512`) |
| `useS2SEndpoint` | `a365.useS2SEndpoint` (default: `false`) |

```typescript
// Before (Agent365 Observability SDK)
const exporterOptions = new Agent365ExporterOptions();
exporterOptions.maxQueueSize = 10;
builder.withExporterOptions(exporterOptions);

// After (distro) — flat on a365 options
useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
    maxQueueSize: 10,
    scheduledDelayMilliseconds: 5000,
    httpRequestTimeoutMilliseconds: 15000,
  },
});
```

---

## 9) Custom span export

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

## 10) Filtering spans with a custom SpanProcessor

By default, when using `enableConsoleExporters: true` or other generic exporters, **all** spans are exported — including framework-level spans (`agents.app.*`, `agents.turn.*`, `agents.connector.*`, etc.). The A365 exporter already filters to only the supported observability scopes, but console or OTLP exporters do not.

To limit output to only the 4 A365 observability scope types, register a custom `SpanProcessor` that marks non-A365 spans as unsampled so they are not exported:

```typescript
import { TraceFlags } from "@opentelemetry/api";
import { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

const A365_OPERATIONS = new Set([
  "invoke_agent",
  "chat",
  "execute_tool",
  "output_messages",
]);

class A365OnlySpanProcessor implements SpanProcessor {
  onStart(_span: Span): void {}

  onEnd(span: Span): void {
    const op = span.attributes["gen_ai.operation.name"];
    if (!op || !A365_OPERATIONS.has(op as string)) {
      // Mark non-A365 spans as NONE so exporters skip them
      span.spanContext().traceFlags = TraceFlags.NONE;
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
```

Usage:

```typescript
useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
  },
  spanProcessors: [new A365OnlySpanProcessor()],
});
```

> **Note:** The A365 exporter (`Agent365Exporter`) already filters to known `gen_ai.operation.name` values internally. This pattern is only needed when you want other exporters (console, OTLP, etc.) to show only A365 scopes.

---

## 11) Middleware migration

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

## 12) Logging level migration

| Old | New |
|---|---|
| `A365_OBSERVABILITY_LOG_LEVEL=none` | `OTEL_LOG_LEVEL=NONE` |
| `A365_OBSERVABILITY_LOG_LEVEL=info` | `OTEL_LOG_LEVEL=INFO` |
| `A365_OBSERVABILITY_LOG_LEVEL=warn` | `OTEL_LOG_LEVEL=WARN` |
| `A365_OBSERVABILITY_LOG_LEVEL=error` | `OTEL_LOG_LEVEL=ERROR` |

Before:

```bash
# Linux / macOS
export A365_OBSERVABILITY_LOG_LEVEL=info

# Windows cmd
set A365_OBSERVABILITY_LOG_LEVEL=info
```

After:

```bash
# Linux / macOS
export OTEL_LOG_LEVEL=INFO
export AZURE_LOG_LEVEL=info

# Windows cmd
set OTEL_LOG_LEVEL=INFO
set AZURE_LOG_LEVEL=info
```

---

## 13) Environment variables

A365 core variables:

| Variable | Description |
|---|---|
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | Secondary toggle for A365 export; only takes effect when `a365` options are provided in code. Cannot activate A365 on its own. |
| `A365_OBSERVABILITY_SCOPES_OVERRIDE` | Space-separated OAuth scopes |
| `A365_OBSERVABILITY_DOMAIN_OVERRIDE` | Override A365 service domain |
| `CLUSTER_CATEGORY` | Cluster category: `prod`, `dev`, `test` |
| `A365_OBSERVABILITY_LOG_LEVEL` | A365 log filter: `none`, `info`, `warn`, `error`, or pipe-separated combinations such as `info\|warn\|error` |

---

## 14) Troubleshooting — permissions and setup

### HTTP 403 after upgrading

Your app registration or Managed Identity must have the `Agent365.Observability.OtelWrite` permission. Without it, telemetry export fails with HTTP 403.

**Grant the permission using one of the following options:**

**Option A — Agent 365 CLI** (requires `a365.config.json` and `a365.generated.config.json`, a Global Administrator account, and [Agent 365 CLI v1.1.139-preview](https://www.nuget.org/packages/Microsoft.Agents.A365.DevTools.Cli/1.1.139-preview) or later):

```bash
a365 setup admin --config-dir "<path-to-config-dir>"
```

**Option B — Entra Portal** (requires Global Administrator access):

1. Go to **Entra portal** > **App registrations** > select your Blueprint app.
2. Go to **API permissions** > **Add a permission** > **APIs my organization uses** > search for `9b975845-388f-4429-889e-eab1ef63949c`.
3. Select **Delegated permissions** > check `Agent365.Observability.OtelWrite` > **Add permissions**.
4. Repeat steps 2–3, this time select **Application permissions** > check `Agent365.Observability.OtelWrite` > **Add permissions**.
5. Click **Grant admin consent** and confirm.

### License requirements

Your tenant must have one of the following licenses assigned in [Microsoft 365 admin center](https://admin.cloud.microsoft/?source=applauncher#/homepage):

- Test - Microsoft 365 E7
- Microsoft 365 E7
- Microsoft Agent 365 Frontier

### Duplicate spans after migration

If your migrated code still calls `instrumentor.enable()` (e.g., `OpenAIAgentsTraceInstrumentor.enable()`) alongside the distro, you will get duplicate spans. Remove explicit instrumentor calls — the distro handles auto-instrumentation automatically.

### Validating locally

Set `ENABLE_A365_OBSERVABILITY_EXPORTER=false` to export spans to the console for local validation. Enable verbose logging with:

```bash
# Choose one of: info, warn, error
# Linux / macOS
export A365_OBSERVABILITY_LOG_LEVEL=info

# Windows cmd
set A365_OBSERVABILITY_LOG_LEVEL=info
```

For the full troubleshooting guide, see the [official troubleshooting documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/microsoft-opentelemetry?tabs=nodejs).

---

## 15) Migration checklist

**Packages & initialization:**
- [ ] Replace `@microsoft/agents-a365-observability` with `@microsoft/opentelemetry`
- [ ] Replace hosting imports: `@microsoft/agents-a365-observability-hosting` → `@microsoft/opentelemetry`
- [ ] Replace `new Builder(...).build()` with `useMicrosoftOpenTelemetry({ a365: { ... } })`
- [ ] Set `service.name` and `service.version` via `resource` option or `OTEL_RESOURCE_ATTRIBUTES`

**Auto-instrumentation:**
- [ ] Remove explicit `instrumentor.enable()` calls (the distro auto-instruments)
- [ ] Review which instrumentations are enabled by default in A365 mode (GenAI only)
- [ ] Re-enable non-GenAI instrumentations if needed via `instrumentationOptions`

**API renames:**
- [ ] `Request` → `A365Request`
- [ ] `SpanDetails` → `A365SpanDetails`
- [ ] `ObservabilityConfiguration` → `A365Configuration`
- [ ] `ObservabilityConfigurationOptions` → `A365Options`
- [ ] `BuilderOptions` → `A365Options`
- [ ] `ObservabilityBuilder` / `Builder` → `useMicrosoftOpenTelemetry()`

**Token management:**
- [ ] Migrate `withTokenResolver()` to `a365.tokenResolver` option
- [ ] Consider using `AgenticTokenCache` or `AgenticTokenCacheInstance` for token caching

**Exporter customization:**
- [ ] Migrate `withExporterOptions()` to flat properties on `a365` options (e.g. `a365.maxQueueSize`)

**Middleware:**
- [ ] Migrate to `configureA365Hosting(adapter, ...)` or `ObservabilityHostingManager`

**Permissions:**
- [ ] Ensure `Agent365.Observability.OtelWrite` permission is granted
- [ ] Verify tenant license (Microsoft 365 E7 or Microsoft Agent 365 Frontier)

**Logging:**
- [ ] Set `OTEL_LOG_LEVEL` for distro diagnostics
- [ ] Optionally set `AZURE_LOG_LEVEL` for Azure SDK alignment

**Verification:**
- [ ] Run unit tests to confirm API usage
- [ ] Validate A365 export in logs or telemetry backend
- [ ] Test token refresh with long-running agents
