# A365 GenAI Scope Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich supported LangChain and OpenAI Agents spans when their final GenAI operation is unavailable at span start, including configured OpenAI tracer names.

**Architecture:** `A365SpanProcessor` will classify spans from recognized initial operations, exact span-name boundaries, or an exact supported instrumentation scope. The processor owns the two default JavaScript scope names and accepts additional exact names from distro configuration; exporter filtering remains based on final operation names.

**Tech Stack:** TypeScript, OpenTelemetry JS SDK, Vitest, npm.

## Global Constraints

- Match instrumentation scope names exactly; do not accept prefixes or dotted descendants.
- Recognize `microsoft-otel-langchain`, `microsoft-otel-openai-agents`, and the resolved custom OpenAI Agents `tracerName`.
- Explicit unrecognized operations remain authoritative over span-name inference.
- Unknown operations under supported scopes receive generic and registered custom baggage, but not invoke-agent-only baggage.
- Do not change A365 exporter eligibility or read operation classification from ambient baggage.

---

### Task 1: Add exact-scope span classification

**Files:**
- Modify: `test/internal/unit/a365/a365SpanProcessor.test.ts`
- Modify: `src/a365/processors/A365SpanProcessor.ts`

**Interfaces:**
- Consumes: `GEN_AI_OPERATION_NAMES: ReadonlySet<string>`, `Span.instrumentationScope.name` from the SDK span implementation.
- Produces: `new A365SpanProcessor(additionalGenAiInstrumentationScopeNames?: Iterable<string>)`.

- [ ] **Step 1: Write failing processor tests**

Add test helpers that allow the tracer scope, span name, and optional initial operation to be selected:

```ts
function startSpan(
  provider: BasicTracerProvider,
  {
    tracerName = "test",
    spanName,
    operationName,
    baggage = {},
  }: {
    tracerName?: string;
    spanName: string;
    operationName?: string;
    baggage?: Record<string, string>;
  },
) {
  const ctx = propagation.setBaggage(context.active(), createBaggage(baggage));
  return provider.getTracer(tracerName).startSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      ...(operationName
        ? {
            attributes: {
              [OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY]: operationName,
            },
          }
        : {}),
    },
    ctx,
  );
}
```

Add cases asserting:

```ts
it.each(["microsoft-otel-langchain", "microsoft-otel-openai-agents"])(
  "copies generic and registered custom baggage for supported scope %s without an initial operation",
  (tracerName) => {
    const span = startSpan(provider, {
      tracerName,
      spanName: "unmodeled operation",
      baggage: {
        [OpenTelemetryConstants.TENANT_ID_KEY]: "tenant-123",
        [OpenTelemetryConstants.GEN_AI_CALLER_AGENT_ID_KEY]: "caller-123",
        [INTERNAL_CUSTOM_KEYS_METADATA_KEY]: "custom.one",
        "custom.one": "value-1",
      },
    });
    span.end();

    const attributes = memoryExporter.getFinishedSpans()[0].attributes;
    expect(attributes[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
    expect(attributes["custom.one"]).toBe("value-1");
    expect(attributes[OpenTelemetryConstants.GEN_AI_CALLER_AGENT_ID_KEY]).toBeUndefined();
  },
);
```

Also add tests for:

```ts
// Exact matching only.
tracerName: "microsoft-otel-langchain.child" // untouched

// Span-name boundary recognition.
spanName: "invoke_agent planner" // invoke-agent baggage copied
spanName: "invoke_agent_toolbox" // untouched

// Explicit unknown operation blocks span-name inference.
tracerName: "microsoft-otel-langchain"
spanName: "invoke_agent planner"
operationName: "chain" // generic/custom copied; invoke-agent baggage omitted

// Constructor-provided custom scope.
const customProcessor = new A365SpanProcessor(["custom-openai-scope"]);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
$nodeDir = 'C:\Users\nikhilc\AppData\Roaming\nvm\v22.14.0'
$env:PATH = "$nodeDir;$env:PATH"
& "$nodeDir\npx.cmd" vitest run test/internal/unit/a365/a365SpanProcessor.test.ts
```

Expected: the new supported-scope and custom-scope cases fail because the processor currently requires a recognized initial operation.

- [ ] **Step 3: Implement exact-scope classification**

In `A365SpanProcessor.ts`, add:

```ts
const DEFAULT_GEN_AI_INSTRUMENTATION_SCOPE_NAMES: readonly string[] = [
  "microsoft-otel-langchain",
  "microsoft-otel-openai-agents",
];

function getOperationFromSpanName(spanName: unknown): string | undefined {
  if (typeof spanName !== "string") {
    return undefined;
  }

  for (const operationName of GEN_AI_OPERATION_NAMES) {
    if (spanName === operationName || spanName.startsWith(`${operationName} `)) {
      return operationName;
    }
  }

  return undefined;
}
```

