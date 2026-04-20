# @microsoft/opentelemetry

Microsoft OpenTelemetry distribution for Node.js — one import, one call, full observability across Azure Monitor, OTLP-compatible backends, and A365.

## Getting Started

```bash
npm install @microsoft/opentelemetry
```

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

That's it — traces, metrics, and logs are collected automatically with built-in instrumentations for HTTP, databases, and more.

## Configuration

### `MicrosoftOpenTelemetryOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `resource` | `Resource` | auto-detected | OpenTelemetry Resource (service name, version, etc.) |
| `samplingRatio` | `number` | `1.0` | Ratio of telemetry items to transmit (0.0–1.0) |
| `tracesPerSecond` | `number` | `5` | Max traces per second. Set to `0` to use `samplingRatio` instead |
| `instrumentationOptions` | `InstrumentationOptions` | all enabled | Toggle built-in instrumentations (HTTP, MongoDB, MySQL, PostgreSQL, Redis, Azure SDK, Azure Functions, Winston, Bunyan, OpenAI Agents, LangChain) |
| `spanProcessors` | `SpanProcessor[]` | — | Additional span processors |
| `logRecordProcessors` | `LogRecordProcessor[]` | — | Additional log record processors |
| `metricReaders` | `MetricReader[]` | — | Additional metric readers |
| `views` | `ViewOptions[]` | — | Metric views |
| `azureMonitor` | `AzureMonitorOpenTelemetryOptions` | — | Azure Monitor backend config (see below) |
| `a365` | `A365Options` | — | A365 observability config |

### `azureMonitor` options

| Option | Type | Default | Description |
|---|---|---|---|
| `azureMonitorExporterOptions` | `AzureMonitorExporterOptions` | — | Exporter config including `connectionString`, `storageDirectory`, `disableOfflineStorage` |
| `enableLiveMetrics` | `boolean` | `true` | Enable Live Metrics streaming |
| `enableStandardMetrics` | `boolean` | `true` | Enable standard metrics collection |
| `enableTraceBasedSamplingForLogs` | `boolean` | `false` | Enable log sampling based on trace |
| `enablePerformanceCounters` | `boolean` | `true` | Enable performance counter collection |
| `browserSdkLoaderOptions` | `BrowserSdkLoaderOptions` | — | Application Insights browser SDK loader config |

### OTLP via environment variables

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and OTLP export is enabled automatically — no code changes needed. Signal-specific variables (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, etc.) override the base endpoint.

See the [OpenTelemetry OTLP Exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/) for the full list.

### `a365` options

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Enable A365 observability export |
| `tokenResolver` | `(agentId, tenantId) => string \| Promise<string>` | — | Token resolver for A365 service authentication |
| `clusterCategory` | `ClusterCategory` | `"prod"` | Cluster category for endpoint resolution (`local`, `dev`, `test`, `preprod`, `firstrelease`, `prod`, `gov`, `high`, `dod`, `mooncake`, `ex`, `rx`) |
| `domainOverride` | `string` | — | Override the A365 observability service domain |
| `authScopes` | `string[]` | `["https://api.powerplatform.com/.default"]` | OAuth scopes for A365 service authentication |
| `perRequestExport` | `boolean` | `false` | Buffer spans per trace and export on root completion instead of batch export |

A365 options can also be set via environment variables (highest precedence):

| Environment Variable | Description |
|---|---|
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | `"true"` / `"false"` — override `enabled` |
| `ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT` | `"true"` / `"false"` — override `perRequestExport` |
| `A365_OBSERVABILITY_SCOPES_OVERRIDE` | Space-separated list of OAuth scopes |
| `A365_OBSERVABILITY_DOMAIN_OVERRIDE` | Override service domain |
| `CLUSTER_CATEGORY` | Override cluster category |

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
    enableLiveMetrics: true,
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
