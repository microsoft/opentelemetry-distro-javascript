// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger } from "../../../../src/a365/logging.js";
import {
  DURABLE_RECORD_VERSION,
  PersistentStore,
  ResolvedDurableDeliveryOptions,
  parseDurableRecord,
} from "../../../../src/a365/exporter/durable/index.js";
import type {
  Agent365DurableDeliveryOptions,
  DurableRecordV1,
} from "../../../../src/a365/exporter/durable/index.js";

describe("PersistentStore", () => {
  const originalEnv = { ...process.env };
  let scratchRoot: string;
  const cleanupRoots = new Set<string>();

  beforeEach(async () => {
    process.env = { ...originalEnv };
    scratchRoot = join(process.cwd(), ".superpowers", "sdd", "task-2-test-artifacts", randomUUID());
    await fs.mkdir(scratchRoot, { recursive: true });
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    for (const root of cleanupRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    cleanupRoots.clear();
    await fs.rm(scratchRoot, { recursive: true, force: true });
  });

  it("writes atomically with owner-only permissions", async () => {
    const root = join(scratchRoot, "secure-store");
    const store = await createStore(root);
    const record = makeRecord();

    const storedPath = await store.persist(record);

    assert.isTrue(await pathExists(storedPath));
    assert.isFalse((await listStoreFiles(root)).some((file) => file.endsWith(".tmp")));

    const persisted = parseDurableRecord(await fs.readFile(storedPath, "utf8"));
    assert.deepEqual(persisted, record);

    if (process.platform !== "win32") {
      assert.strictEqual((await fs.stat(root)).mode & 0o777, 0o700);
      assert.strictEqual((await fs.stat(storedPath)).mode & 0o777, 0o600);
    }
  });

  it("rejects symlink roots", async () => {
    const target = join(scratchRoot, "target");
    const link = join(scratchRoot, "link");
    await fs.mkdir(target, { recursive: true });
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");

    await expect(createStore(link)).rejects.toThrow(
      /Durable storage root must be a real directory/,
    );
  });

  it("surfaces explicit directory failures without fallback", async () => {
    const blockedParent = join(scratchRoot, "blocked-parent");
    const fallbackBase = join(scratchRoot, "fallback-base");
    const explicitRoot = join(blockedParent, "child");
    await fs.writeFile(blockedParent, "not-a-directory", "utf8");
    await fs.mkdir(fallbackBase, { recursive: true });

    setFallbackEnvironment(fallbackBase);

    await expect(createStore(explicitRoot)).rejects.toThrow();
    assert.isFalse(await pathExists(join(fallbackBase, "Microsoft", "A365", "otel-durable")));
  });

  it("probes default roots and falls back after failures", async () => {
    const firstCandidate = join(scratchRoot, "first-candidate.txt");
    const fallbackBase = join(scratchRoot, "fallback-base");
    await fs.writeFile(firstCandidate, "blocked", "utf8");
    await fs.mkdir(fallbackBase, { recursive: true });

    if (process.platform === "win32") {
      process.env.LOCALAPPDATA = firstCandidate;
      process.env.TEMP = fallbackBase;
    } else {
      process.env.TMPDIR = firstCandidate;
      cleanupRoots.add(join("/var/tmp", "Microsoft", "A365", "otel-durable"));
    }

    const store = await createDefaultStore();
    const storedPath = await store.persist(makeRecord());
    const expectedRoot =
      process.platform === "win32"
        ? join(fallbackBase, "Microsoft", "A365", "otel-durable")
        : join("/var/tmp", "Microsoft", "A365", "otel-durable");

    assert.ok(storedPath.startsWith(expectedRoot));
    assert.isTrue(await pathExists(expectedRoot));
  });

  it("rejects records larger than configured storage capacity", async () => {
    const root = join(scratchRoot, "oversize-store");
    const store = await createStore(root, { maxStorageBytes: 128 });

    await expect(store.persist(makeRecord({ body: "x".repeat(1_024) }))).rejects.toThrow(
      /maxStorageBytes/,
    );

    assert.deepEqual(await listStoreFiles(root), []);
  });

  it("prunes expired records and then oldest records before persisting a new record", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const root = join(scratchRoot, "pruning-store");
    const template = makeRecord({ createdAt: 990, body: "a".repeat(80) });
    const recordBytes = Buffer.byteLength(JSON.stringify(template), "utf8");
    const store = await createStore(root, {
      maxStorageBytes: recordBytes * 2 + 16,
      maxRecordAgeMilliseconds: 50,
    });

    const expired = makeRecord({ createdAt: 800, body: "e".repeat(80) });
    const oldest = makeRecord({ createdAt: 960, body: "o".repeat(80) });
    const newest = makeRecord({ createdAt: 970, body: "n".repeat(80) });
    await seedPendingRecord(root, expired);
    await seedPendingRecord(root, oldest);
    await seedPendingRecord(root, newest);

    const replacement = makeRecord({ createdAt: 1_000, body: "r".repeat(80) });
    await store.persist(replacement);

    const bodies = await storedBodies(root);
    assert.notInclude(bodies, expired.body);
    assert.notInclude(bodies, oldest.body);
    assert.include(bodies, newest.body);
    assert.include(bodies, replacement.body);
  });

  it("allows only one concurrent claimant", async () => {
    const root = join(scratchRoot, "concurrency-store");
    const store = await createStore(root);
    const record = makeRecord();
    await store.persist(record);

    const [first, second] = await Promise.all([store.claimBatch(1), store.claimBatch(1)]);

    assert.strictEqual(first.length + second.length, 1);
    assert.strictEqual((first[0] ?? second[0]).record.id, record.id);
  });

  it("recovers stale leases before selecting pending records", async () => {
    const root = join(scratchRoot, "stale-lease-store");
    const store = await createStore(root, { leaseDurationMilliseconds: 50 });
    const record = makeRecord();
    await store.persist(record);

    const [claim] = await store.claimBatch(1);
    assert.ok(claim);

    await fs.utimes(claim.leasePath, new Date(0), new Date(0));

    const [reclaimed] = await store.claimBatch(1);
    assert.ok(reclaimed);
    assert.strictEqual(reclaimed.record.id, record.id);
    assert.notStrictEqual(reclaimed.leasePath, claim.leasePath);
    assert.isFalse(await pathExists(claim.leasePath));
  });

  it("keeps quarantined malformed records terminal after lease expiry", async () => {
    const root = join(scratchRoot, "quarantine-terminal-store");
    const store = await createStore(root, { leaseDurationMilliseconds: 50 });
    const badPath = join(root, `1-${randomUUID()}.pending`);
    await fs.writeFile(badPath, '{"version":2}', "utf8");

    assert.deepEqual(await store.claimBatch(1), []);

    const initialFiles = (await listStoreFiles(root)).sort();
    const quarantineFile = initialFiles.find((file) => file.endsWith(".quarantine"));
    assert.isDefined(quarantineFile);

    await fs.utimes(join(root, quarantineFile), new Date(0), new Date(0));

    assert.deepEqual(await store.claimBatch(1), []);
    assert.deepEqual((await listStoreFiles(root)).sort(), initialFiles);
  });

  it("quarantines malformed records", async () => {
    const root = join(scratchRoot, "malformed-store");
    const store = await createStore(root);
    const badPath = join(root, `1-${randomUUID()}.pending`);
    await fs.writeFile(badPath, '{"version":2}', "utf8");

    const claims = await store.claimBatch(1);
    const files = await listStoreFiles(root);

    assert.deepEqual(claims, []);
    assert.isFalse(await pathExists(badPath));
    assert.isTrue(files.some((file) => file.endsWith(".quarantine")));
  });

  it("does not prune active lease files during capacity eviction", async () => {
    const root = join(scratchRoot, "active-lease-prune-store");
    const template = makeRecord({ createdAt: 500, body: "a".repeat(80) });
    const recordBytes = Buffer.byteLength(JSON.stringify(template), "utf8");
    const store = await createStore(root, {
      maxStorageBytes: recordBytes * 2 + 16,
    });
    const leasedRecord = makeRecord({ createdAt: 100, body: "l".repeat(80) });
    await store.persist(leasedRecord);

    const [claim] = await store.claimBatch(1);
    assert.ok(claim);

    const evictableRecord = makeRecord({ createdAt: 200, body: "p".repeat(80) });
    await seedPendingRecord(root, evictableRecord);

    const replacement = makeRecord({ createdAt: 300, body: "r".repeat(80) });
    await store.persist(replacement);

    assert.isTrue(await pathExists(claim.leasePath));
    assert.include(await listStoreFiles(root), basename(claim.leasePath));

    const bodies = await storedBodies(root);
    assert.include(bodies, leasedRecord.body);
    assert.include(bodies, replacement.body);
    assert.notInclude(bodies, evictableRecord.body);
  });

  it("releases claimed records back to pending storage", async () => {
    const root = join(scratchRoot, "release-store");
    const store = await createStore(root);
    const record = makeRecord();
    await store.persist(record);

    const [claim] = await store.claimBatch(1);
    assert.ok(claim);

    await store.release(claim);

    assert.isFalse(await pathExists(claim.leasePath));
    const [reclaimed] = await store.claimBatch(1);
    assert.ok(reclaimed);
    assert.strictEqual(reclaimed.record.id, record.id);
  });

  it("ignores ENOENT when releasing a claim already recovered elsewhere", async () => {
    const root = join(scratchRoot, "release-enoent-store");
    const store = await createStore(root);
    await store.persist(makeRecord());

    const [claim] = await store.claimBatch(1);
    assert.ok(claim);
    await fs.unlink(claim.leasePath);

    await store.release(claim);

    assert.deepEqual(await listStoreFiles(root), []);
  });

  it("propagates non-ENOENT release failures", async () => {
    const root = join(scratchRoot, "release-error-store");
    const store = await createStore(root);
    await store.persist(makeRecord());

    const [claim] = await store.claimBatch(1);
    assert.ok(claim);

    const invalidClaim = { ...claim, leasePath: "\u0000invalid-lease-path" };
    await expect(store.release(invalidClaim)).rejects.not.toMatchObject({ code: "ENOENT" });
  });

  it("deletes completed claims", async () => {
    const root = join(scratchRoot, "complete-store");
    const store = await createStore(root);
    await store.persist(makeRecord());

    const [claim] = await store.claimBatch(1);
    assert.ok(claim);

    await store.complete(claim);

    assert.isFalse(await pathExists(claim.leasePath));
    assert.deepEqual(await listStoreFiles(root), []);
  });

  it("ignores ENOENT when completing a claim already removed elsewhere", async () => {
    const root = join(scratchRoot, "complete-enoent-store");
    const store = await createStore(root);
    await store.persist(makeRecord());

    const [claim] = await store.claimBatch(1);
    assert.ok(claim);
    await fs.unlink(claim.leasePath);

    await store.complete(claim);

    assert.deepEqual(await listStoreFiles(root), []);
  });

  it("propagates non-ENOENT completion failures", async () => {
    const root = join(scratchRoot, "complete-error-store");
    const store = await createStore(root);
    await store.persist(makeRecord());

    const [claim] = await store.claimBatch(1);
    assert.ok(claim);

    const invalidClaim = { ...claim, leasePath: "\u0000invalid-lease-path" };
    await expect(store.complete(invalidClaim)).rejects.not.toMatchObject({ code: "ENOENT" });
  });
});

function makeLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeRecord(overrides: Partial<DurableRecordV1> = {}): DurableRecordV1 {
  return {
    version: DURABLE_RECORD_VERSION,
    id: overrides.id ?? randomUUID(),
    createdAt: overrides.createdAt ?? Date.now(),
    tenantId: overrides.tenantId ?? "tenant",
    agentId: overrides.agentId ?? "agent",
    agenticUserId: overrides.agenticUserId ?? "user",
    clusterCategory: overrides.clusterCategory ?? "prod",
    domainOverride: overrides.domainOverride,
    useS2SEndpoint: overrides.useS2SEndpoint ?? false,
    body: overrides.body ?? '{"resourceSpans":[]}',
  };
}

async function createStore(
  storageDirectory: string,
  overrides: Partial<Agent365DurableDeliveryOptions> = {},
): Promise<PersistentStore> {
  return PersistentStore.create(
    new ResolvedDurableDeliveryOptions({
      enabled: true,
      storageDirectory,
      ...overrides,
    }),
    makeLogger(),
  );
}

async function createDefaultStore(
  overrides: Partial<Agent365DurableDeliveryOptions> = {},
): Promise<PersistentStore> {
  return PersistentStore.create(
    new ResolvedDurableDeliveryOptions({
      enabled: true,
      ...overrides,
    }),
    makeLogger(),
  );
}

async function seedPendingRecord(root: string, record: DurableRecordV1): Promise<string> {
  const filePath = join(root, `${record.createdAt}-${record.id}.pending`);
  await fs.writeFile(filePath, JSON.stringify(record), "utf8");
  return filePath;
}

async function storedBodies(root: string): Promise<string[]> {
  const bodies: string[] = [];
  for (const file of await listStoreFiles(root)) {
    const fullPath = join(root, file);
    try {
      const parsed = parseDurableRecord(await fs.readFile(fullPath, "utf8"));
      bodies.push(parsed.body);
    } catch {
      // Ignore quarantined or malformed files in helper output.
    }
  }
  return bodies;
}

async function listStoreFiles(root: string): Promise<string[]> {
  try {
    return await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function setFallbackEnvironment(basePath: string): void {
  if (process.platform === "win32") {
    process.env.LOCALAPPDATA = basePath;
    process.env.TEMP = basePath;
    return;
  }

  process.env.TMPDIR = basePath;
}
