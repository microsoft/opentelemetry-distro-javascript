---
name: otel-distro-nodejs
description: Integrate Microsoft OpenTelemetry Distro into a Node.js/TypeScript AI agent project — unified observability with Agent 365, Azure Monitor, and OTLP export
user-invocable: true
---

You are integrating the Microsoft OpenTelemetry Distro into the user's existing Node.js/TypeScript AI agent project. This is the new unified distro that replaces the old fragmented `@microsoft/agents-a365-observability` packages with a single `@microsoft/opentelemetry` package.

The user may optionally provide arguments specifying their AI framework, whether they use Bot Framework hosting, or other constraints. If not provided, you will discover these by reading their code.

## Phase 1 — Analyze the project

Before writing any code, read the project to answer these questions:

1. **Which AI framework does it use?** Look for: OpenAI Agents SDK (`@openai/agents`), LangChain (`langchain`, `@langchain/core`), or none/custom.
2. **Does the project use Bot Framework hosting?** Search for imports from `@microsoft/agents-hosting` or `botbuilder`. This determines the hosting vs standalone path.
3. **Where is the agent entry point?** Find the function or method that handles incoming messages (activity handler, Express route, etc.).
4. **Where is app startup?** Find where the application initializes (e.g., `app.ts`, `index.ts`, `server.ts`).
5. **What is the agent's identity?** Look for existing agent_id, tenant_id, blueprint_id values in config, env vars, or code.
6. **Is there an existing package.json?** Check which package manager is used (npm, pnpm, yarn).
7. **Is the project already using old A365 SDK packages?** Check for `@microsoft/agents-a365-observability` imports. If so, this is a migration.

State your findings to the user in 3-4 sentences, then proceed.

## Phase 2 — Choose integration path

Follow this decision tree exactly:

```
Uses Bot Framework hosting (@microsoft/agents-hosting)?
├─ YES → HOSTED PATH: configureA365Hosting() + AgenticTokenCache
│    Framework?
│    ├─ OpenAI Agents SDK → auto-instrument via instrumentationOptions
│    ├─ LangChain         → auto-instrument via instrumentationOptions
│    └─ Other/custom      → manual instrumentation (scope classes)
│
└─ NO → STANDALONE PATH: manual BaggageBuilder + token resolver
     Framework?
     ├─ Supported → auto-instrument via instrumentationOptions
     └─ Other     → manual instrumentation (scope classes)
```

Note: Semantic Kernel and Agent Framework auto-instrumentation are NOT available in Node.js. Use manual instrumentation for those frameworks.

## Phase 3 — Implement

### INVARIANT RULES — Violating any of these produces a broken integration

1. **Baggage is mandatory.** The exporter partitions spans by `(tenant_id, agent_id)`. Spans missing either value are **silently dropped**. Every code path that creates scopes MUST be inside a `BaggageBuilder` context with both `.tenantId(...)` and `.agentId(...)`.
2. **Scope nesting order:** `BaggageBuilder.build().run()` → `InvokeAgentScope.start()` → `InferenceScope.start()` / `ExecuteToolScope.start()`. Inference and tool scopes are children of the invoke scope.
3. **Four scopes available:** `InvokeAgentScope`, `InferenceScope`, `ExecuteToolScope`, `OutputScope`. The first three are required for M365 store publishing.
4. **`useMicrosoftOpenTelemetry()` is called once at app startup.** Call as early as possible so instrumentations patch libraries before they load. Never call it per-request.
5. **Token resolver signature:** `(agentId: string, tenantId: string, authScopes?: string[]) => string | null | Promise<string | null>`.
6. **ESM apps:** Require Node.js 20.6.0+. Register instrumentation hooks before importing instrumented modules: `node --import @microsoft/opentelemetry/loader ./dist/index.js`
7. **Auto-instrumentation still requires baggage.** It does NOT set baggage for you.
8. **Do not mix auto and manual instrumentation for the same framework.**
9. **A365-only mode:** When A365 is enabled without Azure Monitor, HTTP/DB/Azure SDK instrumentations are auto-disabled. GenAI instrumentations stay enabled. Override with `instrumentationOptions` if needed.

### Step 3.1 — Install package

```bash
npm install @microsoft/opentelemetry
# or: pnpm add @microsoft/opentelemetry
# or: yarn add @microsoft/opentelemetry
```

If migrating from old SDK, remove:
```bash
npm uninstall @microsoft/agents-a365-observability @microsoft/agents-a365-observability-hosting @microsoft/agents-a365-observability-extensions-openai @microsoft/agents-a365-observability-extensions-langchain @microsoft/agents-a365-runtime
```

