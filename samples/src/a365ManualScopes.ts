// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to use the A365 manual telemetry scopes API.
 *
 * This sample shows how to trace a realistic AI agent flow:
 *   1. Receive a user request (InvokeAgentScope)
 *   2. Call an LLM for inference (InferenceScope)
 *   3. Execute a tool the LLM requested (ExecuteToolScope)
 *   4. Stream the final response (OutputScope)
 *   5. Propagate trace context across service boundaries
 *
 * All scopes create structured OpenTelemetry spans with gen-ai semantic
 * conventions and A365-specific attributes.
 */

import {
  useMicrosoftOpenTelemetry,
  InvokeAgentScope,
  InferenceScope,
  ExecuteToolScope,
  OutputScope,
  InferenceOperationType,
  MessageRole,
  injectContextToHeaders,
  runWithExtractedTraceContext,
} from "@microsoft/opentelemetry";
import type {
  AgentDetails,
  A365Request,
  InferenceDetails,
  ToolCallDetails,
} from "@microsoft/opentelemetry";
import "dotenv/config";

// ────────────────────────────────────────────────────────────────────────────
// Setup
// ────────────────────────────────────────────────────────────────────────────

async function myTokenResolver(agentId: string, tenantId: string): Promise<string> {
  console.log(`  [auth] Resolving token for agent=${agentId}, tenant=${tenantId}`);
  return process.env.A365_BEARER_TOKEN || "<token>";
}

// Shared agent identity used across all scopes
const agentDetails: AgentDetails = {
  agentId: "weather-agent-001",
  agentName: "WeatherBot",
  agentDescription: "An agent that answers weather questions",
  tenantId: "contoso-tenant-id",
  providerName: "contoso",
  agentVersion: "1.0.0",
};

// ────────────────────────────────────────────────────────────────────────────
// Simulated agent logic
// ────────────────────────────────────────────────────────────────────────────

/** Simulate an LLM inference call that decides to use a tool. */
async function callLLM(
  request: A365Request,
  parentScope: InvokeAgentScope,
): Promise<{ toolName: string; args: Record<string, unknown>; callId: string }> {
  const details: InferenceDetails = {
    operationName: InferenceOperationType.CHAT,
    model: "gpt-4o",
    providerName: "azure-openai",
    endpoint: { host: "contoso.openai.azure.com", port: 443 },
  };

  const scope = InferenceScope.start(request, details, agentDetails);
  try {
    // Record what we sent to the LLM
    scope.recordInputMessages([
      "You are a helpful weather assistant.",
      request.content as string,
    ]);

    // Simulate LLM response latency
    await new Promise((r) => setTimeout(r, 50));

    // LLM decided to call a tool
    scope.recordOutputMessages({
      version: "0.1.0",
      messages: [
        {
          role: MessageRole.ASSISTANT,
          parts: [
            { type: "text", content: "I need to check the weather. Let me look that up." },
            {
              type: "tool_call",
              name: "getWeather",
              id: "call_abc123",
              arguments: { city: "Seattle" },
            },
          ],
        },
      ],
    });
    scope.recordInputTokens(85);
    scope.recordOutputTokens(42);
    scope.recordFinishReasons(["tool_call"]);

    return { toolName: "getWeather", args: { city: "Seattle" }, callId: "call_abc123" };
  } catch (err) {
    scope.recordError(err as Error);
    throw err;
  } finally {
    scope.dispose();
  }
}

/** Simulate executing a tool that the LLM requested. */
async function executeTool(
  request: A365Request,
  tool: { toolName: string; args: Record<string, unknown>; callId: string },
): Promise<string> {
  const toolDetails: ToolCallDetails = {
    toolName: tool.toolName,
    arguments: tool.args,
    toolCallId: tool.callId,
    description: "Returns current weather for a given city",
    toolType: "function",
  };

  const scope = ExecuteToolScope.start(request, toolDetails, agentDetails);
  try {
    // Simulate tool execution
    await new Promise((r) => setTimeout(r, 30));
    const result = { temperature: 62, condition: "Partly cloudy", unit: "F" };

    scope.recordResponse(result);
    return JSON.stringify(result);
  } catch (err) {
    scope.recordError(err as Error);
    throw err;
  } finally {
    scope.dispose();
  }
}

