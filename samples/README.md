---
page_type: sample
languages:
  - typescript
products:
  - azure-monitor
urlFragment: microsoft-opentelemetry-typescript
---

# Microsoft OpenTelemetry distribution samples for TypeScript

These sample programs show how to use the `@microsoft/opentelemetry` distribution in common scenarios.

| **File Name**                               | **Description**                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [basicConnection.ts][basicconnection]       | Demonstrates how to configure Microsoft OpenTelemetry using a connection string.                         |
| [cloudRole.ts][cloudrole]                   | Demonstrates how to set Cloud Role Name and Cloud Role Instance using OpenTelemetry Resource attributes. |
| [customMetric.ts][custommetric]             | Demonstrates how to generate custom metrics that will be sent to Azure Monitor.                          |
| [customTrace.ts][customtrace]               | Demonstrates how to generate custom traces that will be sent to Azure Monitor.                           |
| [liveMetrics.ts][livemetrics]               | Demonstrates how to enable or disable Live Metrics for real-time monitoring.                             |
| [offlineStorage.ts][offlinestorage]         | Demonstrates how to configure offline storage and automatic retries for telemetry.                       |
| [otlpExporter.ts][otlpexporter]             | Demonstrates how to enable the OTLP exporter alongside Azure Monitor to send telemetry to two locations. |
| [redactQueryStrings.ts][redactquerystrings] | Demonstrates how to redact URL query strings from telemetry to protect sensitive information.            |
| [sampling.ts][sampling]                     | Demonstrates how to enable sampling to reduce data ingestion volume and control costs.                   |

## Prerequisites

- [Node.js LTS](https://github.com/nodejs/release#release-schedule) (>= 20.0.0)
- [TypeScript](https://www.typescriptlang.org/) (install via `npm install -g typescript`)
- An [Azure subscription](https://azure.microsoft.com/free/) with an [Application Insights](https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview) resource

## Setup

1. Install dependencies:

```bash
npm install
```

2. Compile the samples:

```bash
npm run build
```

3. Copy `sample.env` to `.env` and fill in your connection string:

```bash
cp sample.env .env
```

4. Run a sample:

```bash
node dist/basicConnection.js
```

Or pass the connection string directly:

```bash
APPLICATIONINSIGHTS_CONNECTION_STRING="<your connection string>" node dist/basicConnection.js
```

[basicconnection]: https://github.com/Azure/opentelemetry-distro-javascript/blob/main/samples/src/basicConnection.ts
[cloudrole]: https://github.com/Azure/opentelemetry-distro-javascript/blob/main/samples/src/cloudRole.ts
[custommetric]: https://github.com/Azure/opentelemetry-distro-javascript/blob/main/samples/src/customMetric.ts
[customtrace]: https://github.com/Azure/opentelemetry-distro-javascript/blob/main/samples/src/customTrace.ts
[livemetrics]: https://github.com/Azure/opentelemetry-distro-javascript/blob/main/samples/src/liveMetrics.ts
[offlinestorage]: https://github.com/Azure/opentelemetry-distro-javascript/blob/main/samples/src/offlineStorage.ts
[otlpexporter]: https://github.com/Azure/opentelemetry-distro-javascript/blob/main/samples/src/otlpExporter.ts
[redactquerystrings]: https://github.com/Azure/opentelemetry-distro-javascript/blob/main/samples/src/redactQueryStrings.ts
[sampling]: https://github.com/Azure/opentelemetry-distro-javascript/blob/main/samples/src/sampling.ts
