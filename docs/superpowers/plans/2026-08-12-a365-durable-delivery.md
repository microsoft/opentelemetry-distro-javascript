# A365 Durable Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, Node-native durable store-and-forward delivery to the A365 span exporter.

**Architecture:** Keep the standard OpenTelemetry `BatchSpanProcessor`. Add focused durable-delivery modules for option resolution, versioned records, atomic bounded storage, shared live/replay backoff, and lifecycle coordination; integrate them behind `Agent365Exporter` so an export succeeds only after network delivery or durable persistence.

**Tech Stack:** TypeScript, Node.js 22 built-ins (`node:fs/promises`, `node:path`, `node:os`, `node:crypto`), OpenTelemetry JS 2.x, Vitest 4.

## Global Constraints

- Durable delivery is opt-in through `durableDelivery.enabled`; the default is `false`.
- Use no new runtime dependency.
- Default storage capacity is 50 MiB and default record retention is two days.
- Default replay interval and lease duration are two minutes; process at most ten records per pass.
- Fallback backoff is jittered exponential, bounded from ten seconds to one hour.
- Durable files contain no bearer token and use owner-only permissions (`0700` directories, `0600` files).
- Use atomic file creation/rename and atomic replay claims so multiple Node.js processes do not replay one record concurrently.
- Keep current in-memory retry behavior unchanged when durability is disabled.
- `npm ci` is used in CI; if `package.json` changes, update `package-lock.json` in the same task.

## File Structure

- Create `src/a365/exporter/durable/DurableDeliveryOptions.ts`: public and resolved durable option types.
- Create `src/a365/exporter/durable/DurableRecord.ts`: versioned persisted record contract and parser.
- Create `src/a365/exporter/durable/PersistentStore.ts`: secure atomic storage, pruning, claims, leases, and quarantine.
- Create `src/a365/exporter/durable/TransmissionGate.ts`: shared backoff and generation-bearing permits.
- Create `src/a365/exporter/durable/DurableDeliveryManager.ts`: live durable handoff, replay, classification, and shutdown.
- Create `src/a365/exporter/durable/index.ts`: durable module exports.
- Modify `src/a365/exporter/Agent365Exporter.ts`: integrate durable delivery while preserving the non-durable path.
- Modify `src/a365/exporter/Agent365ExporterOptions.ts`: expose and resolve durable options.
- Modify `src/a365/configuration/A365ConfigurationOptions.ts`: expose distro-level durable options.
- Modify `src/a365/configuration/A365Configuration.ts`: carry resolved durable options.
- Modify `src/distro/distro.ts`: wire durable options into public exporter construction.
- Modify `src/a365/exporter/index.ts`, `src/a365/index.ts`, and `src/index.ts`: export public durable option types.
- Create `test/internal/unit/a365/durableDeliveryOptions.test.ts`.
- Create `test/internal/unit/a365/durableRecord.test.ts`.
- Create `test/internal/unit/a365/persistentStore.test.ts`.
- Create `test/internal/unit/a365/transmissionGate.test.ts`.
- Create `test/internal/unit/a365/durableDeliveryManager.test.ts`.
- Modify `test/internal/unit/a365/agent365Exporter.test.ts`, `a365Configuration.test.ts`, and `main.test.ts`.
- Modify `README.md`, `A365_DOCUMENTATION.md`, and `CHANGELOG.md`.

---

### Task 1: Public durable-delivery options and distro wiring

**Files:**
- Create: `src/a365/exporter/durable/DurableDeliveryOptions.ts`
- Create: `src/a365/exporter/durable/index.ts`
- Modify: `src/a365/exporter/Agent365ExporterOptions.ts`
- Modify: `src/a365/configuration/A365ConfigurationOptions.ts`
- Modify: `src/a365/configuration/A365Configuration.ts`
- Modify: `src/distro/distro.ts`
- Modify: `src/a365/exporter/index.ts`
- Modify: `src/a365/index.ts`
- Modify: `src/index.ts`
- Test: `test/internal/unit/a365/durableDeliveryOptions.test.ts`
- Test: `test/internal/unit/a365/a365Configuration.test.ts`
- Test: `test/internal/unit/main.test.ts`

