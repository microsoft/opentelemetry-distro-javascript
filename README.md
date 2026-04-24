# @microsoft/opentelemetry

[![npm version](https://badge.fury.io/js/%40microsoft%2Fopentelemetry.svg)](https://www.npmjs.com/package/@microsoft/opentelemetry)
[![license](https://img.shields.io/npm/l/%40microsoft%2Fopentelemetry)](https://github.com/microsoft/opentelemetry-distro-javascript/blob/main/LICENSE)

Microsoft OpenTelemetry distribution for Node.js — one import, one call, full observability across Azure Monitor, OTLP-compatible backends, and A365.

## Getting Started

```bash
npm install @microsoft/opentelemetry
```

> **Important:** Import and call `useMicrosoftOpenTelemetry()` as early as possible in your application entry point so instrumentations can patch libraries before they are loaded.

### A365

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
  },
});
```

### Azure Monitor

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

useMicrosoftOpenTelemetry({
  azureMonitor: {
    azureMonitorExporterOptions: {
      connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    },
  },
});
```

### OTLP only (no Azure Monitor)

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

// Set OTEL_EXPORTER_OTLP_ENDPOINT in your environment
useMicrosoftOpenTelemetry();
```


That's it — traces, metrics, and logs are collected automatically with built-in instrumentations for HTTP, databases, and more.

## Configuration

### `MicrosoftOpenTelemetryOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `resource` | `Resource` | auto-detected | OpenTelemetry Resource (service name, version, etc.) |
| `samplingRatio` | `number` | `1.0` | Ratio of telemetry items to transmit (0.0–1.0) |
| `tracesPerSecond` | `number` | `5` | Max traces per second. Set to `0` to use `samplingRatio` instead |
| `instrumentationOptions` | `InstrumentationOptions` | all enabled | Toggle built-in instrumentations (see below) |
| `spanProcessors` | `SpanProcessor[]` | — | Additional span processors |
| `logRecordProcessors` | `LogRecordProcessor[]` | — | Additional log record processors |
| `metricReaders` | `MetricReader[]` | — | Additional metric readers |
| `views` | `ViewOptions[]` | — | Metric views |
| `azureMonitor` | `AzureMonitorOpenTelemetryOptions` | — | Azure Monitor backend config. When provided, Azure Monitor export is enabled |
| `a365` | `A365Options` | — | A365 observability config |
| `enableConsoleExporters` | `boolean` | auto | Enable console exporters for traces, metrics, and logs |

### `InstrumentationOptions`

Most instrumentations use `InstrumentationConfig` shape (`{ enabled?: boolean, ... }`).

- Built-in infra instrumentations (`http`, `azureSdk`, `azureFunctions`, `mongoDb`, `mySql`, `postgreSql`, `redis`, `redis4`) are enabled by default.
- Logging instrumentations (`bunyan`, `winston`) are disabled by default.
- GenAI instrumentations (`openaiAgents`, `langchain`) are enabled by default.

Set `enabled: true` or `enabled: false` explicitly for predictable behavior.

| Key | Type | Default | Description |
|---|---|---|---|
| `http` | `InstrumentationConfig` | enabled | HTTP client/server instrumentation |
| `azureSdk` | `InstrumentationConfig` | enabled | Azure SDK instrumentation |
| `mongoDb` | `InstrumentationConfig` | enabled | MongoDB instrumentation |
| `mySql` | `InstrumentationConfig` | enabled | MySQL instrumentation |
| `postgreSql` | `InstrumentationConfig` | enabled | PostgreSQL instrumentation |
| `redis` | `InstrumentationConfig` | enabled | Redis instrumentation |
| `redis4` | `InstrumentationConfig` | enabled | Redis 4 instrumentation |
| `bunyan` | `InstrumentationConfig` | disabled | Bunyan log instrumentation |
| `winston` | `InstrumentationConfig` | disabled | Winston log instrumentation |
| `openaiAgents` | `OpenAIAgentsInstrumentationConfig` | enabled | OpenAI Agents SDK instrumentation (requires `@openai/agents`) |
| `langchain` | `LangChainInstrumentationConfig` | enabled | LangChain instrumentation (requires `@langchain/core`) |

#### Turn instrumentations on/off

```typescript
useMicrosoftOpenTelemetry({
  instrumentationOptions: {
    // Disable specific built-in instrumentations
    http: { enabled: false },
    redis: { enabled: false },

    // Enable GenAI instrumentations
    openaiAgents: {
      enabled: true,
      isContentRecordingEnabled: true,
    },
    langchain: {
      enabled: true,
      isContentRecordingEnabled: true,
    },
  },
});
```

Disable most built-in auto-instrumentation:

```typescript
useMicrosoftOpenTelemetry({
  instrumentationOptions: {
    http: { enabled: false },
    azureSdk: { enabled: false },
    azureFunctions: { enabled: false },
    mongoDb: { enabled: false },
    mySql: { enabled: false },
    postgreSql: { enabled: false },
    redis: { enabled: false },
    redis4: { enabled: false },
    bunyan: { enabled: false },
    winston: { enabled: false },
    openaiAgents: { enabled: false },
    langchain: { enabled: false },
  },
});
```

### Console exporters

Use console exporters when validating local telemetry or debugging setup.

```typescript
useMicrosoftOpenTelemetry({
  enableConsoleExporters: true,
});
```

Behavior:

- `enableConsoleExporters: true`: always enable console exporters (traces, metrics, logs).
- `enableConsoleExporters: false`: do not auto-add the standard console exporters, except for the A365 span console fallback when `a365` options are provided but `a365.enabled` is `false` or omitted.
- Omitted: console exporters auto-enable only when no other exporter path is active; if `a365` options are provided but `a365.enabled` is `false` or omitted, the A365 span console fallback can still be added.

### `azureMonitor` options

| Option | Type | Default | Description |
|---|---|---|---|
| `azureMonitorExporterOptions` | `AzureMonitorExporterOptions` | — | Exporter config including `connectionString`, `storageDirectory`, `disableOfflineStorage` |
| `enableLiveMetrics` | `boolean` | `true` | Enable Live Metrics streaming |
| `enableStandardMetrics` | `boolean` | `true` | Enable standard metrics collection |
| `enableTraceBasedSamplingForLogs` | `boolean` | `false` | Enable log sampling based on trace |
| `enablePerformanceCounters` | `boolean` | `true` | Enable performance counter collection |
| `browserSdkLoaderOptions` | `BrowserSdkLoaderOptions` | disabled | Application Insights browser SDK loader config (`enabled`, `connectionString`) |

### OTLP via environment variables

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and OTLP export is enabled automatically — no code changes needed. Signal-specific variables (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, etc.) override the base endpoint.

See the [OpenTelemetry OTLP Exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/) for the full list.

### `a365` options

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Enable A365 observability export |
| `tokenResolver` | `(agentId, tenantId, authScopes?) => string \| Promise<string>` | — | Token resolver for A365 service authentication |
| `clusterCategory` | `ClusterCategory` | `"prod"` | Cluster category for endpoint resolution (`local`, `dev`, `test`, `preprod`, `firstrelease`, `prod`, `gov`, `high`, `dod`, `mooncake`, `ex`, `rx`) |
| `domainOverride` | `string` | — | Override the A365 observability service domain |
| `authScopes` | `string[]` | `["https://api.powerplatform.com/.default"]` | OAuth scopes for A365 service authentication |
| `baggage` | `A365BaggageOptions` | see below | Baggage propagation and span enrichment options |
| `hosting` | `A365HostingOptions` | see below | Hosting middleware options (requires `@microsoft/agents-hosting`) |

#### `a365.baggage` options

| Option | Type | Default | Description |
|---|---|---|---|
| `propagationEnabled` | `boolean` | `true` | Enable baggage propagation from request headers to span context |
| `enrichSpans` | `boolean` | `true` | Copy baggage items (tenant, agent, session, etc.) to span attributes |

#### `a365.hosting` options

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Currently does not auto-attach, enable, or disable hosting middleware by itself; attach hosting middleware explicitly as described below. |
| `adapter` | `{ use(...middlewares): void }` | — | Adapter reference for hosting integration configuration. |
| `enableOutputLogging` | `boolean` | `true` | Hosting output logging preference in configuration. |

#### A365 hosting middleware setup

`a365.hosting.enabled` is currently only a configuration value and does not by itself attach middleware or gate hosting middleware behavior.
To use A365 hosting middleware, attach it to your adapter explicitly.

Use the one-liner helper:

```typescript
import { configureA365Hosting } from "@microsoft/opentelemetry";

configureA365Hosting(adapter);
```

By default this registers both `BaggageMiddleware` and `OutputLoggingMiddleware`.

`OutputLoggingMiddleware` captures outgoing message content as span attributes. If your responses may contain sensitive content, disable output logging:

```typescript
configureA365Hosting(adapter, {
  enableBaggage: true,
  enableOutputLogging: false,
});
```

If you need explicit flags:

```typescript
configureA365Hosting(adapter, {
  enableBaggage: true,
  enableOutputLogging: true,
});
```

For previously published package versions that do not include `configureA365Hosting`, use:

```typescript
import { ObservabilityHostingManager } from "@microsoft/opentelemetry";

new ObservabilityHostingManager().configure(adapter as unknown as { use(...m: unknown[]): void }, {
  enableBaggage: true,
  enableOutputLogging: true,
});
```


| `httpRequestTimeoutMilliseconds` | `number` | `30000` | HTTP request timeout (ms) when sending spans to A365 service |

Example:

```typescript
useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
    exporterOptions: {
      maxQueueSize: 4096,
      maxExportBatchSize: 1024,
      scheduledDelayMilliseconds: 10000,
      httpRequestTimeoutMilliseconds: 15000,
    },
  },
});
```

#### A365 environment variables

A365 options can also be set via environment variables (highest precedence):

| Environment Variable | Description |
|---|---|
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | `"true"` / `"false"` — override `enabled` |
| `A365_OBSERVABILITY_SCOPES_OVERRIDE` | Space-separated list of OAuth scopes |
| `A365_OBSERVABILITY_DOMAIN_OVERRIDE` | Override service domain |
| `CLUSTER_CATEGORY` | Override cluster category |
| `A365_OBSERVABILITY_LOG_LEVEL` | A365 internal logger filter level (`none`, `info`, `warn`, `error`, or pipe-delimited combination) — overrides `observabilityLogLevel` |
| `A365_PER_REQUEST_MAX_TRACES` | Max buffered traces (default: `1000`) |
| `A365_PER_REQUEST_MAX_SPANS_PER_TRACE` | Max spans per trace (default: `5000`) |
| `A365_PER_REQUEST_MAX_CONCURRENT_EXPORTS` | Max concurrent exports (default: `20`) |
| `A365_PER_REQUEST_FLUSH_GRACE_MS` | Grace period after root span ends (default: `250`) |
| `A365_PER_REQUEST_MAX_TRACE_AGE_MS` | Max trace age before forced flush (default: `1800000`) |


### Example

```typescript
import { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";
import { resourceFromAttributes } from "@opentelemetry/resources";

useMicrosoftOpenTelemetry({
  resource: resourceFromAttributes({ "service.name": "my-app" }),
  samplingRatio: 0.5,
  azureMonitor: {
    azureMonitorExporterOptions: {
      connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    },
  },
});

// On shutdown
await shutdownMicrosoftOpenTelemetry();
```

## Samples

See the [samples/](./samples/) directory for working TypeScript examples covering connection setup, custom metrics, custom traces, sampling, OTLP dual-export, and more.


## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more
information see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/)
or contact [opencode@microsoft.com](mailto:opencode@microsoft.com)
with any additional questions or comments.

## Data Collection

As this SDK is designed to enable applications to perform data collection which is sent to the Microsoft collection endpoints the following is required to identify our privacy statement.

The software may collect information about you and your use of the software and send it to Microsoft. Microsoft may use this information to provide services and improve our products and services. You may turn off the telemetry as described in the repository. There are also some features in the software that may enable you and Microsoft to collect data from users of your applications. If you use these features, you must comply with applicable law, including providing appropriate notices to users of your applications together with a copy of Microsoft’s privacy statement. Our privacy statement is located at https://go.microsoft.com/fwlink/?LinkID=824704. You can learn more about data collection and use in the help documentation and our privacy statement. Your use of the software operates as your consent to these practices.

### Internal Telemetry

Internal telemetry can be disabled by setting the environment variable `APPLICATIONINSIGHTS_STATSBEAT_DISABLED` to `true`.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow [Microsoft’s Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general). Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos are subject to those third-party’s policies.

## Reporting Security Issues

See [SECURITY.md](./SECURITY.md) for information on reporting vulnerabilities.

## License

[MIT](LICENSE)
