# microsoft-opentelemetry

TypeScript package for a Microsoft OpenTelemetry distribution that provides a single onboarding experience for observability across Azure Monitor, OTLP-compatible backends, and Microsoft-specific integrations.

This repository starts from the POC described in `azure-data/microsoft-opentelemetry-distro-poc`, but is intentionally kept minimal while the package shape and delivery plan are being defined.

## Goal

The target package should reduce fragmented setup across multiple observability stacks to one import and one configuration function.

Intended API shape:

```typescript
import { useMicrosoftOpenTelemetry } from "microsoft-opentelemetry";

useMicrosoftOpenTelemetry({
  azureMonitor: {
    azureMonitorExporterOptions: {
      connectionString: "InstrumentationKey=...;IngestionEndpoint=...",
    },
  },
});
```

## Planned Scope

- Azure Monitor exporter support
- OTLP exporter support
- Microsoft-specific agent observability extensions (A365)
- GenAI instrumentation toggles for OpenAI and LangChain
- Standard Node.js web and HTTP instrumentations
- Environment-variable driven configuration
- A stable package surface for downstream agent applications

## OTLP Export

OTLP HTTP export is automatically enabled when the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable is set. No code changes are needed — the distro will export traces, metrics, and logs to the specified endpoint.

When OTLP is enabled alongside Azure Monitor, telemetry is sent to both backends simultaneously.

### Supported environment variables

The following standard OpenTelemetry environment variables are supported. General variables apply to all signals; signal-specific variables override the general ones.

| Variable | Description |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base endpoint for all signals (e.g. `http://localhost:4318`). Signal paths `/v1/traces`, `/v1/metrics`, `/v1/logs` are appended automatically. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` pairs sent as HTTP headers. |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | Compression algorithm: `gzip` or `none`. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Export timeout in milliseconds (default: `10000`). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Transport protocol: `http/protobuf` (default) or `http/json`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full endpoint URL for traces. Overrides the base endpoint. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Additional headers for trace exports. |
| `OTEL_EXPORTER_OTLP_TRACES_COMPRESSION` | Compression for trace exports. |
| `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | Timeout for trace exports. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Full endpoint URL for metrics. |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | Additional headers for metric exports. |
| `OTEL_EXPORTER_OTLP_METRICS_COMPRESSION` | Compression for metric exports. |
| `OTEL_EXPORTER_OTLP_METRICS_TIMEOUT` | Timeout for metric exports. |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | Aggregation temporality: `cumulative`, `delta`, or `lowmemory`. |
| `OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION` | `explicit_bucket_histogram` or `base2_exponential_bucket_histogram`. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Full endpoint URL for logs. |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS` | Additional headers for log exports. |
| `OTEL_EXPORTER_OTLP_LOGS_COMPRESSION` | Compression for log exports. |
| `OTEL_EXPORTER_OTLP_LOGS_TIMEOUT` | Timeout for log exports. |

For the full specification, see the [OpenTelemetry OTLP Exporter Configuration documentation](https://opentelemetry.io/docs/specs/otel/protocol/exporter/).

## Current Repository Layout

- `src/` – package source
  - `index.ts` – main entry point (`useMicrosoftOpenTelemetry`)
  - `types.ts` – configuration options (scoped by backend)
  - `setup/` – modular setup for Azure Monitor, OTLP, A365
- `azure-monitor-opentelemetry/` – temporary copy of Azure Monitor code (see Phase 3)
- `tests/` – test suite
- `package.json` – project metadata and dependencies
- `tsconfig.json` – TypeScript compiler configuration
- `PLANNING.md` – implementation plan and open questions

## Development

Install dependencies and run the build and test suite:

```bash
npm install
npm run build
npm run lint
npm test
```

## Reference

- POC repo: https://github.com/azure-data/microsoft-opentelemetry-distro-poc
- Planning document: [PLANNING.md](./PLANNING.md)
- Python distro: https://github.com/microsoft/opentelemetry-distro-python

## Contributing

Read our [contributing guide](./CONTRIBUTING.md) to learn about our development process, how to propose bugfixes and improvements, and how to build and test your changes to this distribution.

## Data Collection

As this SDK is designed to enable applications to perform data collection which is sent to the Microsoft collection endpoints the following is required to identify our privacy statement.

The software may collect information about you and your use of the software and send it to Microsoft. Microsoft may use this information to provide services and improve our products and services. You may turn off the telemetry as described in the repository. There are also some features in the software that may enable you and Microsoft to collect data from users of your applications. If you use these features, you must comply with applicable law, including providing appropriate notices to users of your applications together with a copy of Microsoft's privacy statement. Our privacy statement is located at https://go.microsoft.com/fwlink/?LinkID=824704. You can learn more about data collection and use in the help documentation and our privacy statement. Your use of the software operates as your consent to these practices.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow [Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general). Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos are subject to those third-party's policies.

## License

[MIT](LICENSE)