**Interfaces:**
- Produces: `Agent365DurableDeliveryOptions`
- Produces: `ResolvedDurableDeliveryOptions`
- Produces: `ResolvedExporterOptions.durableDelivery`

- [ ] **Step 1: Write failing option-resolution tests**

```ts
import { assert, describe, it } from "vitest";
import {
  ResolvedDurableDeliveryOptions,
  DEFAULT_DURABLE_STORAGE_BYTES,
} from "../../../../src/a365/exporter/durable/index.js";

describe("ResolvedDurableDeliveryOptions", () => {
  it("is disabled by default and applies bounded defaults", () => {
    const options = new ResolvedDurableDeliveryOptions();
    assert.isFalse(options.enabled);
    assert.strictEqual(options.maxStorageBytes, DEFAULT_DURABLE_STORAGE_BYTES);
    assert.strictEqual(options.maxRecordAgeMilliseconds, 2 * 24 * 60 * 60 * 1000);
    assert.strictEqual(options.replayIntervalMilliseconds, 2 * 60 * 1000);
    assert.strictEqual(options.maxReplayBatchSize, 10);
    assert.strictEqual(options.leaseDurationMilliseconds, 2 * 60 * 1000);
    assert.strictEqual(options.shutdownTimeoutMilliseconds, 10_000);
    assert.strictEqual(options.tokenResolutionTimeoutMilliseconds, 30_000);
  });

  it("rejects non-positive limits", () => {
    assert.throws(
      () => new ResolvedDurableDeliveryOptions({ enabled: true, maxStorageBytes: 0 }),
      /maxStorageBytes must be greater than 0/,
    );
  });
});
```

Add configuration and distro assertions:

```ts
const durableDelivery = {
  enabled: true,
  storageDirectory: "C:\\a365-spool",
  maxStorageBytes: 1024,
};
const config = new A365Configuration({ durableDelivery });
assert.deepEqual(config.durableDelivery, durableDelivery);
```

```ts
assert.deepEqual(
  batchProcessor["_exporter"]["options"].durableDelivery.storageDirectory,
  "C:\\a365-spool",
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/durableDeliveryOptions.test.ts test/internal/unit/a365/a365Configuration.test.ts test/internal/unit/main.test.ts
```

Expected: FAIL because durable option types and wiring do not exist.

- [ ] **Step 3: Implement public and resolved options**

Create `DurableDeliveryOptions.ts`:

```ts
export const DEFAULT_DURABLE_STORAGE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_DURABLE_RECORD_AGE_MS = 2 * 24 * 60 * 60 * 1000;
export const DEFAULT_DURABLE_REPLAY_INTERVAL_MS = 2 * 60 * 1000;
export const DEFAULT_DURABLE_REPLAY_BATCH_SIZE = 10;
export const DEFAULT_DURABLE_LEASE_MS = 2 * 60 * 1000;
export const DEFAULT_DURABLE_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_DURABLE_TOKEN_TIMEOUT_MS = 30_000;

export interface Agent365DurableDeliveryOptions {
  enabled?: boolean;
  storageDirectory?: string;
  maxStorageBytes?: number;
  maxRecordAgeMilliseconds?: number;
  replayIntervalMilliseconds?: number;
  maxReplayBatchSize?: number;
  leaseDurationMilliseconds?: number;
  shutdownTimeoutMilliseconds?: number;
  tokenResolutionTimeoutMilliseconds?: number;
}

export class ResolvedDurableDeliveryOptions {
  readonly enabled: boolean;
  readonly storageDirectory?: string;
  readonly maxStorageBytes: number;
  readonly maxRecordAgeMilliseconds: number;
  readonly replayIntervalMilliseconds: number;
  readonly maxReplayBatchSize: number;
  readonly leaseDurationMilliseconds: number;
  readonly shutdownTimeoutMilliseconds: number;
  readonly tokenResolutionTimeoutMilliseconds: number;

  constructor(options?: Agent365DurableDeliveryOptions) {
    this.enabled = options?.enabled ?? false;
    this.storageDirectory = options?.storageDirectory;
    this.maxStorageBytes = positive(
      "maxStorageBytes",
      options?.maxStorageBytes ?? DEFAULT_DURABLE_STORAGE_BYTES,
    );
    this.maxRecordAgeMilliseconds = positive(
      "maxRecordAgeMilliseconds",
      options?.maxRecordAgeMilliseconds ?? DEFAULT_DURABLE_RECORD_AGE_MS,
    );
    this.replayIntervalMilliseconds = positive(
      "replayIntervalMilliseconds",
      options?.replayIntervalMilliseconds ?? DEFAULT_DURABLE_REPLAY_INTERVAL_MS,
    );
    this.maxReplayBatchSize = positiveInteger(
      "maxReplayBatchSize",
      options?.maxReplayBatchSize ?? DEFAULT_DURABLE_REPLAY_BATCH_SIZE,
    );
    this.leaseDurationMilliseconds = positive(
      "leaseDurationMilliseconds",
      options?.leaseDurationMilliseconds ?? DEFAULT_DURABLE_LEASE_MS,
    );
    this.shutdownTimeoutMilliseconds = positive(
      "shutdownTimeoutMilliseconds",
      options?.shutdownTimeoutMilliseconds ?? DEFAULT_DURABLE_SHUTDOWN_TIMEOUT_MS,
    );
    this.tokenResolutionTimeoutMilliseconds = positive(
      "tokenResolutionTimeoutMilliseconds",
      options?.tokenResolutionTimeoutMilliseconds ?? DEFAULT_DURABLE_TOKEN_TIMEOUT_MS,
    );
  }
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be greater than 0`);
  }
  return value;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
