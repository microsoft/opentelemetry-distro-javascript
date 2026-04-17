// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to enable A365 observability export alongside Azure Monitor.
 *
 * A365 export sends trace data to the Agent365 observability service. You must
 * provide a `tokenResolver` that returns a bearer token for the given agent/tenant pair.
 *
 * Configuration can also be set via environment variables (highest precedence):
 *   - MICROSOFT_OTEL_A365_EXPORTER_ENABLED=true
 *   - MICROSOFT_OTEL_A365_CLUSTER_CATEGORY=dev
 *   - MICROSOFT_OTEL_A365_DOMAIN=https://custom.domain.com
 */

import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";
import { trace } from "@opentelemetry/api";
import "dotenv/config";

/**
 * Replace this with your real token resolver.
 * In production this would call an auth library (e.g. MSAL) to acquire a token.
 */
async function myTokenResolver(agentId: string, tenantId: string): Promise<string> {
  console.log(`Resolving token for agent=${agentId}, tenant=${tenantId}`);
  return process.env.A365_BEARER_TOKEN || "<your-bearer-token>";
}

async function main(): Promise<void> {
  useMicrosoftOpenTelemetry({
    // Azure Monitor (optional — can be used alongside A365)
    azureMonitor: {
      azureMonitorExporterOptions: {
        connectionString:
          process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || "<your connection string>",
      },
    },

    // A365 observability export
    a365: {
      enabled: true,
      tokenResolver: myTokenResolver,
      clusterCategory: "dev",
    },
  });

  // Generate a sample trace with A365 identity attributes.
  // The exporter partitions spans by (tenantId, agentId) extracted from span attributes.
  const tracer = trace.getTracer("a365-sample");
  const span = tracer.startSpan("sample-operation", {
    attributes: {
      "microsoft.tenant.id": "sample-tenant-id",
      "gen_ai.agent.id": "sample-agent-id",
    },
  });

  console.log("A365 export enabled — spans will be sent to the Agent365 observability service.");
  console.log(`Trace ID: ${span.spanContext().traceId}`);

  // Simulate some work
  await new Promise((resolve) => setTimeout(resolve, 100));

  span.end();

  console.log("Done.");
}

main().catch(console.error);
