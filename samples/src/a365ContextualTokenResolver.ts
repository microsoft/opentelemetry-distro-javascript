// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates contextualTokenResolver with agentic user ID support.
 *
 * ## What this sample shows
 *
 * The `contextualTokenResolver` provides rich context during token resolution,
 * including the agentic user ID (AAD Object ID). This is useful in AI teammate
 * scenarios where each agent has a 1:1 relationship with a user.
 *
 * ## How it differs from tokenResolver
 *
 * | Resolver | Parameters | Use case |
 * |----------|-----------|----------|
 * | `tokenResolver` | `(agentId, tenantId, authScopes?)` | S2S scenarios, simple auth |
 * | `contextualTokenResolver` | `(context: TokenResolverContext)` | AI teammate scenarios needing user identity |
 *
 * When both are set, `contextualTokenResolver` takes precedence.
 *
 * ## Environment variables
 *
 * | Variable | Required | Description |
 * |----------|----------|-------------|
 * | `A365_BEARER_TOKEN` | Yes | Auth token for the Agent365 observability API |
 *
 * ## Running
 *
 * ```bash
 * cp sample.env .env   # fill in A365_BEARER_TOKEN
 * npm run build
 * node dist/a365ContextualTokenResolver.js
 * ```
 */

import {
  useMicrosoftOpenTelemetry,
  InvokeAgentScope,
  InferenceScope,
  InferenceOperationType,
  OutputScope,
  MessageRole,
  BaggageBuilder,
} from "@microsoft/opentelemetry";
import type { TokenResolverContext } from "@microsoft/opentelemetry";
import "dotenv/config";

// ────────────────────────────────────────────────────────────────────────────
// Step 1 — Contextual Token Resolver
// ────────────────────────────────────────────────────────────────────────────
// Unlike the plain tokenResolver, the contextual resolver receives a
// TokenResolverContext with:
//   - context.identity.agentId    — the agent ID from the span
//   - context.identity.agenticUserId — the AAD Object ID (AI teammate scenario)
//   - context.tenantId            — the tenant ID from the span

async function myContextualTokenResolver(context: TokenResolverContext): Promise<string> {
  const { agentId, agenticUserId } = context.identity;
  const { tenantId } = context;
  console.log(
    `[auth] Contextual token resolution: agent=${agentId}, tenant=${tenantId}, user=${agenticUserId ?? "(none — S2S)"}`,
  );

  // In production, use agenticUserId to acquire a user-scoped token via MSAL:
  //   const cca = new ConfidentialClientApplication({ ... });
  //   return agenticUserId
  //     ? await cca.acquireTokenOnBehalfOf({ oboAssertion: userToken, scopes })
  //     : await cca.acquireTokenByClientCredential({ scopes });

  return process.env.A365_BEARER_TOKEN || "<your-bearer-token>";
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 — Initialize the distro with contextual resolver
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  useMicrosoftOpenTelemetry({
    a365: {
      enabled: true,
      enableObservabilityExporter: true,
      contextualTokenResolver: myContextualTokenResolver,
      clusterCategory: "dev",
    },
    enableConsoleExporters: true,
  });

  // ──────────────────────────────────────────────────────────────────────
  // Step 3 — Set baggage with agentic user ID
  // ──────────────────────────────────────────────────────────────────────
  // The A365SpanProcessor copies baggage values (including the agentic
  // user ID) to span attributes, so the contextual resolver can read them
  // at export time.

  const agentDetails = {
    agentId: "agent-00112233-4455-6677-8899-aabbccddeeff",
    tenantId: "tenant-aabbccdd-eeff-0011-2233-445566778899",
    agentAUID: "user-11223344-5566-7788-99aa-bbccddeeff00",
  };

  const baggageScope = new BaggageBuilder()
    .tenantId(agentDetails.tenantId)
    .agentId(agentDetails.agentId)
    .agentAuid(agentDetails.agentAUID)
    .build();

  baggageScope.run(async () => {
    // ── InvokeAgentScope (top-level agent turn) ────────────────────────
    const invokeScope = InvokeAgentScope.start(
      { conversationId: "conv-001", sessionId: "session-001" },
      {},
      agentDetails,
    );

    await invokeScope.run(async () => {
      // ── InferenceScope (LLM call) ──────────────────────────────────
      const inferenceScope = InferenceScope.start(
        { conversationId: "conv-001" },
        { operationName: InferenceOperationType.CHAT, modelId: "gpt-4o" },
        agentDetails,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      inferenceScope.dispose();

      // ── OutputScope (response to user) ─────────────────────────────
      const outputScope = OutputScope.start(
        { conversationId: "conv-001" },
        {
          messages: [
            {
              role: MessageRole.Assistant,
              parts: [{ type: "text", content: "Hello! How can I help you today?" }],
            },
          ],
        },
        agentDetails,
      );
      outputScope.dispose();
    });

    invokeScope.dispose();

    console.log(
      "\nDone. The contextualTokenResolver received the agentic user ID from span context.",
    );
  });
}

main().catch(console.error);
