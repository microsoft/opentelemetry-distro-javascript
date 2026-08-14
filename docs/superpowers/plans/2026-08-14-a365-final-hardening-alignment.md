# A365 Final Hardening Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align JavaScript durable delivery with the final merged hardening behavior of `microsoft/opentelemetry-distro-dotnet#137`.

**Architecture:** Preserve the exporter-integrated JavaScript durable-delivery architecture and nested `durableDelivery` API. Make storage an enabled-by-default optional capability that degrades to network-only delivery, separate token availability from transport health, resolve replay routing from current configuration, and harden lifecycle and storage-root behavior.

**Tech Stack:** TypeScript, Node.js 22 built-ins, OpenTelemetry JS 2.x, Vitest 4.

## Global Constraints

- Keep the nested `Agent365DurableDeliveryOptions` public API.
- Durable delivery defaults to enabled; explicit `enabled: false` remains supported.
- Add no runtime dependency.
- Storage initialization failure must not prevent successful network delivery.
- HTTP 401 is retryable.
- Token resolver failures must not update the transmission gate or block unrelated replay records.
- Shutdown must wait for accepted exports in durable and network-only modes.
- Persist no bearer tokens or telemetry-derived application identity.
- Existing version-1 durable files remain readable.

## File Structure

- Modify `src/a365/exporter/durable/DurableDeliveryOptions.ts`: enabled-by-default resolution.
- Modify `src/a365/exporter/durable/DurableDeliveryManager.ts`: token-unavailable outcome and replay continuation.
- Modify `src/a365/exporter/durable/TransmissionGate.ts`: exact positive `Retry-After` behavior.
- Modify `src/a365/exporter/durable/DurableRecord.ts`: routing-independent persisted record contract with backward-compatible parsing.
- Modify `src/a365/exporter/durable/PersistentStore.ts`: stable application partition and explicit fallback order.
- Modify `src/a365/exporter/Agent365Exporter.ts`: storage fallback, 401 classification, current replay routing, and shutdown drain.
- Modify focused tests under `test/internal/unit/a365/`.
- Modify `README.md`, `A365_DOCUMENTATION.md`, and `CHANGELOG.md`.

---

### Task 1: Enabled-by-default storage with network fallback

**Files:**
- Modify: `src/a365/exporter/durable/DurableDeliveryOptions.ts:36`
- Modify: `src/a365/exporter/Agent365Exporter.ts:230-385`
- Modify: `src/a365/exporter/Agent365Exporter.ts:429-483`
- Test: `test/internal/unit/a365/durableDeliveryOptions.test.ts`
- Test: `test/internal/unit/a365/agent365Exporter.test.ts`

**Interfaces:**
- Produces: `ResolvedDurableDeliveryOptions.enabled === true` when omitted.
- Produces: `getDurableManager(): Promise<DurableDeliveryManager | undefined>`.
- Produces: network-only fallback through the existing non-durable send path.

- [ ] **Step 1: Change the option test to require enabled-by-default behavior**

```ts
it("is enabled by default and applies bounded defaults", () => {
  const options = new ResolvedDurableDeliveryOptions();
  assert.isTrue(options.enabled);
});

it("supports explicit disable", () => {
  assert.isFalse(new ResolvedDurableDeliveryOptions({ enabled: false }).enabled);
});
```

- [ ] **Step 2: Add exporter tests for storage initialization fallback**

Mock `PersistentStore.create` to reject. Assert a 200 response still produces
`ExportResultCode.SUCCESS`, and a retryable response produces `ExportResultCode.FAILED` because it
could not be persisted.

```ts
vi.spyOn(PersistentStore, "create").mockRejectedValue(new Error("disk unavailable"));
fetchMock.mockResolvedValue(new Response("", { status: 200 }));
await exporter.export([span], callback);
expect(callback).toHaveBeenCalledWith({ code: ExportResultCode.SUCCESS });
```

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/durableDeliveryOptions.test.ts test/internal/unit/a365/agent365Exporter.test.ts
```

Expected: FAIL because durability defaults to false and initialization failure aborts export.

- [ ] **Step 4: Implement enabled-by-default resolution**

```ts
this.enabled = options?.enabled ?? true;
```

- [ ] **Step 5: Implement fallback without recursive durable selection**

Extract the current non-durable group send body into:

```ts
private async exportNetworkGroup(
  tenantId: string,
  agentId: string,
  spans: ReadableSpan[],
  chunks: MappedSpan[][],
  resourceAttrs: Record<string, unknown>,
  start: number,
): Promise<void>
```

Make `getDurableManager()` return `undefined` after a logged initialization failure. In
`exportGroup`, call `exportDurableGroup` only when a manager exists; otherwise call
`exportNetworkGroup`.

- [ ] **Step 6: Run the focused tests and verify pass**

Run the command from Step 3. Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/a365/exporter/durable/DurableDeliveryOptions.ts src/a365/exporter/Agent365Exporter.ts test/internal/unit/a365/durableDeliveryOptions.test.ts test/internal/unit/a365/agent365Exporter.test.ts
git commit -m "fix(a365): degrade unavailable durable storage"
```

