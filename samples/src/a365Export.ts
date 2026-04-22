// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to enable A365 observability export alongside Azure Monitor.
 *
 * ## What this sample shows
 *
 * The Agent365 observability service collects distributed traces from your agent
 * so you can monitor performance and troubleshoot issues in the A365 portal.
 * This sample walks through the minimal setup to start exporting trace data.
 *
 * ## How it works
 *
 * 1. **Token resolver** — A365 authenticates each export request with a bearer
 *    token scoped to the (agentId, tenantId) pair found on each span. In
 *    production you would use MSAL to acquire this token; here we read it from
 *    the `A365_BEARER_TOKEN` environment variable for simplicity.
 *
 * 2. **Configuration** — Pass `a365` options to `useMicrosoftOpenTelemetry()`.
 *    The exporter can run alongside Azure Monitor; neither is required for the
 *    other to work.
 *
 * 3. **Span attributes** — The exporter partitions spans by `microsoft.tenant.id`
 *    and `gen_ai.agent.id`. Every span that carries these attributes is routed
 *    to the correct A365 tenant/agent pipeline.
 *
 * ## Environment variables
 *
 * | Variable | Required | Description |
 * |----------|----------|-------------|
 * | `A365_BEARER_TOKEN` | Yes | Auth token for the Agent365 observability API |
 * | `APPLICATIONINSIGHTS_CONNECTION_STRING` | No | Azure Monitor connection string (optional, for dual export) |
 *
 * You can also configure the exporter entirely via env vars (highest precedence):
 *   - `ENABLE_A365_OBSERVABILITY_EXPORTER=true`
 *   - `CLUSTER_CATEGORY=dev`
 *   - `A365_OBSERVABILITY_DOMAIN_OVERRIDE=https://custom.domain.com`
 *
 * ## Running
 *
 * ```bash
 * cp sample.env .env   # fill in A365_BEARER_TOKEN (and optionally APPLICATIONINSIGHTS_CONNECTION_STRING)
 * npm run build
 * node dist/a365Export.js
 * ```
 */

import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";
import { trace } from "@opentelemetry/api";
import "dotenv/config";

// ────────────────────────────────────────────────────────────────────────────
// Step 1 — Token Resolver
// ────────────────────────────────────────────────────────────────────────────
// The exporter calls this function whenever it needs to authenticate an export
// request. It receives the agentId and tenantId extracted from span attributes.
//
// In production, replace this with an MSAL confidential-client flow:
//   const cca = new ConfidentialClientApplication({ auth: { clientId, authority, clientSecret } });
//   const { accessToken } = await cca.acquireTokenByClientCredential({ scopes });
//   return accessToken;
// ────────────────────────────────────────────────────────────────────────────

async function myTokenResolver(agentId: string, tenantId: string): Promise<string> {
  console.log(`[auth] Resolving token for agent=${agentId}, tenant=${tenantId}`);
  return process.env.A365_BEARER_TOKEN || "<your-bearer-token>";
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 — Initialize the distro with A365 export
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  useMicrosoftOpenTelemetry({
    // Azure Monitor (optional — you can use it alongside A365 or omit it)
    azureMonitor: {
      azureMonitorExporterOptions: {
        connectionString:
          process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || "<your connection string>",
      },
    },

    // A365 observability export configuration
    a365: {
      enabled: true,                   // turn on the Agent365 exporter
      tokenResolver: myTokenResolver,  // called per-export with (agentId, tenantId)
      clusterCategory: "dev",          // target cluster: dev | test | preprod | prod | …
    },
  });

  // ──────────────────────────────────────────────────────────────────────
  // Step 3 — Create spans with A365 identity attributes
  // ──────────────────────────────────────────────────────────────────────
  // The exporter groups and routes spans by (tenantId, agentId). Any span
  // that carries these two attributes will be exported to A365.

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

  console.log("Done. Check the A365 observability portal for your trace.");
}

main().catch(console.error);
