# A365

Short guide for A365-specific APIs in this package.

Use the [main README](./README.md) for configuration and environment variables.
Use [Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability?tabs=nodejs) for full product documentation.

## What Is Here

- Manual scopes: `InvokeAgentScope`, `ExecuteToolScope`, `InferenceScope`, `OutputScope`
- Baggage and trace-context helpers
- Hosting middleware helper: `configureA365Hosting`

## Manual Scopes

Use scopes when you want explicit spans for agent, tool, inference, or output work.

```typescript
import {
  ExecuteToolScope,
  InferenceOperationType,
  InferenceScope,
  InvokeAgentScope,
} from "@microsoft/opentelemetry";

const invokeScope = InvokeAgentScope.start(
  { conversationId: "conv-123", sessionId: "session-456" },
  {},
  { agentId: "agent-1", tenantId: "tenant-1" },
);

invokeScope.run(async () => {
  const toolScope = ExecuteToolScope.start(
    { conversationId: "conv-123" },
    { toolName: "Search", input: { query: "hello" } },
    { agentId: "agent-1", tenantId: "tenant-1" },
  );

  const inferenceScope = InferenceScope.start(
    { conversationId: "conv-123" },
    { operationName: InferenceOperationType.ChatCompletion },
    { agentId: "agent-1", tenantId: "tenant-1" },
  );

  toolScope.dispose();
  inferenceScope.dispose();
});

invokeScope.dispose();
```

## Baggage And Context

Use `BaggageBuilder` when you want tenant, agent, user, conversation, or session data to flow with the active context.

```typescript
import { BaggageBuilder, injectContextToHeaders } from "@microsoft/opentelemetry";

const baggageScope = new BaggageBuilder()
  .tenantId("tenant-1")
  .agentId("agent-1")
  .conversationId("conv-123")
  .sessionId("session-456")
  .build();

baggageScope.run(() => {
  const headers: Record<string, string> = {};
  injectContextToHeaders(headers);
});
```

## Hosting

Use `configureA365Hosting` to register the A365 middleware on an adapter.

```typescript
import { configureA365Hosting } from "@microsoft/opentelemetry";

configureA365Hosting(adapter, {
  enableBaggage: true,
  enableOutputLogging: false,
});
```

Set `enableOutputLogging: false` if response content should not be captured.