/** Simulate a final LLM call to format the tool result into a natural language response. */
async function formatResponse(
  request: A365Request,
  toolResult: string,
): Promise<string> {
  const details: InferenceDetails = {
    operationName: InferenceOperationType.CHAT,
    model: "gpt-4o",
    providerName: "azure-openai",
  };

  const scope = InferenceScope.start(request, details, agentDetails);
  try {
    scope.recordInputMessages([
      `Tool result: ${toolResult}`,
      "Please summarize the weather for the user.",
    ]);

    await new Promise((r) => setTimeout(r, 40));

    const answer = "It's currently 62°F and partly cloudy in Seattle.";
    scope.recordOutputMessages([answer]);
    scope.recordInputTokens(60);
    scope.recordOutputTokens(18);
    scope.recordFinishReasons(["stop"]);

    return answer;
  } catch (err) {
    scope.recordError(err as Error);
    throw err;
  } finally {
    scope.dispose();
  }
}

/** Record the final streamed output. */
function recordOutput(request: A365Request, answer: string): void {
  const scope = OutputScope.start(
    request,
    { messages: [answer] },
    agentDetails,
  );
  scope.dispose();
}

// ────────────────────────────────────────────────────────────────────────────
// Trace context propagation demo
// ────────────────────────────────────────────────────────────────────────────

/** Shows how to propagate trace context across HTTP service boundaries. */
function demonstrateContextPropagation(): void {
  console.log("\n--- Context Propagation Demo ---");

  // SERVICE A: inject the current trace context into outgoing HTTP headers
  const outgoingHeaders: Record<string, string> = {};
  injectContextToHeaders(outgoingHeaders);
  console.log("  Injected headers:", outgoingHeaders);

  // SERVICE B: extract trace context from incoming headers and run in that context
  runWithExtractedTraceContext(outgoingHeaders, () => {
    // Any spans created here will be children of Service A's active span
    const scope = InvokeAgentScope.start(
      { conversationId: "cross-service-conv" },
      { endpoint: { host: "service-b.internal", port: 8080 } },
      { ...agentDetails, agentId: "downstream-agent", agentName: "DownstreamBot", tenantId: "contoso-tenant-id" },
    );
    console.log("  Created child span in Service B, traceId:", scope.getSpanContext().traceId);
    scope.recordResponse("Handled by downstream agent");
    scope.dispose();
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Initialize the distro with A365 export enabled
  useMicrosoftOpenTelemetry({
    azureMonitor: {
      azureMonitorExporterOptions: {
        connectionString:
          process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || "<your connection string>",
      },
    },
    a365: {
      enabled: true,
      tokenResolver: myTokenResolver,
      clusterCategory: "dev",
    },
  });

  // ── Simulate an incoming user request ──────────────────────────────────
  const request: A365Request = {
    conversationId: "conv-12345",
    sessionId: "session-abc",
    channel: { name: "Teams", description: "https://teams.microsoft.com" },
    content: "What's the weather in Seattle?",
  };

  console.log("=== A365 Manual Telemetry Scopes Demo ===\n");

  // 1️⃣ InvokeAgentScope — wraps the entire agent invocation
  const invokeScope = InvokeAgentScope.start(
    request,
    {},
    agentDetails,
    {
      userDetails: {
        userId: "user-jane-doe",
        userName: "Jane Doe",
        userEmail: "jane@contoso.com",
        tenantId: "contoso-tenant-id",
      },
    },
  );

  try {
    console.log("1. InvokeAgentScope started");
    console.log(`   traceId: ${invokeScope.getSpanContext().traceId}`);

    // 2️⃣ InferenceScope — first LLM call (decides to use a tool)
    console.log("2. Calling LLM (InferenceScope)...");
    const toolCall = await callLLM(request, invokeScope);
    console.log(`   LLM wants to call tool: ${toolCall.toolName}(${JSON.stringify(toolCall.args)})`);

    // 3️⃣ ExecuteToolScope — run the tool
    console.log("3. Executing tool (ExecuteToolScope)...");
    const toolResult = await executeTool(request, toolCall);
    console.log(`   Tool result: ${toolResult}`);

    // 4️⃣ InferenceScope — second LLM call (format the answer)
    console.log("4. Formatting response (InferenceScope)...");
    const answer = await formatResponse(request, toolResult);
    console.log(`   Final answer: ${answer}`);

    // 5️⃣ OutputScope — record the streamed output
    console.log("5. Recording output (OutputScope)...");
    recordOutput(request, answer);

    // Record the final response on the invoke scope
    invokeScope.recordResponse(answer);
    console.log("\nAll scopes completed successfully.");

    // 6️⃣ Context propagation across services
    demonstrateContextPropagation();
  } catch (err) {
    invokeScope.recordError(err as Error);
    console.error("Agent invocation failed:", err);
  } finally {
    invokeScope.dispose();
  }

  // Give the batch processor time to flush
  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log("\nDone. Check your telemetry backend for the trace.");
}

main().catch(console.error);