### Step 3.2 — Add observability configuration to app startup

Use this exact import. Do not guess module paths.

```typescript
import { useMicrosoftOpenTelemetry } from '@microsoft/opentelemetry';
```

Call once, as early as possible in the app entry point:

```typescript
useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: myTokenResolver,
  },
  instrumentationOptions: {
    openaiAgents: { enabled: true },  // if using OpenAI Agents SDK
    langchain: { enabled: true },     // if using LangChain
  },
});
```

To set service identity:

```typescript
import { resourceFromAttributes } from '@opentelemetry/resources';

useMicrosoftOpenTelemetry({
  resource: resourceFromAttributes({
    'service.name': '<infer from project>',
    'service.version': '<version>',
  }),
  a365: {
    enabled: true,
    tokenResolver: myTokenResolver,
  },
});
```

**Shutdown:** For clean export flush, call before process exit:
```typescript
import { shutdownMicrosoftOpenTelemetry } from '@microsoft/opentelemetry';
await shutdownMicrosoftOpenTelemetry();
```

### Step 3.3 — Set up token resolver

**Hosted path** — use `AgenticTokenCacheInstance`:
```typescript
import {
  useMicrosoftOpenTelemetry,
  AgenticTokenCacheInstance,
} from '@microsoft/opentelemetry';

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: (agentId, tenantId) =>
      AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId),
  },
});
```

**Hosted one-liner** — use `configureA365Hosting` which handles baggage and token plumbing:
```typescript
import { configureA365Hosting } from '@microsoft/opentelemetry';

configureA365Hosting(adapter, {
  enableBaggage: true,
  enableOutputLogging: false,
});
```

**Automatic (no resolver)** — the distro tries FIC then falls back to `DefaultAzureCredential`:
```typescript
useMicrosoftOpenTelemetry({
  a365: { enabled: true },
});
```

**Standalone path** — implement a manual resolver with MSAL or equivalent. The token must have scope `Agent365.Observability.OtelWrite` (resource ID `9b975845-388f-4429-889e-eab1ef63949c`). Leave a TODO comment for the user to fill in auth logic.

### Step 3.4 — Set up baggage

**Hosted path (preferred)** — register middleware:

Option A — Direct:
```typescript
import { BaggageMiddleware } from '@microsoft/opentelemetry';
adapter.use(new BaggageMiddleware());
```

Option B — ObservabilityHostingManager:
```typescript
import { ObservabilityHostingManager } from '@microsoft/opentelemetry';
new ObservabilityHostingManager().configure(adapter, {
  enableBaggage: true,
  enableOutputLogging: true,
});
```

Option C — One-liner:
```typescript
import { configureA365Hosting } from '@microsoft/opentelemetry';
configureA365Hosting(adapter, { enableBaggage: true, enableOutputLogging: false });
```

**Alternative hosted** — populate from TurnContext manually:
```typescript
import { BaggageBuilder, BaggageBuilderUtils } from '@microsoft/opentelemetry';

const baggageScope = BaggageBuilderUtils
  .fromTurnContext(new BaggageBuilder(), context)
  .build();

baggageScope.run(() => {
  // All spans created here inherit baggage values
});
```

**Standalone path** — manual BaggageBuilder in the request handler:
```typescript
import { BaggageBuilder } from '@microsoft/opentelemetry';

const baggageScope = new BaggageBuilder()
  .tenantId('<TENANT_ID>')
  .agentId('<AGENT_ID>')
  .conversationId('<CONV_ID>')
  .build();

baggageScope.run(() => {
  // All spans created here inherit baggage values
});
```

### Step 3.5 — Add instrumentation

**Auto-instrumentation** (configured in Step 3.2 via `instrumentationOptions`):

| Framework | Key |
|---|---|
| OpenAI Agents SDK | `openaiAgents: { enabled: true }` |
| LangChain | `langchain: { enabled: true }` |

No separate `.instrument()` or `.enable()` calls needed — the distro handles it automatically. If migrating, **remove** old `instrumentor.enable()` calls to avoid duplicate spans.

**Manual instrumentation** — wrap existing code with scope classes. Use these exact imports:

```typescript
import {
  InvokeAgentScope, ExecuteToolScope, InferenceScope, OutputScope,
  BaggageBuilder, InferenceOperationType,
} from '@microsoft/opentelemetry';
import type {
  AgentDetails, A365Request, InvokeAgentScopeDetails,
  InferenceDetails, ToolCallDetails, A365SpanDetails, OutputResponse,
} from '@microsoft/opentelemetry';
```

Note the API renames from old SDK: `Request` → `A365Request`, `SpanDetails` → `A365SpanDetails`.