---

### Task 2: Align retry classification and Retry-After

**Files:**
- Modify: `src/a365/exporter/Agent365Exporter.ts:500-545`
- Modify: `src/a365/exporter/durable/TransmissionGate.ts:48-58`
- Test: `test/internal/unit/a365/agent365Exporter.test.ts`
- Test: `test/internal/unit/a365/durableDeliveryManager.test.ts`
- Test: `test/internal/unit/a365/transmissionGate.test.ts`

**Interfaces:**
- Consumes: existing `DeliveryAttempt`.
- Produces: 401 as `{ kind: "retryable" }`.
- Produces: positive `retryAfterMs` used directly, capped at `3_600_000`.

- [ ] **Step 1: Add 401 persistence tests**

Add 401 to the retryable matrix:

```ts
it.each([401, 408, 429, 500, 503])(
  "persists retryable live attempts for status %s",
  async (status) => {
    const { manager, persist, send } = createManager();
    send.mockResolvedValue({
      kind: "retryable",
      correlationId: `retryable-${status}`,
      status,
      retryAfterMs: 60_000,
    });

    assert.isTrue(await manager.deliver(makeRecord()));
    assert.strictEqual(send.mock.calls.length, 1);
    assert.strictEqual(persist.mock.calls.length, 1);
  },
);
```

Add an exporter-level fetch test asserting a 401 is persisted rather than treated as permanent.

- [ ] **Step 2: Add a short Retry-After test**

```ts
it("honors a positive Retry-After shorter than the fallback", () => {
  let now = 0;
  const gate = new TransmissionGate({ now: () => now, random: () => 0 });
  const permit = gate.acquire()!;
  gate.recordRetryableFailure(permit, 1_000);
  now = 999;
  assert.isUndefined(gate.acquire());
  now = 1_000;
  assert.isDefined(gate.acquire());
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/agent365Exporter.test.ts test/internal/unit/a365/durableDeliveryManager.test.ts test/internal/unit/a365/transmissionGate.test.ts
```

Expected: FAIL for 401 classification and the one-second Retry-After.

- [ ] **Step 4: Implement classification and gate delay**

```ts
if (
  [401, 408, 429].includes(response.status) ||
  (response.status >= 500 && response.status < 600)
) {
  return {
    kind: "retryable",
    correlationId,
    status: response.status,
    retryAfterMs: parseRetryAfterMs(response.headers) ?? undefined,
  };
}
```

```ts
const delayMs =
  retryAfterMs !== undefined && retryAfterMs > 0
    ? Math.min(MAX_FALLBACK_DELAY_MS, retryAfterMs)
    : this.computeFallbackDelay();
```

- [ ] **Step 5: Run tests and verify pass**

Run the command from Step 3. Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/a365/exporter/Agent365Exporter.ts src/a365/exporter/durable/TransmissionGate.ts test/internal/unit/a365/agent365Exporter.test.ts test/internal/unit/a365/durableDeliveryManager.test.ts test/internal/unit/a365/transmissionGate.test.ts
git commit -m "fix(a365): align retryable delivery outcomes"
```

---

### Task 3: Isolate token-unavailable replay outcomes

**Files:**
- Modify: `src/a365/exporter/durable/DurableDeliveryManager.ts:20-310`
- Test: `test/internal/unit/a365/durableDeliveryManager.test.ts`

**Interfaces:**
- Produces: `GateDecision` variant `{ kind: "tokenUnavailable"; error?: unknown }`.
- Produces: replay continuation after token-unavailable records.
- Preserves: live token-unavailable records are persisted when possible.

- [ ] **Step 1: Add replay starvation and gate-isolation tests**

Create two claimed records. Make the first resolver return null and the second return a token.
Assert both claims are attempted, the first is released, and the second is completed.

Add resolver throw and timeout variants. After each token failure, deliver a live record and assert
`send` is called immediately, proving the transmission gate was not backed off.

- [ ] **Step 2: Run the manager tests and verify failure**

Run:

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/durableDeliveryManager.test.ts
```

Expected: FAIL because replay stops after the first released claim and exceptions back off the
gate.