```

Add `durableDelivery?: Agent365DurableDeliveryOptions` to both public option interfaces, resolve
it in `ResolvedExporterOptions`, retain the caller object in `A365Configuration`, and pass it in
`distro.ts`:

```ts
durableDelivery: a365Config.durableDelivery,
```

Export only `Agent365DurableDeliveryOptions`; keep resolved classes internal to the A365 module
except where existing tests directly import resolved option classes.

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src\a365 test\internal\unit\a365 src\distro\distro.ts src\index.ts
git commit -m "feat(a365): add durable delivery options" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 42d7c423-38b3-4951-b6f3-124cedca83f2"
```

### Task 2: Versioned records and secure persistent store

**Files:**
- Create: `src/a365/exporter/durable/DurableRecord.ts`
- Create: `src/a365/exporter/durable/PersistentStore.ts`
- Modify: `src/a365/exporter/durable/index.ts`
- Test: `test/internal/unit/a365/durableRecord.test.ts`
- Test: `test/internal/unit/a365/persistentStore.test.ts`

**Interfaces:**
- Produces: `DurableRecordV1`
- Produces: `createDurableRecord(input): DurableRecordV1`
- Produces: `parseDurableRecord(text): DurableRecordV1`
- Produces: `PersistentStore.initialize()`, `persist()`, `claimBatch()`, `complete()`, `release()`

- [ ] **Step 1: Write failing record and storage tests**

```ts
it("round-trips a v1 record without credentials", () => {
  const record = createDurableRecord({
    tenantId: "tenant",
    agentId: "agent",
    agenticUserId: "user",
    clusterCategory: "prod",
    useS2SEndpoint: false,
    body: "{\"resourceSpans\":[]}",
  });
  const parsed = parseDurableRecord(JSON.stringify(record));
  assert.deepEqual(parsed, record);
  assert.notInclude(JSON.stringify(record), "Bearer");
});

it("rejects unsupported versions", () => {
  assert.throws(() => parseDurableRecord('{"version":2}'), /Unsupported durable record version/);
});
```

```ts
it("writes atomically with owner-only permissions", async () => {
  const store = await createStore(tempDir);
  const path = await store.persist(makeRecord());
  const stats = await stat(path);
  if (process.platform !== "win32") {
    assert.strictEqual(stats.mode & 0o777, 0o600);
    assert.strictEqual((await stat(tempDir)).mode & 0o777, 0o700);
  }
});

it("allows only one concurrent claimant", async () => {
  await store.persist(makeRecord());
  const [first, second] = await Promise.all([store.claimBatch(1), store.claimBatch(1)]);
  assert.strictEqual(first.length + second.length, 1);
});

it("prunes expired and then oldest records before accepting a new record", async () => {
  await seedRecord(store, { createdAt: 1, body: "old" });
  await seedRecord(store, { createdAt: 2, body: "newer" });
  await store.persist(makeRecord({ body: "replacement" }));
  assert.notInclude(await storedBodies(store), "old");
});
```