Add an exact-name set:

```ts
private readonly genAiInstrumentationScopeNames = new Set<string>(
  DEFAULT_GEN_AI_INSTRUMENTATION_SCOPE_NAMES,
);

constructor(additionalGenAiInstrumentationScopeNames: Iterable<string> = []) {
  for (const scopeName of additionalGenAiInstrumentationScopeNames) {
    const normalizedScopeName = scopeName.trim();
    if (normalizedScopeName) {
      this.genAiInstrumentationScopeNames.add(normalizedScopeName);
    }
  }
}
```

Replace the current operation-only gate with:

```ts
const spanRecord = span as Span & {
  attributes?: Record<string, unknown>;
  name?: string;
  instrumentationScope?: { name?: string };
};
const explicitOperation = spanRecord.attributes?.[
  OpenTelemetryConstants.GEN_AI_OPERATION_NAME_KEY
];
const recognizedExplicitOperation =
  typeof explicitOperation === "string" && GEN_AI_OPERATION_NAMES.has(explicitOperation)
    ? explicitOperation
    : undefined;
const inferredOperation =
  explicitOperation === undefined ? getOperationFromSpanName(spanRecord.name) : undefined;
const operationName = recognizedExplicitOperation ?? inferredOperation;
const supportedScope =
  typeof spanRecord.instrumentationScope?.name === "string" &&
  this.genAiInstrumentationScopeNames.has(spanRecord.instrumentationScope.name);

if (!operationName && !supportedScope) {
  return;
}
```

Use only the classified operation for invoke-agent baggage:

```ts
const isInvokeAgent =
  operationName === OpenTelemetryConstants.INVOKE_AGENT_OPERATION_NAME;
```

- [ ] **Step 4: Run focused tests and verify success**

Run:

```powershell
& "$nodeDir\npx.cmd" vitest run test/internal/unit/a365/a365SpanProcessor.test.ts
```

Expected: all `A365SpanProcessor` tests pass, including exact-scope and precedence cases.

- [ ] **Step 5: Commit processor classification**

```powershell
git add src/a365/processors/A365SpanProcessor.ts test/internal/unit/a365/a365SpanProcessor.test.ts
git commit -m "fix(a365): classify supported GenAI instrumentation scopes"
```

---

### Task 2: Wire configured OpenAI tracer names

**Files:**
- Modify: `test/internal/unit/main.test.ts:1185-1212`
- Modify: `src/distro/distro.ts:321-328`

**Interfaces:**
- Consumes: `A365SpanProcessor(additionalGenAiInstrumentationScopeNames?: Iterable<string>)`.
- Produces: distro registration that passes `config.instrumentationOptions.openaiAgents?.tracerName`.

- [ ] **Step 1: Write a failing distro configuration test**

Add a test near the existing A365 processor registration case:

```ts
it("passes a configured OpenAI tracer name to A365SpanProcessor", async () => {
  useMicrosoftOpenTelemetry({
    azureMonitor: { enabled: false },
    enableConsoleExporters: false,
    a365: {
      enabled: true,
      tokenResolver: () => "token",
    },
    instrumentationOptions: {
      openaiAgents: {
        enabled: false,
        tracerName: "custom-openai-scope",
      },
      langchain: { enabled: false },
    },
  });

  const internalSdk = _getSdkInstance();
  const tracerProvider = (internalSdk as any)["_tracerProvider"];
  const registeredProcessors =
    tracerProvider?.["_activeSpanProcessor"]?.["_spanProcessors"] || [];
  const processor = registeredProcessors.find(
    (candidate: any) => candidate.constructor?.name === "A365SpanProcessor",
  );

  assert.isDefined(processor);
  assert.isTrue(processor["genAiInstrumentationScopeNames"].has("custom-openai-scope"));

  await shutdownMicrosoftOpenTelemetry();
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```powershell
& "$nodeDir\npx.cmd" vitest run --config vitest.unit.config.ts test/internal/unit/main.test.ts
```

Expected: the new assertion fails because distro initialization currently constructs `A365SpanProcessor` without the configured tracer name.

- [ ] **Step 3: Pass the resolved custom scope**

Replace the registration in `src/distro/distro.ts` with:

```ts
const configuredOpenAiTracerName =
  config.instrumentationOptions.openaiAgents?.tracerName;
