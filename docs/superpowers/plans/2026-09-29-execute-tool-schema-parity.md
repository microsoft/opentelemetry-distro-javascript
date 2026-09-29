# ExecuteTool Schema Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make typed ExecuteTool models and serialization match the current .NET and Python collision, metadata, validation, and failure behavior.

**Architecture:** Typed models expose `extension_data`, which the serializer emits under `metadata` instead of flattening into declared fields. A schema-aware recursive converter validates enum fields and JSON-compatible values before one final `JSON.stringify`, while legacy raw payloads keep the existing path.

**Tech Stack:** TypeScript, Vitest, OpenTelemetry JavaScript API, npm scripts.

## Global Constraints

- Preserve existing raw `Record<string, unknown>` and JSON string payload behavior.
- Emit the exact diagnostic JSON `{"serialization_error":"Failed to serialize execute tool payload."}` for every typed serialization failure.
- Omit nullish declared model fields and preserve explicit nulls inside mappings and arrays.
- Add no dependencies.

---

### Task 1: Public extension-data model contract

**Files:**
- Modify: `src/a365/tool-call-models.ts`
- Modify: `test/internal/unit/a365/executeToolJsonModels.test.ts`

**Interfaces:**
- Produces: `extension_data?: Record<string, unknown>` on every ExecuteTool schema model.
- Produces: `ExecuteToolCallArguments` and `ExecuteToolCallResult` constructors that copy only declared properties.

- [ ] **Step 1: Write failing model tests**

Add tests constructing top-level and nested models with:

```ts
const payload = new a365.ExecuteToolCallArguments({
  action: a365.ToolCallAction.READ,
  extension_data: { action: "write", schema_version: "9.9" },
});

expect(payload.action).toBe("read");
expect(payload.schema_version).toBe("1.0");
expect(payload.extension_data).toEqual({ action: "write", schema_version: "9.9" });
```

Update existing custom-field fixtures to use `extension_data`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm run test:unit -- test/internal/unit/a365/executeToolJsonModels.test.ts`

Expected: FAIL because `extension_data` is not the established extensibility contract and current constructors copy arbitrary keys.

- [ ] **Step 3: Implement the explicit model contract**

Replace open index signatures with:

```ts
export interface ToolCallExtensionData {
  extension_data?: Record<string, unknown>;
}
```

Extend each nested interface from `ToolCallExtensionData`. Make both top-level classes implement it and explicitly assign only `schema_version`, declared fields, and `extension_data` in their constructors.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:unit -- test/internal/unit/a365/executeToolJsonModels.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src\a365\tool-call-models.ts test\internal\unit\a365\executeToolJsonModels.test.ts
git commit -m "fix(a365): isolate execute tool extension data"
```

### Task 2: Strict typed-payload serializer

**Files:**
- Modify: `src/a365/message-utils.ts`
- Modify: `test/internal/unit/a365/messageUtils.test.ts`

**Interfaces:**
- Consumes: `extension_data?: Record<string, unknown>` from Task 1.
- Produces: `serializeToolPayload(value: object | null | undefined): string | undefined`.
- Produces internal schema converters for arguments, results, resources, outcomes, pagination, policies, and generic mapping values.

- [ ] **Step 1: Write failing collision and wire-shape tests**

Add assertions equivalent to:

```ts
const payload = new ExecuteToolCallArguments({
  action: ToolCallAction.READ,
  extension_data: { action: "write", schema_version: "9.9" },
});

expect(JSON.parse(serializeToolPayload(payload)!)).toEqual({
  schema_version: "1.0",
  action: "read",
  metadata: { action: "write", schema_version: "9.9" },
});
```

Add a nested outcome collision test where declared `code: "ok"` and `extension_data.code: "provider-code"` remain separate.

- [ ] **Step 2: Write failing validation and null-semantics tests**

Cover:

```ts
expect(serializeToolPayload(new ExecuteToolCallArguments({ action: "READ" as any })))
  .toBe(EXPECTED_ERROR_JSON);
expect(serializeToolPayload(new ExecuteToolCallResult({ data: { score: Number.NaN } })))
  .toBe(EXPECTED_ERROR_JSON);
expect(JSON.parse(serializeToolPayload(new ExecuteToolCallResult({
  outcome: { status: ToolCallOutcomeStatus.SUCCESS, provider_code: null as any,
    extension_data: { provider_outcome: null } },
  data: { content: null, matches: [null, 1] },
}))!)).toEqual({
  schema_version: "1.0",
  outcome: { status: "success", metadata: { provider_outcome: null } },
  data: { content: null, matches: [null, 1] },
});
```

Also cover `Infinity`, functions, `undefined` mapping values, `bigint`, cycles, repeated references, `Date`, `Uint8Array`, and `Set`.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm run test:unit -- test/internal/unit/a365/messageUtils.test.ts`

Expected: FAIL because native `JSON.stringify` flattens current model fields and silently coerces invalid values.

- [ ] **Step 4: Implement schema-aware conversion**

Add internal helpers with these responsibilities:

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function serializeTypedToolPayload(
  value: ExecuteToolCallArguments | ExecuteToolCallResult,
): string;

function toJsonValue(value: unknown, stack: Set<object>): JsonValue;
function toJsonRecord(value: Record<string, unknown>, stack: Set<object>): Record<string, JsonValue>;
function withMetadata(
  declared: Record<string, JsonValue | undefined>,
  extensionData: Record<string, unknown> | undefined,
  stack: Set<object>,
): Record<string, JsonValue>;
function validateEnum(value: unknown, allowed: ReadonlySet<string>, field: string): string;
```

Use explicit converters for every schema interface. Omit nullish declared fields, convert non-empty `extension_data` to `metadata`, preserve mapping nulls, reject unsupported/coerced values, and remove containers from the active stack in `finally` so repeated references remain valid.

- [ ] **Step 5: Run focused tests**

Run: `npm run test:unit -- test/internal/unit/a365/messageUtils.test.ts`

Expected: PASS.

- [ ] **Step 6: Run both ExecuteTool unit files**

Run: `npm run test:unit -- test/internal/unit/a365/executeToolJsonModels.test.ts test/internal/unit/a365/messageUtils.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src\a365\message-utils.ts test\internal\unit\a365\messageUtils.test.ts
git commit -m "fix(a365): validate typed execute tool payloads"
```

### Task 3: Documentation and repository validation

**Files:**
- Modify: `A365_DOCUMENTATION.md`
- Modify: `CHANGELOG.md` only if the existing entry describes flattened custom fields.

**Interfaces:**
- Documents: `extension_data` construction API and emitted `metadata` JSON.

- [ ] **Step 1: Update documentation examples**

Replace direct custom properties with:

```ts
extension_data: {
  provider_trace_id: "trace-789",
}
```

Show that the emitted JSON contains:

```json
"metadata": {
  "provider_trace_id": "trace-789"
}
```

State that metadata keys may match declared field names without replacing those declared fields.

- [ ] **Step 2: Run formatting**

Run: `npm run format`

Expected: exits 0.

- [ ] **Step 3: Run type checks, build, lint, and unit tests**

Run: `npm run typecheck:test && npm run build && npm run lint && npm run test:unit`

Expected: all commands exit 0; lint may report only repository-baseline warnings.

- [ ] **Step 4: Run remaining PR validation suites**

Run: `npm run test:functional && npm run test:esm-build`

Expected: all commands exit 0.

- [ ] **Step 5: Inspect and commit final changes**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intended files changed.

```powershell
git add A365_DOCUMENTATION.md CHANGELOG.md
git commit -m "docs(a365): document execute tool metadata"
```

- [ ] **Step 6: Push the PR branch**

Run: `git push origin feature/a365-execute-tool-schemas`

Expected: the remote PR head updates successfully and CI starts.