Also test symlink-root rejection, explicit unwritable-root failure, default-root fallback, oversize
record rejection, stale lease recovery, release, completion deletion, and malformed quarantine.

- [ ] **Step 2: Run tests to verify they fail**

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/durableRecord.test.ts test/internal/unit/a365/persistentStore.test.ts
```

Expected: FAIL because record and store modules do not exist.

- [ ] **Step 3: Implement the record contract**

```ts
export const DURABLE_RECORD_VERSION = 1 as const;

export interface DurableRecordV1 {
  version: typeof DURABLE_RECORD_VERSION;
  id: string;
  createdAt: number;
  tenantId: string;
  agentId: string;
  agenticUserId?: string;
  clusterCategory: ClusterCategory;
  domainOverride?: string;
  useS2SEndpoint: boolean;
  body: string;
}

export function createDurableRecord(
  input: Omit<DurableRecordV1, "version" | "id" | "createdAt">,
): DurableRecordV1 {
  return {
    version: DURABLE_RECORD_VERSION,
    id: randomUUID(),
    createdAt: Date.now(),
    ...input,
  };
}

export function parseDurableRecord(text: string): DurableRecordV1 {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== DURABLE_RECORD_VERSION) {
    throw new Error("Unsupported durable record version");
  }
  if (
    typeof value.id !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.tenantId !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.body !== "string" ||
    typeof value.useS2SEndpoint !== "boolean"
  ) {
    throw new Error("Invalid durable record");
  }
  return value as unknown as DurableRecordV1;
}
```

- [ ] **Step 4: Implement secure atomic storage**

Use these exact public shapes:

```ts
export interface ClaimedRecord {
  record: DurableRecordV1;
  leasePath: string;
}

export class PersistentStore {
  static async create(
    options: ResolvedDurableDeliveryOptions,
    logger: ILogger,
  ): Promise<PersistentStore>;

  async persist(record: DurableRecordV1): Promise<string>;
  async claimBatch(limit: number): Promise<ClaimedRecord[]>;
  async complete(claim: ClaimedRecord): Promise<void>;
  async release(claim: ClaimedRecord): Promise<void>;
}
```

Initialization must:

```ts
const stats = await lstat(root);
if (stats.isSymbolicLink() || !stats.isDirectory()) {
  throw new Error(`Durable storage root must be a real directory: ${root}`);
}
if (process.platform !== "win32") {
  await chmod(root, 0o700);
}
```

Atomic persistence must:

```ts
const temporaryPath = join(root, `.${record.id}.${process.pid}.tmp`);
const pendingPath = join(root, `${record.createdAt}-${record.id}.pending`);
const handle = await open(temporaryPath, "wx", 0o600);
try {
  await handle.writeFile(JSON.stringify(record), "utf8");
  await handle.sync();
} finally {
  await handle.close();
}
await rename(temporaryPath, pendingPath);
```

Claims use `rename(pendingPath, leasePath)` and ignore only `ENOENT`; other errors propagate.
Malformed records move to `<name>.quarantine`. Stale `*.lease-*` files whose `mtimeMs` is older
than the lease duration are renamed back to a unique `.pending` name before claims are selected.

Default roots are probed in this order:

```ts
process.platform === "win32"
  ? [process.env.LOCALAPPDATA, process.env.TEMP, tmpdir()]
  : [process.env.TMPDIR, "/var/tmp", tmpdir()]
```

For each candidate, create `<candidate>/Microsoft/A365/otel-durable`, harden it, write and delete a
probe file, and continue to the next candidate after any failure. If an explicit directory fails,
throw without fallback.

- [ ] **Step 5: Run tests to verify they pass**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src\a365\exporter\durable test\internal\unit\a365\durableRecord.test.ts test\internal\unit\a365\persistentStore.test.ts
git commit -m "feat(a365): add secure durable storage" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 42d7c423-38b3-4951-b6f3-124cedca83f2"
```

### Task 3: Shared transmission gate

**Files:**
- Create: `src/a365/exporter/durable/TransmissionGate.ts`
- Modify: `src/a365/exporter/durable/index.ts`
- Test: `test/internal/unit/a365/transmissionGate.test.ts`