spanProcessors.push(
  new A365SpanProcessor(
    configuredOpenAiTracerName ? [configuredOpenAiTracerName] : [],
  ),
);
```

- [ ] **Step 4: Run the focused unit test**

Run:

```powershell
& "$nodeDir\npx.cmd" vitest run --config vitest.unit.config.ts test/internal/unit/main.test.ts
```

Expected: all main unit tests pass.

- [ ] **Step 5: Commit configuration wiring**

```powershell
git add src/distro/distro.ts test/internal/unit/main.test.ts
git commit -m "fix(a365): register configured OpenAI tracer scope"
```

---

### Task 3: Verify real producer lifecycle and documentation

**Files:**
- Modify: `test/internal/functional/genai-distro.test.ts`
- Modify: `test/internal/functional/genai-openai-distro.test.ts`
- Modify: `A365_DOCUMENTATION.md:131-140`

**Interfaces:**
- Consumes: scope-aware `A365SpanProcessor` registered through `useMicrosoftOpenTelemetry`.
- Produces: functional regression coverage for actual LangChain and OpenAI Agents adapters.

- [ ] **Step 1: Add failing LangChain enrichment coverage**

Update the existing functional initialization to enable A365 and run the adapter under baggage:

```ts
const baggage = propagation
  .createBaggage()
  .setEntry(OpenTelemetryConstants.TENANT_ID_KEY, { value: "tenant-123" })
  .setEntry("_internal.custom_keys", { value: "custom.scope" })
  .setEntry("custom.scope", { value: "langchain" });
const ctx = propagation.setBaggage(context.active(), baggage);

await context.with(ctx, async () => {
  await langChainTracer.onRunCreate(run);
  await langChainTracer._endTrace(run);
});
```

Configure:

```ts
a365: {
  enabled: true,
  tokenResolver: () => "token",
},
```

Assert the finished LangChain span contains:

```ts
expect(chatSpan?.attributes[OpenTelemetryConstants.TENANT_ID_KEY]).toBe("tenant-123");
expect(chatSpan?.attributes["custom.scope"]).toBe("langchain");
```

- [ ] **Step 2: Add custom OpenAI tracer enrichment coverage**

Configure the OpenAI functional test with:

```ts
a365: {
  enabled: true,
  tokenResolver: () => "token",
},
instrumentationOptions: {
  openaiAgents: {
    enabled: true,
    tracerName: "custom-openai-scope",
    isContentRecordingEnabled: true,
  },
  langchain: { enabled: false },
},
```

Run the existing OpenAI generation under baggage registered with
`_internal.custom_keys`, then assert:

```ts
expect(chatSpan?.instrumentationScope.name).toBe("custom-openai-scope");
expect(chatSpan?.attributes["custom.scope"]).toBe("openai");
```

Add a processor-level MCP lifecycle case in
`test/internal/unit/a365/a365SpanProcessor.test.ts` using the supported OpenAI
scope, initial operation `chain`, and a later `span.setAttribute()` to
`execute_tool`. Assert generic/custom baggage was applied at start and
invoke-agent-only baggage was omitted.

- [ ] **Step 3: Run functional and processor tests**

Run:

```powershell
& "$nodeDir\npx.cmd" vitest run --config vitest.functional.config.ts test/internal/functional/genai-distro.test.ts test/internal/functional/genai-openai-distro.test.ts
& "$nodeDir\npx.cmd" vitest run test/internal/unit/a365/a365SpanProcessor.test.ts
```

Expected: all selected tests pass. The source-defined scope identities and emitted functional spans agree, so no external service sample run is required.

- [ ] **Step 4: Document scope fallback**

Add to `A365_DOCUMENTATION.md`:

```md
For the built-in LangChain and OpenAI Agents instrumentations, enrichment also
recognizes their exact instrumentation scope names when the final GenAI
operation is not available at span start. A configured OpenAI Agents
`tracerName` is registered as an exact supported scope. Scope prefixes and
unrelated child scopes are not matched.
```

- [ ] **Step 5: Run complete verification**

Run:

```powershell
& "$nodeDir\npm.cmd" run format
& "$nodeDir\npm.cmd" run lint
& "$nodeDir\npm.cmd" run build
& "$nodeDir\npm.cmd" test
git diff --check
```

Expected: formatting, lint, build, and all tests succeed with no merge markers or whitespace errors.

- [ ] **Step 6: Commit functional coverage and documentation**

```powershell
git add test/internal/functional/genai-distro.test.ts test/internal/functional/genai-openai-distro.test.ts test/internal/unit/a365/a365SpanProcessor.test.ts A365_DOCUMENTATION.md
git commit -m "test(a365): cover GenAI scope fallback lifecycle"
```

- [ ] **Step 7: Push and verify the PR**

```powershell
git push origin feature/a365-custom-baggage
gh pr view 242 --repo microsoft/opentelemetry-distro-javascript --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup
```

Expected: the remote head matches local `HEAD`, the PR is mergeable, and CI starts for the pushed commits.
