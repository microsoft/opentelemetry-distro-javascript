// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger } from "../../../../src/a365/logging.js";
import { applicationPartition } from "../../../../src/a365/exporter/durable/PersistentStore.js";
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

const disappearingFileScan = vi.hoisted(() => ({
  path: undefined as string | undefined,
  count: 0,
}));

const tmpdirOverride = vi.hoisted(() => ({
  value: undefined as string | undefined,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    tmpdir: () => tmpdirOverride.value ?? actual.tmpdir(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (path: string | Buffer | URL, options?: unknown) => {
      if (path === disappearingFileScan.path) {
        disappearingFileScan.count += 1;
        const error = new Error("simulated disappearing file") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return actual.stat(path, options as never);
    },
  };
});

describe("PersistentStore", () => {
  const originalEnv = { ...process.env };
  const nativePlatform = process.platform;
  let scratchRoot: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    disappearingFileScan.path = undefined;
    disappearingFileScan.count = 0;
    tmpdirOverride.value = undefined;
    scratchRoot = join(process.cwd(), ".superpowers", "sdd", "task-2-test-artifacts", randomUUID());
    await fs.mkdir(scratchRoot, { recursive: true });
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    tmpdirOverride.value = undefined;
    vi.restoreAllMocks();
    await fs.rm(scratchRoot, { recursive: true, force: true });
  });

  it("writes atomically with owner-only permissions", async () => {
    const root = join(scratchRoot, "secure-store");
    const store = await createStore(root);
    const record = makeRecord();

    const storedPath = await store.persist(record);
    const storeRoot = dirname(storedPath);

    assert.isTrue(await pathExists(storedPath));
    assert.isFalse((await listStoreFiles(root)).some((file) => file.endsWith(".tmp")));
    assert.strictEqual(dirname(storeRoot), root);
    assert.match(basename(storeRoot), /^app-[0-9a-f]{16}$/);

    const persisted = parseDurableRecord(await fs.readFile(storedPath, "utf8"));
    assert.deepEqual(persisted, record);

    if (process.platform !== "win32") {
      assert.strictEqual((await fs.stat(storeRoot)).mode & 0o777, 0o700);
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

  it("partitions explicit roots by stable application identity instead of the current cwd", async () => {
    const explicitRoot = join(scratchRoot, "partitioned-explicit-root");
    const firstCwd = join(scratchRoot, "cwd-one");
    const secondCwd = join(scratchRoot, "cwd-two");
    await fs.mkdir(firstCwd, { recursive: true });
    await fs.mkdir(secondCwd, { recursive: true });

    const originalArgv1 = process.argv[1];
    const originalCwd = process.cwd();

    try {
      process.argv[1] = join(scratchRoot, "entry-a.mjs");

      process.chdir(firstCwd);
      const firstPath = await (await createStore(explicitRoot)).persist(makeRecord());

      process.chdir(secondCwd);
      const secondPath = await (await createStore(explicitRoot)).persist(makeRecord());

      process.argv[1] = join(scratchRoot, "entry-b.mjs");
      const thirdPath = await (await createStore(explicitRoot)).persist(makeRecord());

      const firstRoot = dirname(firstPath);
      const secondRoot = dirname(secondPath);
      const thirdRoot = dirname(thirdPath);

      assert.strictEqual(dirname(firstRoot), explicitRoot);
      assert.match(basename(firstRoot), /^app-[0-9a-f]{16}$/);
      assert.strictEqual(secondRoot, firstRoot);
      assert.notStrictEqual(thirdRoot, firstRoot);
    } finally {
      if (originalArgv1 === undefined) {
        process.argv.splice(1, 1);
      } else {
        process.argv[1] = originalArgv1;
      }
      process.chdir(originalCwd);
    }
  });

  it("probes default roots and falls back after failures", async () => {
    const firstCandidate = join(scratchRoot, "first-candidate.txt");
    const fallbackBase = join(scratchRoot, "fallback-base");
    await fs.writeFile(firstCandidate, "blocked", "utf8");
    await fs.mkdir(fallbackBase, { recursive: true });
    const restorePlatform = useWindowsDefaultCandidates(nativePlatform);

    try {
      process.env.LOCALAPPDATA = firstCandidate;
      process.env.TEMP = fallbackBase;

      const store = await createDefaultStore();
      const storedPath = await store.persist(makeRecord());
      const expectedRoot = defaultStorageRoot(fallbackBase);

      assert.ok(storedPath.startsWith(expectedRoot));
      assert.isTrue(await pathExists(expectedRoot));
    } finally {
      restorePlatform();
    }
  });

  it("uses POSIX fallback candidates in exact de-duplicated order", async () => {
    const restorePlatform = usePosixDefaultCandidates(nativePlatform);
    const logger = makeLogger();
    const actualMkdir = fs.mkdir.bind(fs);
    const expectedAttempts = [defaultStorageRoot("/tmp"), defaultStorageRoot("/var/tmp")];
    const blockedBaseRoots = [defaultStorageBaseRoot("/tmp"), defaultStorageBaseRoot("/var/tmp")];

    tmpdirOverride.value = "/tmp";
    vi.spyOn(fs, "mkdir").mockImplementation(async (path, options) => {
      const normalizedPath = String(path);
      if (
        blockedBaseRoots.some(
          (baseRoot) =>
            normalizedPath === baseRoot ||
            normalizedPath.startsWith(`${baseRoot}\\`) ||
            normalizedPath.startsWith(`${baseRoot}/`),
        )
      ) {
        const error = new Error("blocked default root") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }

      return actualMkdir(path, options as never);
    });

    try {
      process.env.TMPDIR = "/tmp";

      await expect(
        PersistentStore.create(
          new ResolvedDurableDeliveryOptions({
            enabled: true,
          }),
          logger,
        ),
      ).rejects.toThrow(/blocked default root/);

      assert.deepEqual(
        logger.warn.mock.calls.map((call) => call[1]),
        expectedAttempts,
      );
      assert.strictEqual(logger.warn.mock.calls.length, expectedAttempts.length);
    } finally {
      restorePlatform();
    }
  });

  it("rejects a symlinked default root before falling back", async () => {
    const firstCandidate = join(scratchRoot, "symlinked-default-candidate");
    const fallbackBase = join(scratchRoot, "fallback-base");
    const symlinkedRoot = join(firstCandidate, "Microsoft", "A365", "otel-durable");
    const target = join(scratchRoot, "symlink-target");
    await fs.mkdir(dirname(symlinkedRoot), { recursive: true });
    await fs.mkdir(target, { recursive: true });
    await fs.symlink(target, symlinkedRoot, nativePlatform === "win32" ? "junction" : "dir");
    const restorePlatform = useWindowsDefaultCandidates(nativePlatform);

    try {
      process.env.LOCALAPPDATA = firstCandidate;
      process.env.TEMP = fallbackBase;

      const storedPath = await (await createDefaultStore()).persist(makeRecord());
      const expectedRoot = defaultStorageRoot(fallbackBase);

      assert.ok(storedPath.startsWith(expectedRoot));
      assert.isFalse(storedPath.startsWith(symlinkedRoot));
    } finally {
      restorePlatform();
    }
  });

  it("uses a single owner-only per-user leaf for a POSIX default root", async () => {
    if (nativePlatform === "win32") {
      return;
    }

    const candidate = join(scratchRoot, "posix-default-candidate");
    await fs.mkdir(candidate, { recursive: true });
    process.env.TMPDIR = candidate;

    const storedPath = await (await createDefaultStore()).persist(makeRecord());
    const root = defaultStorageRoot(candidate);
    const baseRoot = defaultStorageBaseRoot(candidate);

    assert.ok(storedPath.startsWith(root));
    assert.strictEqual(dirname(root), baseRoot);
    assert.strictEqual(dirname(baseRoot), candidate);
    assert.match(basename(baseRoot), /^a365-otel-durable-\d+$/);
    assert.match(basename(root), /^app-[0-9a-f]{16}$/);
    assert.strictEqual((await fs.stat(root)).mode & 0o777, 0o700);
    assert.strictEqual((await fs.stat(root)).uid, process.getuid!());
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

  it("warns with reason, path, and bytes for expired and capacity evictions", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const root = join(scratchRoot, "pruning-warning-store");
    const logger = makeLogger();
    const template = makeRecord({ createdAt: 990, body: "a".repeat(80) });
    const recordBytes = Buffer.byteLength(JSON.stringify(template), "utf8");
    const store = await createStore(
      root,
      {
        maxStorageBytes: recordBytes * 2 + 16,
        maxRecordAgeMilliseconds: 50,
      },
      logger,
    );

    const expired = makeRecord({ createdAt: 800, body: "e".repeat(80) });
    const oldest = makeRecord({ createdAt: 960, body: "o".repeat(80) });
    const newest = makeRecord({ createdAt: 970, body: "n".repeat(80) });
    const expiredPath = await seedPendingRecord(root, expired);
    const oldestPath = await seedPendingRecord(root, oldest);
    await seedPendingRecord(root, newest);

    await store.persist(makeRecord({ createdAt: 1_000, body: "r".repeat(80) }));

    expect(logger.warn).toHaveBeenCalledWith("[PersistentStore] Evicted expired durable record", {
      path: expiredPath,
      bytes: Buffer.byteLength(JSON.stringify(expired), "utf8"),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "[PersistentStore] Evicted durable record for capacity",
      {
        path: oldestPath,
        bytes: Buffer.byteLength(JSON.stringify(oldest), "utf8"),
      },
    );
    assert.strictEqual(logger.warn.mock.calls.length, 2);
  });

  it("tolerates consecutive disappeared file scans when storage has capacity", async () => {
    const root = join(scratchRoot, "disappearing-scan-store");
    const store = await createStore(root);
    const disappearingPath = join(
      explicitStorageRoot(root),
      `${Date.now()}-${randomUUID()}.pending`,
    );
    await fs.writeFile(disappearingPath, "disappearing bytes", "utf8");

    disappearingFileScan.path = disappearingPath;

    const storedPath = await store.persist(makeRecord());

    assert.isAtLeast(disappearingFileScan.count, 2);
    assert.isTrue(await pathExists(storedPath));
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

  it("does not recover an old record claimed within the lease duration across concurrent stores", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const root = join(scratchRoot, "fresh-claim-store");
    const record = makeRecord({ createdAt: now - 10_000 });
    const store = await createStore(root, { leaseDurationMilliseconds: 50 });
    const competingStore = await createStore(root, { leaseDurationMilliseconds: 50 });
    const pendingPath = await seedPendingRecord(root, record);
    await fs.utimes(pendingPath, new Date(record.createdAt), new Date(record.createdAt));

    const [claim] = await store.claimBatch(1);
    assert.ok(claim);

    const [firstConcurrentClaims, secondConcurrentClaims] = await Promise.all([
      store.claimBatch(1),
      competingStore.claimBatch(1),
    ]);
    assert.deepEqual(firstConcurrentClaims, []);
    assert.deepEqual(secondConcurrentClaims, []);

    now += 50;
    assert.deepEqual(await competingStore.claimBatch(1), []);

    now += 1;
    const [reclaimed] = await competingStore.claimBatch(1);
    assert.ok(reclaimed);
    assert.strictEqual(reclaimed.record.id, record.id);
    assert.notStrictEqual(reclaimed.leasePath, claim.leasePath);
  });

  it("recovers leases after their acquisition timestamp expires", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const root = join(scratchRoot, "stale-lease-store");
    const store = await createStore(root, { leaseDurationMilliseconds: 50 });
    const record = makeRecord();
    await store.persist(record);

    const [claim] = await store.claimBatch(1);
    assert.ok(claim);

    now += 51;

    const [reclaimed] = await store.claimBatch(1);
    assert.ok(reclaimed);
    assert.strictEqual(reclaimed.record.id, record.id);
    assert.notStrictEqual(reclaimed.leasePath, claim.leasePath);
    assert.isFalse(await pathExists(claim.leasePath));
  });

  it("reclaims a record through repeated stale lease recoveries with bounded names", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const root = join(scratchRoot, "repeated-stale-lease-store");
    const store = await createStore(root, { leaseDurationMilliseconds: 50 });
    const record = makeRecord({ createdAt: now, id: "record.with.dot" });
    const stableBaseName = `${record.createdAt}-${record.id}`;
    await store.persist(record);

    const [initialClaim] = await store.claimBatch(1);
    assert.ok(initialClaim);
    await store.release(initialClaim);

    let [claim] = await store.claimBatch(1);
    assert.ok(claim);
    for (let recovery = 0; recovery < 5; recovery++) {
      now += 51;

      const [reclaimed] = await store.claimBatch(1);
      assert.ok(reclaimed);
      assert.strictEqual(reclaimed.record.id, record.id);

      const leaseName = basename(reclaimed.leasePath);
      assert.isTrue(leaseName.startsWith(`${stableBaseName}.recovered-`));
      assert.strictEqual(leaseName.split(".recovered-").length - 1, 1);
      assert.notInclude(leaseName, ".release-");

      claim = reclaimed;
    }

    assert.ok(claim);
  });

  it("does not expire a fresh record because a parent directory starts with digits", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const root = join(scratchRoot, "365-svc", "basename-created-at-store");
    const store = await createStore(root, {
      maxRecordAgeMilliseconds: 50,
      maxStorageBytes: 10_000,
    });
    const freshRecord = makeRecord({ createdAt: 1_000, body: "fresh" });
    const freshPath = join(explicitStorageRoot(root), "fresh.pending");
    await fs.writeFile(freshPath, JSON.stringify(freshRecord), "utf8");
    await fs.utimes(freshPath, new Date(1_000), new Date(1_000));

    await store.persist(makeRecord({ createdAt: 1_000, body: "replacement" }));

    assert.isTrue(await pathExists(freshPath));
  });

  it("removes a temporary file when writing it fails", async () => {
    const root = join(scratchRoot, "write-failure-store");
    const store = await createStore(root);
    const probePath = join(explicitStorageRoot(root), "file-handle-prototype-probe");
    const probeHandle = await fs.open(probePath, "w");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as typeof probeHandle;
    await probeHandle.close();
    await fs.unlink(probePath);
    vi.spyOn(fileHandlePrototype, "writeFile").mockRejectedValueOnce(
      new Error("simulated write failure"),
    );

    await expect(store.persist(makeRecord())).rejects.toThrow(/simulated write failure/);

    assert.isEmpty((await listStoreFiles(root)).filter((file) => file.endsWith(".tmp")));
  });

  it("sweeps stale temporary files before accepting a new record", async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const root = join(scratchRoot, "stale-temp-store");
    const store = await createStore(root, { maxRecordAgeMilliseconds: 50 });
    const staleTemporary = join(explicitStorageRoot(root), `${now - 51}-${randomUUID()}.tmp`);
    await fs.writeFile(staleTemporary, "stale temporary bytes", "utf8");

    await store.persist(makeRecord());

    assert.isFalse(await pathExists(staleTemporary));
  });

  it("counts non-stale temporary bytes against storage capacity without evicting them", async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const root = join(scratchRoot, "temporary-capacity-store");
    const record = makeRecord({ createdAt: now, body: "record-body" });
    const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    const store = await createStore(root, { maxStorageBytes: recordBytes + 1 });
    const temporaryPath = join(explicitStorageRoot(root), `${now}-${randomUUID()}.tmp`);
    await fs.writeFile(temporaryPath, "x".repeat(recordBytes), "utf8");

    await expect(store.persist(record)).rejects.toThrow(/capacity/i);

    assert.isTrue(await pathExists(temporaryPath));
    assert.isEmpty((await listStoreFiles(root)).filter((file) => file.endsWith(".pending")));
  });

  it("counts active leases against storage capacity without evicting them", async () => {
    const root = join(scratchRoot, "active-lease-capacity-store");
    const leasedRecord = makeRecord({ body: "same-sized-record" });
    const replacement = makeRecord({ body: "same-sized-record" });
    const maxStorageBytes =
      Math.max(
        Buffer.byteLength(JSON.stringify(leasedRecord), "utf8"),
        Buffer.byteLength(JSON.stringify(replacement), "utf8"),
      ) + 1;
    const store = await createStore(root, { maxStorageBytes });
    await store.persist(leasedRecord);
    const [claim] = await store.claimBatch(1);
    assert.ok(claim);

    await expect(store.persist(replacement)).rejects.toThrow(/capacity/i);

    assert.isTrue(await pathExists(claim.leasePath));
  });

  it("serializes concurrent persists sharing a storage root to preserve capacity", async () => {
    const root = join(scratchRoot, "concurrent-persist-capacity-store");
    const firstRecord = makeRecord({ body: "first concurrent record" });
    const secondRecord = makeRecord({ body: "second concurrent record" });
    const firstRecordBytes = Buffer.byteLength(JSON.stringify(firstRecord), "utf8");
    const secondRecordBytes = Buffer.byteLength(JSON.stringify(secondRecord), "utf8");

    const options = { maxStorageBytes: Math.max(firstRecordBytes, secondRecordBytes) + 1 };
    const firstStore = await createStore(root, options);
    const secondStore = await createStore(root, options);

    await Promise.all([firstStore.persist(firstRecord), secondStore.persist(secondRecord)]);

    const pendingFiles = (await listStoreFiles(root)).filter((file) => file.endsWith(".pending"));
    const retainedBytes = await Promise.all(
      pendingFiles.map(async (file) => (await fs.stat(join(explicitStorageRoot(root), file))).size),
    );
    assert.strictEqual(pendingFiles.length, 1);
    assert.isAtMost(
      retainedBytes.reduce((total, size) => total + size, 0),
      options.maxStorageBytes,
    );
  });

  it("migrates legacy leases to a fresh claim timestamp before recovering them", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const root = join(scratchRoot, "legacy-lease-store");
    const store = await createStore(root, { leaseDurationMilliseconds: 50 });
    const record = makeRecord({ createdAt: now - 10_000 });
    const pendingPath = await seedPendingRecord(root, record);
    await fs.utimes(pendingPath, new Date(record.createdAt), new Date(record.createdAt));
    const legacyLeasePath = pendingPath.replace(
      /\.pending$/,
      `.lease-${process.pid}-${randomUUID()}`,
    );
    await fs.rename(pendingPath, legacyLeasePath);

    assert.deepEqual(await store.claimBatch(1), []);
    assert.isFalse(await pathExists(legacyLeasePath));
    assert.isTrue((await listStoreFiles(root)).some((file) => file.includes(".lease-at-1000000-")));

    now += 50;
    assert.deepEqual(await store.claimBatch(1), []);

    now += 1;
    const [reclaimed] = await store.claimBatch(1);
    assert.ok(reclaimed);
    assert.strictEqual(reclaimed.record.id, record.id);
  });

  it("keeps quarantined malformed records terminal after lease expiry", async () => {
    const root = join(scratchRoot, "quarantine-terminal-store");
    const store = await createStore(root, { leaseDurationMilliseconds: 50 });
    const badPath = join(explicitStorageRoot(root), `1-${randomUUID()}.pending`);
    await fs.writeFile(badPath, '{"version":2}', "utf8");

    assert.deepEqual(await store.claimBatch(1), []);

    const initialFiles = (await listStoreFiles(root)).sort();
    const quarantineFile = initialFiles.find((file) => file.endsWith(".quarantine"));
    assert.isDefined(quarantineFile);

    await fs.utimes(join(explicitStorageRoot(root), quarantineFile), new Date(0), new Date(0));

    assert.deepEqual(await store.claimBatch(1), []);
    assert.deepEqual((await listStoreFiles(root)).sort(), initialFiles);
  });

  it("quarantines malformed records", async () => {
    const root = join(scratchRoot, "malformed-store");
    const store = await createStore(root);
    const badPath = join(explicitStorageRoot(root), `1-${randomUUID()}.pending`);
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

function makeLogger() {
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
    useS2SEndpoint: overrides.useS2SEndpoint ?? false,
    body: overrides.body ?? '{"resourceSpans":[]}',
  };
}

async function createStore(
  storageDirectory: string,
  overrides: Partial<Agent365DurableDeliveryOptions> = {},
  logger: ILogger = makeLogger(),
): Promise<PersistentStore> {
  return PersistentStore.create(
    new ResolvedDurableDeliveryOptions({
      enabled: true,
      storageDirectory,
      ...overrides,
    }),
    logger,
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
  const filePath = join(explicitStorageRoot(root), `${record.createdAt}-${record.id}.pending`);
  await fs.writeFile(filePath, JSON.stringify(record), "utf8");
  return filePath;
}

async function storedBodies(root: string): Promise<string[]> {
  const bodies: string[] = [];
  for (const file of await listStoreFiles(root)) {
    const fullPath = join(explicitStorageRoot(root), file);
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
    return await fs.readdir(explicitStorageRoot(root));
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

function defaultStorageRoot(candidate: string): string {
  return join(defaultStorageBaseRoot(candidate), applicationPartition());
}

function defaultStorageBaseRoot(candidate: string): string {
  if (process.platform === "win32") {
    return join(candidate, "Microsoft", "A365", "otel-durable");
  }

  return join(candidate, `a365-otel-durable-${process.getuid?.() ?? "unknown"}`);
}

function explicitStorageRoot(root: string): string {
  return join(root, applicationPartition());
}

function useWindowsDefaultCandidates(nativePlatform: string): () => void {
  if (nativePlatform === "win32") {
    return () => {};
  }

  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) {
    throw new Error("Unable to override process.platform for this test");
  }

  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  return () => Object.defineProperty(process, "platform", descriptor);
}

function usePosixDefaultCandidates(nativePlatform: string): () => void {
  if (nativePlatform !== "win32") {
    return () => {};
  }

  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) {
    throw new Error("Unable to override process.platform for this test");
  }

  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  return () => Object.defineProperty(process, "platform", descriptor);
}