**Interfaces:**
- Produces: `TransmissionPermit`
- Produces: `TransmissionGate.acquire(now?)`
- Produces: `recordSuccess(permit)` and `recordRetryableFailure(permit, retryAfterMs?)`

- [ ] **Step 1: Write failing gate tests**

```ts
it("allows one half-open probe", () => {
  const gate = new TransmissionGate({ random: () => 0, now: () => now });
  const first = gate.acquire();
  assert.isDefined(first);
  gate.recordRetryableFailure(first!, 10_000);
  assert.isUndefined(gate.acquire());
  now += 10_000;
  assert.isDefined(gate.acquire());
  assert.isUndefined(gate.acquire());
});

it("does not let a stale success erase newer backoff", () => {
  const oldPermit = gate.acquire()!;
  const concurrentPermit = gate.acquire()!;
  gate.recordRetryableFailure(concurrentPermit, 60_000);
  gate.recordSuccess(oldPermit);
  assert.isUndefined(gate.acquire());
});
```

Test delay-seconds parsing, HTTP-date parsing, 10-second minimum, one-hour maximum, increasing
fallback delay, and reset after a current-generation success.

- [ ] **Step 2: Run tests to verify they fail**

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/transmissionGate.test.ts
```

Expected: FAIL because `TransmissionGate` does not exist.

- [ ] **Step 3: Implement generation-bearing gate permits**

```ts
export interface TransmissionPermit {
  readonly generation: number;
  readonly probe: boolean;
}

export class TransmissionGate {
  private generation = 0;
  private blockedUntil = 0;
  private probeInFlight = false;
  private consecutiveFailures = 0;

  acquire(): TransmissionPermit | undefined {
    const now = this.now();
    if (now < this.blockedUntil) return undefined;
    if (this.blockedUntil > 0) {
      if (this.probeInFlight) return undefined;
      this.probeInFlight = true;
      return { generation: this.generation, probe: true };
    }
    return { generation: this.generation, probe: false };
  }

  recordSuccess(permit: TransmissionPermit): void {
    if (permit.generation !== this.generation) return;
    this.blockedUntil = 0;
    this.probeInFlight = false;
    this.consecutiveFailures = 0;
  }

  recordRetryableFailure(permit: TransmissionPermit, retryAfterMs?: number): void {
    if (permit.generation !== this.generation) return;
    this.generation++;
    this.probeInFlight = false;
    this.consecutiveFailures++;
    const fallback = Math.min(
      60 * 60 * 1000,
      10_000 * 2 ** Math.min(this.consecutiveFailures - 1, 8),
    );
    const jittered = Math.floor(fallback * (0.8 + this.random() * 0.4));
    this.blockedUntil = this.now() + Math.max(retryAfterMs ?? 0, jittered);
  }
}
```

Make `now` and `random` injectable through an internal constructor option for deterministic tests.
Export the existing `parseRetryAfterMs` logic from this module and remove the duplicate after
exporter integration.

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src\a365\exporter\durable\TransmissionGate.ts src\a365\exporter\durable\index.ts test\internal\unit\a365\transmissionGate.test.ts
git commit -m "feat(a365): add shared transmission backoff" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 42d7c423-38b3-4951-b6f3-124cedca83f2"
```

### Task 4: Durable delivery and replay manager

**Files:**
- Create: `src/a365/exporter/durable/DurableDeliveryManager.ts`
- Modify: `src/a365/exporter/durable/index.ts`
- Test: `test/internal/unit/a365/durableDeliveryManager.test.ts`

**Interfaces:**
- Consumes: `PersistentStore`, `TransmissionGate`, `DurableRecordV1`
- Produces: `DeliveryAttempt`
- Produces: `DurableDeliveryManager.deliver(record)`
- Produces: `forceFlush()` and `shutdown()`

- [ ] **Step 1: Write failing live-delivery tests**

```ts
it.each([408, 429, 500, 503])("persists retryable HTTP %s", async (status) => {
  send.mockResolvedValue({ kind: "retryable", status, correlationId: "c" });
  assert.isTrue(await manager.deliver(makeRecord()));
  assert.strictEqual(persist.mock.calls.length, 1);
});

it("persists token resolver exceptions but not missing tokens", async () => {
  resolveToken.mockRejectedValueOnce(new Error("sts unavailable"));
  assert.isTrue(await manager.deliver(makeRecord()));
  resolveToken.mockResolvedValueOnce(null);
  assert.isFalse(await manager.deliver(makeRecord()));
  assert.strictEqual(persist.mock.calls.length, 1);
});

it("continues independent records after one persistence failure", async () => {
  persist.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce("second.pending");
  const results = await Promise.all([manager.deliver(first), manager.deliver(second)]);
  assert.deepEqual(results, [false, true]);
});
```

