---
name: a365-standalone-exporter-nodejs
description: Add the A365 standalone SpanExporter to a Node.js/TypeScript project that already has OpenTelemetry configured — no full distro required, just plug-in export to Agent 365
---

You are adding the `@a365/otel-exporter` standalone SpanExporter package to the user's existing Node.js/TypeScript project. This is the **lightweight** path for teams that already have OpenTelemetry tracing set up and want to add Agent 365 as an additional export destination — without adopting the full `@microsoft/opentelemetry` distro.

## When to use this vs the full distro

| Use standalone exporter (`@a365/otel-exporter`) | Use full distro (`@microsoft/opentelemetry`) |
|---|---|
| Already have a TracerProvider configured | Starting from scratch or want turnkey setup |
| Only need A365 export — keep your existing backends | Want auto-instrumentation for OpenAI/SK/LangChain |
| Minimal dependency footprint (2 peer deps) | Want scope classes (InvokeAgentScope, etc.) |
| Want full control over span creation | Want Express/Fastify hosting integration |

## Phase 1 — Analyze the project

Before writing any code, answer:

1. **Does the project already have a TracerProvider?** Look for `NodeTracerProvider`, `BasicTracerProvider`, or `@opentelemetry/sdk-node` `NodeSDK`.
2. **What span processors are configured?** Look for `SimpleSpanProcessor`, `BatchSpanProcessor`.
3. **Where are spans created?** Find `tracer.startSpan()` or `tracer.startActiveSpan()`.
4. **What auth mechanism is available?** Azure Identity, MSAL, or custom.
5. **Where does the agent get its identity?** Find tenant_id, agent_id in config/env.

State findings in 2-3 sentences, then proceed.

## Phase 2 — Implement

### INVARIANT RULES

1. **Span attributes are mandatory for routing.** The exporter groups spans by `tenant_id` / `agent_id` from span attributes (NOT baggage directly). Spans missing either are **silently skipped**. You must either use `setA365SpanAttributes()` or a SpanProcessor that copies baggage to attributes.
2. **Token resolver is async.** Signature: `(agentId: string, tenantId: string) => Promise<string | null>`. Return `null` to skip a group.
3. **`gen_ai.operation.name` must be set on every span.** Only spans with one of `invoke_agent`, `execute_tool`, `chat`, `output_messages` are processed by A365.
4. **All attribute values should be strings for A365 processing.** Token counts must be `"42"` not `42`; ports must be `"443"` not `443`.
5. **Do NOT add `?api-version=1`** — handled internally.
6. **Add as an additional processor** — do not replace existing exporters.
7. **BaggageBuilder does NOT auto-copy to span attributes.** You must ALSO call `setA365SpanAttributes()` or implement a custom SpanProcessor to copy baggage to attributes.

### Step 2.1 — Install

```bash
npm install @a365/otel-exporter
```

Peer dependencies (must already be in your project):
- `@opentelemetry/api` >= 1.4.0
- `@opentelemetry/sdk-trace-base` >= 1.15.0

Optional (only for built-in token resolvers):
- `@azure/identity` — for `createAzureIdentityResolver`
- `@azure/msal-node` — for `createMsalResolver`

### Step 2.2 — Create the exporter and add to TracerProvider

```typescript
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { A365SpanExporter } from '@a365/otel-exporter';

const a365Exporter = new A365SpanExporter({
  tokenResolver: myTokenResolver,
  // endpoint defaults to "https://agent365.svc.cloud.microsoft"
  // timeoutMs defaults to 30000
});

// Add alongside existing exporters — do NOT replace them
provider.addSpanProcessor(new SimpleSpanProcessor(a365Exporter));
```

### Step 2.3 — Set up token resolver

Pick one:

**Azure Identity (recommended for Azure-hosted workloads):**

```typescript
import { createAzureIdentityResolver } from '@a365/otel-exporter';

const resolver = createAzureIdentityResolver();
// Uses DefaultAzureCredential — managed identity, CLI, env vars
```

**MSAL Confidential Client (S2S):**

```typescript
import { createMsalResolver } from '@a365/otel-exporter';

const resolver = createMsalResolver({
  clientId: '<YOUR_APP_CLIENT_ID>',
  clientSecret: '<YOUR_CLIENT_SECRET>',
  tenantId: '<YOUR_AAD_TENANT_ID>',
  // authority defaults to https://login.microsoftonline.com/{tenantId}
  // scope defaults to 9b975845-388f-4429-889e-eab1ef63949c/.default
});
```

**Custom resolver:**

