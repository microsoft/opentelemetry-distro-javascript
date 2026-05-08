# @a365/otel-exporter

A standalone OpenTelemetry SpanExporter that sends spans to the Agent 365
(A365) Observability Service. Designed for customers who already have their
own OpenTelemetry setup and want to add A365 as an additional export
destination -- just plug this exporter into your existing `TracerProvider`.

## Install

```bash
npm install @a365/otel-exporter
```

Peer dependencies (must already be in your project):

- `@opentelemetry/api` >= 1.4.0
- `@opentelemetry/sdk-trace-base` >= 1.15.0

Optional (only if using the built-in token resolvers):

- `@azure/identity` -- for `createAzureIdentityResolver`
- `@azure/msal-node` -- for `createMsalResolver`

## Quick start

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  A365SpanExporter,
  createAzureIdentityResolver,
  setA365SpanAttributes,
} from '@a365/otel-exporter';

// 1. Create the exporter with a token resolver
const exporter = new A365SpanExporter({
  tokenResolver: createAzureIdentityResolver(),
  // endpoint defaults to https://agent365.svc.cloud.microsoft
});

// 2. Add to your existing TracerProvider
const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

// 3. Tag spans with tenant_id and agent_id
const tracer = provider.getTracer('my-agent');
const span = tracer.startSpan('invoke_agent');
setA365SpanAttributes(span, '<tenant-id>', '<agent-id>');
span.end();
```

### Using BaggageBuilder

If you prefer to set A365 context via OTel baggage rather than per-span
attributes:

```typescript
import { BaggageBuilder } from '@a365/otel-exporter';

new BaggageBuilder()
  .tenantId('<tenant-id>')
  .agentId('<agent-id>')
  .conversationId('<conversation-id>')
  .build()
  .run(() => {
    const span = tracer.startSpan('invoke_agent');
    // baggage is available on the active context
    span.end();
  });
```

Note: The exporter reads span *attributes* (not baggage) for routing. You
still need to copy baggage values to span attributes via `setA365SpanAttributes`
or your own SpanProcessor / instrumentation logic.

## Token resolvers

### Azure Identity (DefaultAzureCredential)

```typescript
import { createAzureIdentityResolver } from '@a365/otel-exporter';

const resolver = createAzureIdentityResolver();
```

Uses `DefaultAzureCredential` from `@azure/identity`. Works with managed
identity, Azure CLI, environment variables, etc.

### MSAL Confidential Client

```typescript
import { createMsalResolver } from '@a365/otel-exporter';

const resolver = createMsalResolver({
  clientId: '<your-app-client-id>',
  clientSecret: '<your-app-client-secret>',
  tenantId: '<your-aad-tenant-id>',
});
```

### Custom resolver

```typescript
const resolver = async (agentId: string, tenantId: string) => {
  const token = await myCustomTokenLogic(agentId, tenantId);
  return token;  // return null to skip exporting for this group
};
```

## Required span attributes

The exporter groups spans by `tenant_id` and `agent_id` and routes each
group to the appropriate A365 ingestion endpoint. Spans missing either
attribute are silently skipped.

| Attribute              | Required | Description                          |
|------------------------|----------|--------------------------------------|
| `tenant_id`           | [YES]    | Azure AD tenant ID (GUID string)     |
| `agent_id`            | [YES]    | Agent identifier                     |
| `conversation_id`     | [NO]     | Conversation or session identifier   |
| `gen_ai.operation.name` | [NO]   | Operation type (see below)           |

### gen_ai.operation.name values

| Value              | Description                                      |
|--------------------|--------------------------------------------------|
| `invoke_agent`     | Top-level agent invocation                       |
| `execute_tool`     | Tool or plugin execution within an agent turn    |
| `chat`             | LLM chat completion call                         |
| `output_messages`  | Final response generation                        |

## Configuration

```typescript
interface A365ExporterOptions {
  // (required) Returns a Bearer token for a given agent/tenant pair.
  tokenResolver: TokenResolver;

  // Base URL. Default: "https://agent365.svc.cloud.microsoft"
  endpoint?: string;

  // HTTP timeout in ms. Default: 30000
  timeoutMs?: number;
}
```

## Requirements

- Node.js >= 18 (uses native `fetch`)
- TypeScript >= 5.0 (for development)

## License

MIT