- [ ] **Step 2: Write failing replay and shutdown tests**

```ts
it("replays with a fresh token and deletes on success", async () => {
  claimBatch.mockResolvedValue([{ record, leasePath: "record.lease" }]);
  resolveToken.mockResolvedValue("fresh-token");
  send.mockResolvedValue({ kind: "success", correlationId: "c" });
  await manager.forceFlush();
  assert.strictEqual(resolveToken.mock.calls.length, 1);
  assert.strictEqual(complete.mock.calls.length, 1);
});

it("releases retryable records and deletes permanent records", async () => {
  send
    .mockResolvedValueOnce({ kind: "retryable", status: 503, correlationId: "a" })
    .mockResolvedValueOnce({ kind: "permanent", status: 400, correlationId: "b" });
  await manager.forceFlush();
  assert.strictEqual(release.mock.calls.length, 1);
  assert.strictEqual(complete.mock.calls.length, 1);
});

it("rejects shutdown when a token resolver exceeds the deadline", async () => {
  resolveToken.mockReturnValue(new Promise(() => undefined));
  await assert.rejects(manager.shutdown(), /shutdown timed out/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/durableDeliveryManager.test.ts
```

Expected: FAIL because the manager does not exist.

- [ ] **Step 4: Implement delivery classification and durable handoff**

Use these exact types:

```ts
export type DeliveryAttempt =
  | { kind: "success"; correlationId: string }
  | { kind: "retryable"; correlationId: string; status?: number; retryAfterMs?: number }
  | { kind: "permanent"; correlationId: string; status?: number; reason: string };

export interface DurableDeliveryDependencies {
  resolveToken(record: DurableRecordV1): Promise<string | null>;
  send(
    record: DurableRecordV1,
    token: string,
    signal: AbortSignal,
  ): Promise<DeliveryAttempt>;
}
```

`deliver()` must follow:

```ts
async deliver(record: DurableRecordV1): Promise<boolean> {
  if (this.closed) return false;
  const permit = this.gate.acquire();
  if (!permit) return this.persist(record);

  try {
    const token = await this.withTimeout(
      this.dependencies.resolveToken(record),
      this.options.tokenResolutionTimeoutMilliseconds,
      "token resolution",
    );
    if (!token) return false;
    const attempt = await this.dependencies.send(record, token, this.abortController.signal);
    if (attempt.kind === "success") {
      this.gate.recordSuccess(permit);
      return true;
    }
    if (attempt.kind === "permanent") return false;
    this.gate.recordRetryableFailure(permit, attempt.retryAfterMs);
    return this.persist(record);
  } catch (error) {
    this.gate.recordRetryableFailure(permit);
    return this.persist(record);
  }
}
```

`persist()` returns `true` only after the atomic store write succeeds and logs failures.

- [ ] **Step 5: Implement replay scheduling and bounded lifecycle**

Schedule with an unreferenced timer:

```ts
private scheduleReplay(): void {
  if (this.closed || this.replayTimer) return;
  this.replayTimer = setTimeout(() => {
    this.replayTimer = undefined;
    void this.runReplayPass().finally(() => this.scheduleReplay());
  }, this.options.replayIntervalMilliseconds);
  this.replayTimer.unref();
}
```

Replay each claim independently and use `complete()` for success/permanent failure, `release()` for
retryable failure, missing token, token timeout, or unknown errors.

Track active operations in `Set<Promise<unknown>>`. `shutdown()` sets `closed`, clears the timer,
aborts fetch, and races `Promise.allSettled(active)` against a timeout promise:

```ts
const completed = await Promise.race([
  Promise.allSettled([...this.active]).then(() => true),
  delay(this.options.shutdownTimeoutMilliseconds).then(() => false),
]);
if (!completed) {
  throw new Error("Agent365 durable delivery shutdown timed out");
}
```