```typescript
const resolver = async (agentId: string, tenantId: string): Promise<string | null> => {
  const token = await myVaultClient.getToken(agentId, tenantId);
  return token; // return null to skip this group
};
```

The token must have scope `9b975845-388f-4429-889e-eab1ef63949c/.default` (resource: Agent 365 Observability) with app role `Agent365.Observability.OtelWrite`.

### Step 2.4 — Set A365 routing attributes on spans

The exporter reads `tenant_id` / `agent_id` (or `a365.tenant_id` / `a365.agent_id`) from span **attributes**. Two approaches:

**Option A — setA365SpanAttributes (recommended — direct and explicit):**

```typescript
import { setA365SpanAttributes } from '@a365/otel-exporter';

const span = tracer.startSpan('invoke_agent');
setA365SpanAttributes(span, TENANT_ID, AGENT_ID);
span.setAttribute('gen_ai.operation.name', 'invoke_agent');
// ... logic ...
span.end();
```

**Option B — BaggageBuilder (for request-scoped context):**

```typescript
import { BaggageBuilder, setA365SpanAttributes } from '@a365/otel-exporter';

new BaggageBuilder()
  .tenantId(TENANT_ID)
  .agentId(AGENT_ID)
  .conversationId(CONVERSATION_ID)
  .build()
  .run(() => {
    const span = tracer.startSpan('invoke_agent');
    // IMPORTANT: BaggageBuilder sets baggage, but you still need span attributes for routing
    setA365SpanAttributes(span, TENANT_ID, AGENT_ID);
    span.setAttribute('gen_ai.operation.name', 'invoke_agent');
    span.end();
  });
```

> **CRITICAL**: Unlike the Python exporter, the Node.js exporter reads routing values from span attributes only — not from baggage. If you use BaggageBuilder, you must still copy values to span attributes via `setA365SpanAttributes()` or a custom SpanProcessor.

### Step 2.5 — Set required span attributes for A365 ingestion

Beyond routing, A365 requires specific attributes per operation type. Set these on every span:

**All spans:**
```typescript
span.setAttribute('gen_ai.operation.name', 'invoke_agent'); // or chat/execute_tool/output_messages
span.setAttribute('gen_ai.agent.id', AGENT_ID);
span.setAttribute('gen_ai.agent.name', 'My Agent');
span.setAttribute('microsoft.a365.agent.blueprint.id', AGENT_ID);
span.setAttribute('gen_ai.conversation.id', conversationId);
span.setAttribute('microsoft.channel.name', 'web'); // or msteams, outlook
span.setAttribute('user.id', userAadObjectId);
span.setAttribute('client.address', callerIp);
span.setAttribute('server.address', 'myagent.example.com');
span.setAttribute('server.port', '443'); // STRING, not number
```

**`invoke_agent` spans** (additionally):
```typescript
span.setAttribute('gen_ai.input.messages', JSON.stringify([{role: 'user', content: '...'}]));
span.setAttribute('gen_ai.output.messages', JSON.stringify([{role: 'assistant', content: '...'}]));
```

**`chat` spans** (additionally):
```typescript
span.setAttribute('gen_ai.request.model', 'gpt-4o');
span.setAttribute('gen_ai.provider.name', 'openai');
span.setAttribute('gen_ai.usage.input_tokens', '150');  // STRING
span.setAttribute('gen_ai.usage.output_tokens', '42');  // STRING
```

**`execute_tool` spans** (additionally):
```typescript
span.setAttribute('gen_ai.tool.name', 'search_products');
span.setAttribute('gen_ai.tool.type', 'function');
span.setAttribute('gen_ai.tool.call.id', 'call_abc123');
span.setAttribute('gen_ai.tool.call.arguments', JSON.stringify({query: 'top products'}));
span.setAttribute('gen_ai.tool.call.result', JSON.stringify({results: [...]}));
```

### Step 2.6 — Complete integration example

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { A365SpanExporter, createAzureIdentityResolver, setA365SpanAttributes } from '@a365/otel-exporter';

// Setup — once at startup
const provider = new NodeTracerProvider();
provider.addSpanProcessor(new BatchSpanProcessor(new ConsoleSpanExporter())); // existing
provider.addSpanProcessor(new SimpleSpanProcessor(
  new A365SpanExporter({
    tokenResolver: createAzureIdentityResolver(),
  })
));
provider.register();

const tracer = provider.getTracer('my-agent', '1.0.0');

// Per-request — in the request handler
const TENANT_ID = '<customer-tenant-guid>';
const AGENT_ID = '<your-agent-aad-app-object-id>';

