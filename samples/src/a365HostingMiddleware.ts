// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @summary Demonstrates how to use A365 hosting observability middleware.
 *
 * This sample shows how the hosting package works with an `@microsoft/agents-hosting`
 * compatible adapter. The middleware automatically:
 *   - Extracts baggage (tenant, agent, caller, channel, conversation) from TurnContext
 *   - Creates OutputScope spans for outgoing messages
 *   - Links output spans to a parent InvokeAgentScope
 *
 * Since this sample does not require a running agents-hosting server, it uses
 * mock objects that satisfy the TurnContextLike/MiddlewareLike interfaces.
 */

import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,

  // Hosting middleware
  BaggageMiddleware,
  OutputLoggingMiddleware,
  ObservabilityHostingManager,
  A365_PARENT_SPAN_KEY,
  A365_AUTH_TOKEN_KEY,

  // Hosting utilities
  BaggageBuilderUtils,
  ScopeUtils,
  BaggageBuilder,

  // Scopes — used to create the parent InvokeAgentScope
  InvokeAgentScope,
  InferenceScope,
  InferenceOperationType,
} from "@microsoft/opentelemetry";
import type {
  TurnContextLike,
  ActivityLike,
  MiddlewareLike,
  AgentDetails,
  InferenceDetails,
} from "@microsoft/opentelemetry";
import "dotenv/config";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function myTokenResolver(agentId: string, tenantId: string): Promise<string> {
  console.log(`  [auth] Resolving token for agent=${agentId}, tenant=${tenantId}`);
  return process.env.A365_BEARER_TOKEN || "<token>";
}

/**
 * Creates a mock TurnContext that looks like an incoming agents-hosting request.
 * In production, this object is created by the adapter from an incoming Activity.
 */
function createMockTurnContext(): TurnContextLike {
  const activity: ActivityLike = {
    type: "message",
    text: "What's the weather in Seattle?",
    channelId: "msteams",
    channelIdSubChannel: "general",
    serviceUrl: "https://smba.trafficmanager.net/teams/",
    from: {
      aadObjectId: "user-aad-object-id-123",
      name: "Jane Doe",
      agenticUserId: "jane@contoso.com",
      agenticAppBlueprintId: "caller-blueprint-001",
    },
    recipient: {
      aadObjectId: "agent-aad-object-id-456",
      name: "WeatherBot",
      role: "An agent that answers weather questions",
    },
    conversation: {
      id: "conv-12345",
    },
    isAgenticRequest: () => true,
    getAgenticInstanceId: () => "weather-agent-001",
    getAgenticTenantId: () => "contoso-tenant-id",
    getAgenticUser: () => "weatherbot@contoso.com",
  };

  const turnState = new Map<string, unknown>();
  const sendHandlers: Array<
    (
      ctx: TurnContextLike,
      activities: ActivityLike[],
      next: () => Promise<unknown[]>,
    ) => Promise<unknown[]>
  > = [];

  return {
    activity,
    turnState,
    onSendActivities(handler) {
      sendHandlers.push(handler);
    },
    // Simulated sendActivity — runs through registered handlers
    async sendActivity(text: string): Promise<void> {
      const outgoing: ActivityLike[] = [{ type: "message", text }];
      const sendNext = async () => {
        console.log(`  [adapter] Sending message: "${text}"`);
        return [{ id: "msg-001" }];
      };
      // Run through handlers (last registered first, like real adapter)
      let chain = sendNext;
      for (const h of [...sendHandlers].reverse()) {
        const prev = chain;
        chain = () =>
          h(this as unknown as TurnContextLike, outgoing, prev as () => Promise<unknown[]>);
      }
      await chain();
    },
  } as TurnContextLike & { sendActivity(text: string): Promise<void> };
}

// ────────────────────────────────────────────────────────────────────────────
// Demo 1: ObservabilityHostingManager (simplest setup)
// ────────────────────────────────────────────────────────────────────────────