`forceFlush()` waits for active live work and invokes one replay pass unless the manager is closed.

- [ ] **Step 6: Run tests to verify they pass**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src\a365\exporter\durable test\internal\unit\a365\durableDeliveryManager.test.ts
git commit -m "feat(a365): add durable replay manager" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 42d7c423-38b3-4951-b6f3-124cedca83f2"
```

### Task 5: Integrate durable delivery into Agent365Exporter

**Files:**
- Modify: `src/a365/exporter/Agent365Exporter.ts`
- Test: `test/internal/unit/a365/agent365Exporter.test.ts`
- Test: `test/internal/unit/main.test.ts`

**Interfaces:**
- Consumes: `DurableDeliveryManager`, `createDurableRecord`, `DeliveryAttempt`
- Preserves: `SpanExporter.export`, `forceFlush`, `shutdown`, and non-durable retries

- [ ] **Step 1: Write failing exporter integration tests**

```ts
it("returns success after a retryable failure is durably persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a365-exporter-"));
  fetchSpy.mockResolvedValue({
    status: 503,
    headers: new Headers({ "retry-after": "60" }),
  });
  const exporter = new Agent365Exporter({
    tokenResolver: () => "token",
    durableDelivery: { enabled: true, storageDirectory: directory },
  });
  const result = await exportResult(exporter, [makeSpan()]);
  assert.strictEqual(result, ExportResultCode.SUCCESS);
  assert.strictEqual((await readdir(directory)).filter((name) => name.endsWith(".pending")).length, 1);
});

it("returns failure when durable persistence fails", async () => {
  const exporter = new Agent365Exporter({
    tokenResolver: () => "token",
    durableDelivery: { enabled: true, storageDirectory: missingParentChild },
  });
  assert.strictEqual(await exportResult(exporter, [makeSpan()]), ExportResultCode.FAILED);
});

it("replays after exporter restart with a fresh token", async () => {
  await persistWithFailingExporter(directory);
  fetchSpy.mockResolvedValue(successResponse());
  const resolver = vi.fn().mockResolvedValue("fresh-token");
  const restarted = new Agent365Exporter({
    tokenResolver: resolver,
    durableDelivery: {
      enabled: true,
      storageDirectory: directory,
      replayIntervalMilliseconds: 1,
    },
  });
  await restarted.forceFlush();
  assert.strictEqual(resolver.mock.calls.length, 1);
  assert.isEmpty((await readdir(directory)).filter((name) => name.endsWith(".pending")));
});
```

Add a two-identity test where the first identity's storage write fails and the second identity is
still sent or persisted. Add shutdown tests for in-flight fetch abortion, timeout rejection, and
idempotent completed shutdown.

- [ ] **Step 2: Run tests to verify they fail**

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/agent365Exporter.test.ts test/internal/unit/main.test.ts
```

Expected: FAIL because the exporter does not initialize or use durable delivery.

- [ ] **Step 3: Initialize the manager lazily**

Add fields:

```ts
private durableManager?: DurableDeliveryManager;
private durableManagerPromise?: Promise<DurableDeliveryManager>;
private readonly activeExports = new Set<Promise<void>>();
```

Create the manager only when `options.durableDelivery.enabled`:

```ts
private async getDurableManager(): Promise<DurableDeliveryManager> {
  if (this.durableManager) return this.durableManager;
  this.durableManagerPromise ??= PersistentStore.create(
    this.options.durableDelivery,
    this.logger,
  ).then((store) => new DurableDeliveryManager(
    this.options.durableDelivery,
    store,
    this.logger,
    {
      resolveToken: (record) => this.resolveRecordToken(record),
      send: (record, token, signal) => this.postRecordOnce(record, token, signal),
    },
  ));
  this.durableManager = await this.durableManagerPromise;
  return this.durableManager;
}
```

Do not catch initialization failure into a disabled fallback. A retryable live failure must return
`FAILED` when explicitly enabled durability cannot persist.

- [ ] **Step 4: Route durable chunks without aborting other identities**

Build one record per chunk:

```ts
const record = createDurableRecord({
  tenantId,
  agentId,
  agenticUserId,
  clusterCategory: this.options.clusterCategory,
  domainOverride: this.options.domainOverride,
  useS2SEndpoint: this.options.useS2SEndpoint,
  body,
});
const accepted = await (await this.getDurableManager()).deliver(record);
if (!accepted) {
  anyFailure = true;
}
```