const span = tracer.startSpan('invoke_agent');
setA365SpanAttributes(span, TENANT_ID, AGENT_ID);
span.setAttribute('gen_ai.operation.name', 'invoke_agent');
span.setAttribute('gen_ai.agent.id', AGENT_ID);
span.setAttribute('gen_ai.agent.name', 'My Agent');
span.setAttribute('microsoft.a365.agent.blueprint.id', AGENT_ID);
span.setAttribute('gen_ai.conversation.id', 'conv-001');
span.setAttribute('microsoft.channel.name', 'web');
span.setAttribute('user.id', '<aad-user-objectid>');
span.setAttribute('client.address', '10.1.2.80');
span.setAttribute('server.address', 'myagent.example.com');
span.setAttribute('server.port', '443');
span.setAttribute('gen_ai.input.messages', JSON.stringify([{role: 'user', content: 'hello'}]));
// ... agent logic ...
span.setAttribute('gen_ai.output.messages', JSON.stringify([{role: 'assistant', content: 'hi'}]));
span.end();
```

### Step 2.7 — Using with startActiveSpan (nested spans)

```typescript
tracer.startActiveSpan('invoke_agent', (parentSpan) => {
  setA365SpanAttributes(parentSpan, TENANT_ID, AGENT_ID);
  parentSpan.setAttribute('gen_ai.operation.name', 'invoke_agent');
  // ... set other attributes ...

  tracer.startActiveSpan('chat', (childSpan) => {
    setA365SpanAttributes(childSpan, TENANT_ID, AGENT_ID);
    childSpan.setAttribute('gen_ai.operation.name', 'chat');
    childSpan.setAttribute('gen_ai.request.model', 'gpt-4o');
    // ... LLM call ...
    childSpan.end();
  });

  parentSpan.end();
});
```

## Phase 3 — Verify

Checklist:

```
[ ] @a365/otel-exporter installed
[ ] Peer deps @opentelemetry/api and @opentelemetry/sdk-trace-base present
[ ] A365SpanExporter added as an ADDITIONAL span processor (not replacing existing)
[ ] Token resolver configured and returning valid tokens
[ ] setA365SpanAttributes() called on every span (or custom SpanProcessor copies baggage)
[ ] gen_ai.operation.name set on every span (invoke_agent/execute_tool/chat/output_messages)
[ ] All required attributes set per operation type
[ ] Numeric values encoded as strings (token counts, port)
[ ] Child spans nested correctly under parent (startActiveSpan context)
```

Tell the user:
1. Run the agent and check console exporter output for spans
2. Verify in Defender advanced hunting after ~5 minutes (see KQL below)
3. If 200 OK but no data, check: M365 E7 license assigned, tenant consent granted

**Verification KQL:**
```kusto
let agentIdToFind = "YOUR-AGENT-ID";
CloudAppEvents
| where Timestamp > ago(1d)
| where ActionType in ("InvokeAgent", "InferenceCall", "ExecuteToolBySDK")
| extend resData = parse_json(tostring(RawEventData))
| where resData.AgentId == agentIdToFind or resData.TargetAgentId == agentIdToFind
| project Timestamp, ActionType, resData
| order by Timestamp desc
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No spans exported (DEBUG log: "skipped N span(s) missing tenant_id or agent_id") | `setA365SpanAttributes()` not called | Call `setA365SpanAttributes(span, tenantId, agentId)` on every span |
| Using BaggageBuilder but spans still skipped | Baggage is not auto-copied to attributes in JS exporter | Add explicit `setA365SpanAttributes()` call inside BaggageBuilder.run() |
| Token resolver returns null | Credential not configured or secret expired | Check `createAzureIdentityResolver()` — ensure `@azure/identity` is installed |
| HTTP 401 | Wrong token audience | Scope must be `9b975845-388f-4429-889e-eab1ef63949c/.default` |
| HTTP 403 | Agent ID mismatch or missing permission | URL agent_id must match token's `appid`/`azp` claim; grant `Agent365.Observability.OtelWrite` |
| 200 OK but no data in Defender | Silent drop — no M365 E7 license, or wrong `gen_ai.operation.name` | Ensure at least 1 user has M365 E7 license; use valid operation names |
| Export timeout | Default 30s too short for cold-start token resolution | Increase `timeoutMs` or pre-warm token cache |
| Token counts show as zero | Sent as number instead of string | Use `span.setAttribute('gen_ai.usage.input_tokens', '150')` — string value |
| Spans appear but run tree broken | Missing parent context in startActiveSpan | Use `startActiveSpan` to ensure parent-child relationships; same traceId required |