- [ ] **Step 3: Add the token-unavailable decision**

```ts
type GateDecision =
  | { kind: "deferred" }
  | { kind: "tokenUnavailable"; error?: unknown }
  | { kind: "success" }
  | { kind: "permanent" }
  | { kind: "retryable"; error?: unknown };
```

Resolve tokens before acquiring a transmission permit. Convert null, resolver rejection, and
resolver timeout to `tokenUnavailable`. Acquire and update the gate only around `send`.

- [ ] **Step 4: Continue replay after token unavailability**

```ts
if (decision.kind === "tokenUnavailable") {
  await this.releaseClaim(claim);
  return true;
}
```

Keep `return false` for transport retry/deferred outcomes so a server backoff stops the pass.

- [ ] **Step 5: Preserve live durability**

In `deliverInternal`, allow `tokenUnavailable` to flow to `persist(record)`. Log resolver errors
without recording a transport failure.

- [ ] **Step 6: Run tests and verify pass**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/a365/exporter/durable/DurableDeliveryManager.ts test/internal/unit/a365/durableDeliveryManager.test.ts
git commit -m "fix(a365): isolate replay token failures"
```

---

### Task 4: Resolve replay routing from current configuration

**Files:**
- Modify: `src/a365/exporter/durable/DurableRecord.ts:20-90`
- Modify: `src/a365/exporter/Agent365Exporter.ts:350-370`
- Modify: `src/a365/exporter/Agent365Exporter.ts:480-510`
- Modify: `src/a365/exporter/Agent365Exporter.ts:840-880`
- Test: `test/internal/unit/a365/durableRecord.test.ts`
- Test: `test/internal/unit/a365/agent365Exporter.test.ts`

**Interfaces:**
- Produces: `DurableRecordV1` without required `clusterCategory` or `domainOverride`.
- Preserves: parser acceptance of legacy version-1 fields.
- Produces: `buildAgent365Url(record, currentRouting)` or equivalent current-option merge.

- [ ] **Step 1: Add backward-compatibility and current-routing tests**

Assert `createDurableRecord` omits `clusterCategory` and `domainOverride`. Parse a legacy JSON
record containing both fields and assert parsing succeeds. Replay that record with a changed
exporter `domainOverride` and assert fetch uses the current override.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/durableRecord.test.ts test/internal/unit/a365/agent365Exporter.test.ts
```

Expected: FAIL because routing is required and replay uses persisted values.

- [ ] **Step 3: Make routing fields parser-only compatibility fields**

Remove the fields from newly created records. During parse, validate the optional legacy values
when present but do not return them as authoritative routing.

- [ ] **Step 4: Use current exporter routing for replay**

Build replay URLs with:

```ts
buildAgent365Url({
  tenantId: record.tenantId,
  agentId: record.agentId,
  clusterCategory: this.options.clusterCategory,
  domainOverride: this.options.domainOverride,
  useS2SEndpoint: record.useS2SEndpoint,
});
```

- [ ] **Step 5: Run focused tests and verify pass**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/a365/exporter/durable/DurableRecord.ts src/a365/exporter/Agent365Exporter.ts test/internal/unit/a365/durableRecord.test.ts test/internal/unit/a365/agent365Exporter.test.ts
git commit -m "fix(a365): use current routing for replay"
```

---

### Task 5: Partition storage and fix fallback order

**Files:**
- Modify: `src/a365/exporter/durable/PersistentStore.ts:1-30`
- Modify: `src/a365/exporter/durable/PersistentStore.ts:366-470`
- Test: `test/internal/unit/a365/persistentStore.test.ts`

**Interfaces:**
- Produces: stable `applicationPartition(): string`.
- Produces: every root ending in the application partition.
- Produces: POSIX candidates exactly `TMPDIR`, `/var/tmp`, `/tmp`, de-duplicated.

- [ ] **Step 1: Add stable partition tests**

Create two stores with the same explicit root and assert persisted paths share the same partition.
Mock a different `process.execPath` or working-directory input through an injectable identity
helper and assert a different partition.

- [ ] **Step 2: Add POSIX fallback-order test**

Mock root initialization failures and assert attempts occur in this order:

```ts
[process.env.TMPDIR, "/var/tmp", "/tmp"]
```

Ensure duplicate `TMPDIR="/tmp"` is attempted only once.

- [ ] **Step 3: Run the store tests and verify failure**

Run:

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/persistentStore.test.ts
```

Expected: FAIL because explicit roots are unpartitioned and `os.tmpdir()` may repeat `TMPDIR`.

- [ ] **Step 4: Implement a stable non-sensitive partition**

Use SHA-256 over stable application attributes:

```ts
const identity = [
  process.getuid?.() ?? "unknown",
  process.execPath,
  process.cwd(),
].join("\0");
const partition = createHash("sha256").update(identity).digest("hex").slice(0, 16);
```

Append `app-${partition}` to both explicit and default base roots before verification.

- [ ] **Step 5: Implement explicit candidate de-duplication**

```ts
const candidates = [...new Set([process.env.TMPDIR, "/var/tmp", "/tmp"].filter(isString))];
```

Keep the existing Windows order and de-duplicate it as well.

- [ ] **Step 6: Run store tests and verify pass**

Run the command from Step 3. Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/a365/exporter/durable/PersistentStore.ts test/internal/unit/a365/persistentStore.test.ts
git commit -m "fix(a365): partition durable storage roots"
```

---

### Task 6: Drain network-only exports during shutdown

**Files:**
- Modify: `src/a365/exporter/Agent365Exporter.ts:735-830`
- Test: `test/internal/unit/a365/agent365Exporter.test.ts`

**Interfaces:**
- Produces: one bounded shutdown deadline in all modes.
- Preserves: durable manager shutdown and late-initialization cleanup.

- [ ] **Step 1: Replace the existing non-durable immediate-shutdown test**

Assert shutdown remains pending while an accepted network-only fetch is pending, then resolves
after fetch settles. Add a fake-timer test asserting rejection after
`shutdownTimeoutMilliseconds`.

- [ ] **Step 2: Run the exporter tests and verify failure**

Run:

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/agent365Exporter.test.ts
```

Expected: FAIL because non-durable shutdown returns immediately.

- [ ] **Step 3: Apply the deadline before the durable-mode branch**

```ts
const deadline = Date.now() + this.options.durableDelivery.shutdownTimeoutMilliseconds;
await this.waitForActiveExports(deadline);
if (!this.options.durableDelivery.enabled) {
  this.shutdownFinalized = true;
  return;
}
```

Ensure the `finally` block still finalizes late durable managers.

- [ ] **Step 4: Run exporter tests and verify pass**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/a365/exporter/Agent365Exporter.ts test/internal/unit/a365/agent365Exporter.test.ts
git commit -m "fix(a365): drain network exports on shutdown"
```

---

### Task 7: Documentation and complete validation

**Files:**
- Modify: `README.md`
- Modify: `A365_DOCUMENTATION.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Documents: enabled-by-default behavior, explicit disable, network-only degradation, plaintext
  storage, application partitioning, and current-routing replay.

- [ ] **Step 1: Update documentation**

State that durable storage is enabled by default, can be disabled with
`durableDelivery.enabled: false`, and falls back to network-only delivery when storage cannot
initialize. Retain the protected-volume and plaintext-data warnings.

- [ ] **Step 2: Run focused durable tests**

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/durableDeliveryOptions.test.ts test/internal/unit/a365/durableRecord.test.ts test/internal/unit/a365/persistentStore.test.ts test/internal/unit/a365/transmissionGate.test.ts test/internal/unit/a365/durableDeliveryManager.test.ts test/internal/unit/a365/agent365Exporter.test.ts test/internal/unit/a365/a365Configuration.test.ts test/internal/unit/main.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run build and static checks**

```powershell
npm run build
npm run lint
npm run format
```

Expected: all commands exit 0.

- [ ] **Step 4: Run complete tests**

```powershell
npm run test:unit
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit documentation**

```powershell
git add README.md A365_DOCUMENTATION.md CHANGELOG.md
git commit -m "docs(a365): document durable hardening parity"
```

- [ ] **Step 6: Review the final branch diff**

```powershell
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, clean worktree, and only durable-delivery commits.

- [ ] **Step 7: Push and create the pull request**

```powershell
git push -u origin feature/a365-durable-delivery
$bodyPath = Join-Path $env:TEMP "a365-durable-delivery-pr.md"
@'
## Summary
- add enabled-by-default durable store-and-forward delivery for Agent365 telemetry
- align retry, replay, shutdown, storage, and Retry-After behavior with microsoft/opentelemetry-distro-dotnet#137
- retain the idiomatic nested JavaScript durableDelivery API

## Validation
- npm run build
- npm run lint
- npm run format
- npm run test:unit
- npm test
'@ | Set-Content -Path $bodyPath
gh pr create --repo microsoft/opentelemetry-distro-javascript --base main --head feature/a365-durable-delivery --title "Add durable delivery resilience to Agent365 exporter" --body-file $bodyPath
```

The PR body must link `.NET PR #137`, describe behavioral parity and JavaScript-specific API
choices, list validation commands, and note that replay is at-least-once.