Change group execution to collect outcomes rather than throwing out of the full export. Within one
identity, stop later chunks after a permanent/drop outcome to preserve chunk order, but continue
all other identity groups.

Keep `postWithRetries()` unchanged for non-durable mode. Add `postRecordOnce()` for durable mode;
it performs one `fetch`, records SDK stats, parses `Retry-After`, and returns `DeliveryAttempt`.

- [ ] **Step 5: Wire forceFlush and shutdown**

```ts
async forceFlush(): Promise<void> {
  await Promise.allSettled([...this.activeExports]);
  await this.durableManager?.forceFlush();
}

async shutdown(): Promise<void> {
  if (this.closed) return;
  this.closed = true;
  await Promise.allSettled([...this.activeExports]);
  if (this.durableManagerPromise) {
    await (await this.durableManagerPromise).shutdown();
  }
}
```

Ensure export promises are added to and removed from `activeExports` in `finally`. Do not call the
result callback until all identity groups settle.

- [ ] **Step 6: Run tests to verify they pass**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src\a365\exporter\Agent365Exporter.ts test\internal\unit\a365\agent365Exporter.test.ts test\internal\unit\main.test.ts
git commit -m "feat(a365): integrate durable exporter delivery" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 42d7c423-38b3-4951-b6f3-124cedca83f2"
```

### Task 6: Documentation, changelog, and complete verification

**Files:**
- Modify: `README.md`
- Modify: `A365_DOCUMENTATION.md`
- Modify: `CHANGELOG.md`
- Modify: tests from Tasks 1-5 if verification exposes defects

**Interfaces:**
- Documents: `A365Options.durableDelivery`
- Documents: at-least-once semantics, plaintext storage, filesystem persistence, and shutdown

- [ ] **Step 1: Document configuration and operational constraints**

Add this README example:

```ts
useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    enableObservabilityExporter: true,
    tokenResolver: (agentId, tenantId) => getToken(agentId, tenantId),
    durableDelivery: {
      enabled: true,
      storageDirectory: process.env.A365_DURABLE_STORAGE_DIRECTORY,
      maxStorageBytes: 50 * 1024 * 1024,
      maxRecordAgeMilliseconds: 2 * 24 * 60 * 60 * 1000,
    },
  },
});
```

State:

```md
Durable delivery is disabled by default. When enabled, retryable A365 payloads are stored as
owner-readable plaintext files and replayed with a freshly resolved token. Delivery is
at-least-once, so duplicates are possible. Use a protected persistent volume if records must
survive container or host restart; ephemeral container storage only survives process restart.
```

Add a changelog entry:

```md
- Add opt-in A365 durable store-and-forward delivery with bounded secure local storage, restart
  replay, shared `Retry-After` backoff, and bounded shutdown.
```

- [ ] **Step 2: Run targeted durable tests**

```powershell
npx vitest run --config vitest.unit.config.ts test/internal/unit/a365/durableDeliveryOptions.test.ts test/internal/unit/a365/durableRecord.test.ts test/internal/unit/a365/persistentStore.test.ts test/internal/unit/a365/transmissionGate.test.ts test/internal/unit/a365/durableDeliveryManager.test.ts test/internal/unit/a365/agent365Exporter.test.ts test/internal/unit/a365/a365Configuration.test.ts test/internal/unit/main.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run build, lint, formatting, and all unit tests**

```powershell
npm run build
npm run lint
npm run format
npm run test:unit
```

Expected: all commands exit with code 0. If `format` reports files, run `npm run format:fix`, inspect
the diff, and rerun `npm run format`.

- [ ] **Step 4: Inspect the final change**

```powershell
git --no-pager diff --check
git status --short
git --no-pager diff --stat HEAD~5..HEAD
```

Expected: no whitespace errors; only A365 durable-delivery implementation, tests, and directly
related documentation are changed.

- [ ] **Step 5: Commit documentation and verification fixes**

```powershell
git add README.md A365_DOCUMENTATION.md CHANGELOG.md src test
git commit -m "docs(a365): document durable delivery" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 42d7c423-38b3-4951-b6f3-124cedca83f2"
```