function demoHostingManager(): void {
  console.log("\n=== Demo 1: ObservabilityHostingManager ===\n");

  // In production this would be your real adapter instance
  const registeredMiddleware: MiddlewareLike[] = [];
  const mockAdapter = {
    use(...mws: MiddlewareLike[]) {
      registeredMiddleware.push(...mws);
      console.log(`  [adapter] Registered ${mws.length} middleware(s)`);
    },
  };

  const manager = new ObservabilityHostingManager();
  manager.configure(mockAdapter, {
    enableBaggage: true,
    enableOutputLogging: true,
  });

  console.log(`  Registered middleware count: ${registeredMiddleware.length}`);
  console.log(`  Types: ${registeredMiddleware.map((m) => m.constructor.name).join(", ")}`);

  // Calling configure again is a no-op
  manager.configure(mockAdapter, { enableBaggage: true });
  console.log("  Second configure() call was ignored (as expected).");
}

// ────────────────────────────────────────────────────────────────────────────
// Demo 2: BaggageMiddleware — automatic baggage propagation
// ────────────────────────────────────────────────────────────────────────────

async function demoBaggageMiddleware(): Promise<void> {
  console.log("\n=== Demo 2: BaggageMiddleware ===\n");

  const middleware = new BaggageMiddleware();
  const ctx = createMockTurnContext();

  await middleware.onTurn(ctx, async () => {
    // Inside here, baggage is active in the OTel context.
    // Any spans created will be enriched by A365SpanProcessor.
    console.log("  Inside middleware — baggage is active");
    console.log("  Creating a span that will inherit baggage attributes...");

    // The BaggageBuilder can also be used manually for additional entries
    const builder = new BaggageBuilder().sessionId("session-xyz");
    BaggageBuilderUtils.fromTurnContext(builder, ctx);

    const scope = builder.build();
    await scope.run(async () => {
      console.log("  Inside BaggageScope — additional baggage applied");
    });
  });

  console.log("  Middleware turn completed.");
}

// ────────────────────────────────────────────────────────────────────────────
// Demo 3: OutputLoggingMiddleware — auto OutputScope on outgoing messages
// ────────────────────────────────────────────────────────────────────────────

async function demoOutputLoggingMiddleware(): Promise<void> {
  console.log("\n=== Demo 3: OutputLoggingMiddleware ===\n");

  const middleware = new OutputLoggingMiddleware();
  const ctx = createMockTurnContext() as TurnContextLike & {
    sendActivity(text: string): Promise<void>;
  };

  // Set the auth token so the middleware can derive agent details
  ctx.turnState.set(A365_AUTH_TOKEN_KEY, "<mock-token>");

  // Create an InvokeAgentScope and store its ref in turnState
  const invokeScope = InvokeAgentScope.start(
    { conversationId: "conv-12345" },
    {},
    {
      agentId: "weather-agent-001",
      agentName: "WeatherBot",
      tenantId: "contoso-tenant-id",
    },
  );
  ctx.turnState.set(A365_PARENT_SPAN_KEY, invokeScope.getParentSpanRef());
  console.log(`  InvokeAgentScope started (traceId: ${invokeScope.getSpanContext().traceId})`);

  await middleware.onTurn(ctx, async () => {
    // Simulate agent processing and sending a response
    console.log("  Agent processing request...");
    await ctx.sendActivity("It's 62°F and partly cloudy in Seattle.");
    console.log("  OutputLoggingMiddleware created an OutputScope span for the outgoing message.");
  });

  invokeScope.dispose();
  console.log("  InvokeAgentScope ended.");
}

// ────────────────────────────────────────────────────────────────────────────
// Demo 4: ScopeUtils — create scopes from TurnContext
// ────────────────────────────────────────────────────────────────────────────