Nest scopes in this order inside the baggage `run()` callback:

1. `InvokeAgentScope.start(request, scopeDetails, agentDetails)` — wraps the entire request handler. Use `try/finally { scope.dispose() }` pattern. Call `scope.recordInputMessages()`, `scope.recordOutputMessages()`.
2. `InferenceScope.start(request, inferenceDetails, agentDetails)` — wraps each LLM call. Call `scope.recordOutputMessages()`, `scope.recordInputTokens()`, `scope.recordOutputTokens()`, `scope.recordFinishReasons()`.
3. `ExecuteToolScope.start(request, toolDetails, agentDetails)` — wraps each tool call. Call `scope.recordResponse()`.
4. `OutputScope.start(request, response, agentDetails, undefined, { parentContext })` — for async output after invoke scope ends. Capture parent context via `invokeScope.getSpanContext()` before disposing.

All scopes use `try { await scope.withActiveSpanAsync(...) } catch { scope.recordError(error) } finally { scope.dispose() }`.

### Step 3.6 — Add environment variable

Ensure the project has `ENABLE_A365_OBSERVABILITY_EXPORTER` in its env config (`.env`, environment docs, etc.) set to `false` for development.

## Phase 4 — Verify

After making all changes, run through this checklist mentally and report status to the user:

```
[ ] @microsoft/opentelemetry installed (old A365 packages removed if migrating)
[ ] useMicrosoftOpenTelemetry() called once at app startup (as early as possible)
[ ] Token resolver provided (AgenticTokenCacheInstance, manual, or automatic FIC/DAC)
[ ] Baggage context established (middleware or manual BaggageBuilder) with tenantId AND agentId
[ ] InvokeAgentScope wraps the agent entry point
[ ] InferenceScope wraps every LLM call (or auto-instrumentation enabled)
[ ] ExecuteToolScope wraps every tool call (or auto-instrumentation enabled)
[ ] ENABLE_A365_OBSERVABILITY_EXPORTER env var documented
[ ] No per-request calls to useMicrosoftOpenTelemetry()
[ ] Scope nesting order correct: Baggage.run() → InvokeAgent → Inference/Tool
[ ] ESM apps use --import flag for loader
[ ] shutdownMicrosoftOpenTelemetry() called on process exit (if applicable)
```

Tell the user what to do next:
1. Install: `npm install @microsoft/opentelemetry`
2. Set `ENABLE_A365_OBSERVABILITY_EXPORTER=false` and run the agent to see console spans
3. If using the manual token resolver stub, implement the actual token acquisition
4. Set `ENABLE_A365_OBSERVABILITY_EXPORTER=true` and verify at `admin.cloud.microsoft/#/agents/all`

## Troubleshooting reference

| Symptom | Cause | Fix |
|---|---|---|
| No spans in admin center | Exporter not enabled | Set `ENABLE_A365_OBSERVABILITY_EXPORTER=true` and `a365: { enabled: true }` in code |
| "No spans with tenant/agent identity" | Missing baggage | Add `tenantId` AND `agentId` to BaggageBuilder |
| Export succeeds (HTTP 200) but no data in admin center | Spans accepted but not yet stored, or unsupported operation names | HTTP 200 means accepted, not stored. Verify spans use `invoke_agent`, `execute_tool`, `chat`, or `output_messages` as operation names. Data may take a few minutes to appear. |
| Token resolver returns null | Token not cached or not registered | Ensure AgenticTokenCacheInstance has tokens registered before export |
| HTTP 401 | Wrong token scope | Verify token has `Agent365.Observability.OtelWrite` scope |
| HTTP 403 | Missing license, permission, or tenant not enabled | Need M365 E7 / Agent 365 Frontier license; grant `Agent365.Observability.OtelWrite` via `a365 setup admin` or Entra portal (resource `9b975845-388f-4429-889e-eab1ef63949c`, both Delegated + Application). If license and permission are correct, contact the Agent 365 team — your tenant may not be enabled yet. |
| HTTP 429 / 5xx | Transient | SDK auto-retries on 408, 429, 5xx. If persistent, increase `a365.exporterOptions.scheduledDelayMilliseconds` |
| Timeout | Network / slow endpoint | Increase `a365.exporterOptions.httpRequestTimeoutMilliseconds` |
| Auto-instrumentation not working in ESM | Loader not registered | Use `node --import @microsoft/opentelemetry/loader ./dist/index.js` |
| Duplicate spans | Old instrumentor.enable() still called | Remove old `instrumentor.enable()` calls after migration |
| HTTP/DB spans missing | A365-only mode auto-disables them | Re-enable via `instrumentationOptions: { http: { enabled: true } }` |