async function demoScopeUtils(): Promise<void> {
  console.log("\n=== Demo 4: ScopeUtils — scopes from TurnContext ===\n");

  const ctx = createMockTurnContext();
  const authToken = "<mock-token>";

  // Derive agent/caller details
  const agent = ScopeUtils.deriveAgentDetails(ctx, authToken);
  console.log(`  Derived agent: ${agent?.agentName} (${agent?.agentId})`);

  const caller = ScopeUtils.deriveCallerDetails(ctx);
  console.log(`  Derived caller: ${caller?.userName} (${caller?.userId})`);

  const conversationId = ScopeUtils.deriveConversationId(ctx);
  console.log(`  Derived conversationId: ${conversationId}`);

  const channel = ScopeUtils.deriveChannelObject(ctx);
  console.log(`  Derived channel: ${channel.name} / ${channel.description}`);

  // Create an InferenceScope directly from TurnContext
  const inferenceDetails: InferenceDetails = {
    operationName: InferenceOperationType.CHAT,
    model: "gpt-4o",
    providerName: "azure-openai",
  };

  const inferenceScope = ScopeUtils.populateInferenceScopeFromTurnContext(
    inferenceDetails,
    ctx,
    authToken,
  );
  console.log(
    `  InferenceScope created from TurnContext (traceId: ${inferenceScope.getSpanContext().traceId})`,
  );
  console.log("  Input messages from activity.text were auto-recorded.");

  // Simulate response
  inferenceScope.recordOutputMessages(["It's 62°F and partly cloudy in Seattle."]);
  inferenceScope.recordInputTokens(45);
  inferenceScope.recordOutputTokens(12);
  inferenceScope.recordFinishReasons(["stop"]);
  inferenceScope.dispose();

  console.log("  InferenceScope completed.");
}

// ────────────────────────────────────────────────────────────────────────────
// Demo 5: Full agent turn with middleware
// ────────────────────────────────────────────────────────────────────────────

async function demoFullAgentTurn(): Promise<void> {
  console.log("\n=== Demo 5: Full Agent Turn with Middleware ===\n");

  const ctx = createMockTurnContext() as TurnContextLike & {
    sendActivity(text: string): Promise<void>;
  };
  const authToken = "<mock-token>";

  // Register middleware
  const baggageMiddleware = new BaggageMiddleware();
  const outputMiddleware = new OutputLoggingMiddleware();

  // Simulate the adapter pipeline: baggage → output → agent logic
  await baggageMiddleware.onTurn(ctx, async () => {
    console.log("  [baggage] Baggage context active");

    ctx.turnState.set(A365_AUTH_TOKEN_KEY, authToken);

    await outputMiddleware.onTurn(ctx, async () => {
      console.log("  [output] Output logging middleware active");

      // Agent logic
      const agentDetails: AgentDetails = ScopeUtils.buildInvokeAgentDetails(
        { agentName: "WeatherBot" } as AgentDetails,
        ctx,
        authToken,
      );

      const invokeScope = InvokeAgentScope.start(
        { conversationId: ctx.activity.conversation?.id },
        {},
        agentDetails,
      );
      ctx.turnState.set(A365_PARENT_SPAN_KEY, invokeScope.getParentSpanRef());

      try {
        console.log(`  [agent] Processing: "${ctx.activity.text}"`);

        // LLM inference
        const inference = ScopeUtils.populateInferenceScopeFromTurnContext(
          {
            operationName: InferenceOperationType.CHAT,
            model: "gpt-4o",
            providerName: "azure-openai",
          },
          ctx,
          authToken,
        );
        inference.recordOutputMessages(["It's 62°F and partly cloudy."]);
        inference.recordFinishReasons(["stop"]);
        inference.dispose();

        // Send response — OutputLoggingMiddleware will create an OutputScope span
        await ctx.sendActivity("It's 62°F and partly cloudy in Seattle.");

        invokeScope.recordResponse("It's 62°F and partly cloudy in Seattle.");
      } catch (err) {
        invokeScope.recordError(err as Error);
        throw err;
      } finally {
        invokeScope.dispose();
      }
    });
  });

  console.log("  Full turn completed.");
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
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

  console.log("=== A365 Hosting Middleware Demo ===");

  demoHostingManager();
  await demoBaggageMiddleware();
  await demoOutputLoggingMiddleware();
  await demoScopeUtils();
  await demoFullAgentTurn();

  console.log("\n=== All demos completed ===");

  await new Promise((resolve) => setTimeout(resolve, 3000));
  await shutdownMicrosoftOpenTelemetry();
  console.log("Done. Check your telemetry backend for traces.");
}

main().catch(console.error);
