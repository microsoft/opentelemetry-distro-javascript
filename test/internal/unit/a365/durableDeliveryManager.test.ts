// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { ILogger } from "../../../../src/a365/logging.js";
import {
  DURABLE_RECORD_VERSION,
  DurableDeliveryManager,
  ResolvedDurableDeliveryOptions,
} from "../../../../src/a365/exporter/durable/index.js";
import type {
  Agent365DurableDeliveryOptions,
  ClaimedRecord,
  DeliveryAttempt,
  DurableRecordV1,
  PersistentStore,
} from "../../../../src/a365/exporter/durable/index.js";

const managedInstances: DurableDeliveryManager[] = [];

describe("DurableDeliveryManager", () => {
  afterEach(async () => {
    while (managedInstances.length > 0) {
      await managedInstances
        .pop()!
        .shutdown()
        .catch(() => undefined);
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([408, 429, 500, 503])(
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

  it("persists live records while the transmission gate is deferring sends", async () => {
    const { manager, persist, send } = createManager();
    send.mockResolvedValueOnce({
      kind: "retryable",
      correlationId: "seed",
      retryAfterMs: 60_000,
    });

    assert.isTrue(await manager.deliver(makeRecord({ id: "seed" })));

    send.mockClear();

    assert.isTrue(await manager.deliver(makeRecord({ id: "blocked" })));
    assert.strictEqual(send.mock.calls.length, 0);
    assert.strictEqual(persist.mock.calls.length, 2);
  });

  it("treats missing live tokens as permanent but persists resolver exceptions", async () => {
    const { manager, persist, resolveToken, send } = createManager();
    resolveToken.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("sts unavailable"));

    assert.isFalse(await manager.deliver(makeRecord({ id: "missing-token" })));
    assert.isTrue(await manager.deliver(makeRecord({ id: "resolver-error" })));

    assert.strictEqual(persist.mock.calls.length, 1);
    assert.strictEqual(send.mock.calls.length, 0);
  });

  it("persists live token resolution timeouts", async () => {
    const { manager, persist, resolveToken, send } = createManager({
      options: { tokenResolutionTimeoutMilliseconds: 5 },
    });
    resolveToken.mockImplementation(() => new Promise<string | null>(() => undefined));

    assert.isTrue(await manager.deliver(makeRecord({ id: "timeout" })));
    assert.strictEqual(persist.mock.calls.length, 1);
    assert.strictEqual(send.mock.calls.length, 0);
  });

  it("does not persist permanent live failures", async () => {
    const { manager, persist, send } = createManager();
    send.mockResolvedValue({
      kind: "permanent",
      correlationId: "permanent",
      status: 400,
      reason: "bad request",
    });

    assert.isFalse(await manager.deliver(makeRecord()));
    assert.strictEqual(send.mock.calls.length, 1);
    assert.strictEqual(persist.mock.calls.length, 0);
  });

  it("continues independent live records after one persistence failure", async () => {
    const { logger, manager, persist, send } = createManager();
    send.mockResolvedValueOnce({
      kind: "retryable",
      correlationId: "seed",
      retryAfterMs: 60_000,
    });
    assert.isTrue(await manager.deliver(makeRecord({ id: "seed" })));

    persist.mockReset();
    persist.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce("second.pending");

    const results = await Promise.all([
      manager.deliver(makeRecord({ id: "first" })),
      manager.deliver(makeRecord({ id: "second" })),
    ]);

    assert.deepEqual(results, [false, true]);
    assert.strictEqual(send.mock.calls.length, 1);
    assert.strictEqual(persist.mock.calls.length, 2);
    assert.strictEqual(logger.error.mock.calls.length, 1);
  });

  it("forceFlush replays pending records immediately with a fresh token and completes success", async () => {
    const { claimBatch, complete, manager, release, resolveToken, send } = createManager();
    const record = makeRecord({ id: "record-for-replay" });
    const claim = makeClaim(record);

    resolveToken.mockResolvedValueOnce("stale-token").mockResolvedValueOnce("fresh-token");
    send
      .mockResolvedValueOnce({ kind: "success", correlationId: "live-success" })
      .mockResolvedValueOnce({ kind: "success", correlationId: "replayed" });
    claimBatch.mockResolvedValueOnce([claim]);

    assert.isTrue(await manager.deliver(record));

    await manager.forceFlush();

    assert.strictEqual(resolveToken.mock.calls.length, 2);
    assert.strictEqual(send.mock.calls.length, 2);
    assert.strictEqual(send.mock.calls[1][1], "fresh-token");
    assert.deepEqual(
      complete.mock.calls.map(([releasedClaim]) => releasedClaim),
      [claim],
    );
    assert.strictEqual(release.mock.calls.length, 0);
  });

  it("serializes simultaneous startReplay, forceFlush, and scheduled replay attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { claimBatch, manager, send } = createManager({
      options: { replayIntervalMilliseconds: 1 },
    });
    const claim = makeClaim(makeRecord({ id: "shared-replay-record" }));
    const firstSendStarted = deferred<void>();
    const allowSendsToFinish = deferred<DeliveryAttempt>();
    let activeSends = 0;
    let maximumActiveSends = 0;

    claimBatch.mockResolvedValue([claim]);
    send.mockImplementation(async () => {
      activeSends += 1;
      maximumActiveSends = Math.max(maximumActiveSends, activeSends);
      firstSendStarted.resolve();
      try {
        return await allowSendsToFinish.promise;
      } finally {
        activeSends -= 1;
      }
    });

    manager.startReplay();
    await firstSendStarted.promise;

    const flush = manager.forceFlush();
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    try {
      assert.strictEqual(maximumActiveSends, 1);
      assert.strictEqual(claimBatch.mock.calls.length, 1);
    } finally {
      allowSendsToFinish.resolve({ kind: "success", correlationId: "serialized" });
      await flush;
    }
  });

  it("claims each replay record only when ready to process it", async () => {
    const { claimBatch, manager, send } = createManager({
      options: { maxReplayBatchSize: 2 },
    });
    const first = makeClaim(makeRecord({ id: "first-replay-record" }));
    const second = makeClaim(makeRecord({ id: "second-replay-record" }));
    const pendingClaims = [first, second];
    const firstSendStarted = deferred<void>();
    const finishFirstSend = deferred<DeliveryAttempt>();

    claimBatch.mockImplementation(async (limit) => pendingClaims.splice(0, limit));
    send.mockImplementation(async (record) => {
      if (record.id === first.record.id) {
        firstSendStarted.resolve();
        return finishFirstSend.promise;
      }
      return { kind: "success", correlationId: record.id };
    });

    const flush = manager.forceFlush();
    await firstSendStarted.promise;

    try {
      assert.deepEqual(claimBatch.mock.calls, [[1]]);
      assert.deepEqual(pendingClaims, [second]);
    } finally {
      finishFirstSend.resolve({ kind: "success", correlationId: first.record.id });
      await flush;
    }

    assert.deepEqual(claimBatch.mock.calls, [[1], [1]]);
    assert.deepEqual(pendingClaims, []);
  });

  it("does not reclaim a released record within the same replay pass", async () => {
    const { claimBatch, manager, release, send } = createManager({
      options: { maxReplayBatchSize: 3 },
    });
    const claim = makeClaim(makeRecord({ id: "released-replay-record" }));

    claimBatch.mockResolvedValue([claim]);
    send.mockResolvedValue({
      kind: "retryable",
      correlationId: "retryable-replay-record",
      retryAfterMs: 60_000,
    });

    await manager.forceFlush();

    assert.deepEqual(claimBatch.mock.calls, [[1]]);
    assert.deepEqual(
      release.mock.calls.map(([releasedClaim]) => releasedClaim),
      [claim],
    );
  });

  it("releases replay claims without sending while the transmission gate is backing off", async () => {
    const { claimBatch, manager, release, resolveToken, send } = createManager();
    const claim = makeClaim(makeRecord({ id: "replay-while-blocked" }));

    send.mockResolvedValueOnce({
      kind: "retryable",
      correlationId: "seed",
      retryAfterMs: 60_000,
    });

    assert.isTrue(await manager.deliver(makeRecord({ id: "seed" })));

    claimBatch.mockResolvedValueOnce([claim]);
    resolveToken.mockClear();
    send.mockClear();

    await manager.forceFlush();

    assert.strictEqual(resolveToken.mock.calls.length, 0);
    assert.strictEqual(send.mock.calls.length, 0);
    assert.deepEqual(
      release.mock.calls.map(([releasedClaim]) => releasedClaim),
      [claim],
    );
  });

  it("allows only one half-open probe across live delivery and replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { claimBatch, manager, persist, resolveToken, send } = createManager({
      options: { replayIntervalMilliseconds: 120_000 },
    });
    const replayClaim = makeClaim(makeRecord({ id: "replay-probe" }));

    send.mockResolvedValueOnce({
      kind: "retryable",
      correlationId: "seed",
      retryAfterMs: 60_000,
    });
    assert.isTrue(await manager.deliver(makeRecord({ id: "seed" })));

    claimBatch.mockResolvedValueOnce([replayClaim]);
    const replayStarted = deferred<void>();
    const replayToken = deferred<string | null>();
    resolveToken.mockReset();
    resolveToken.mockImplementation(async (record) => {
      if (record.id === "replay-probe") {
        replayStarted.resolve();
        return replayToken.promise;
      }
      return "live-token";
    });
    send.mockReset();
    send.mockImplementation(async (record) => ({
      kind: "success",
      correlationId: record.id,
    }));

    await vi.advanceTimersByTimeAsync(60_000);

    const flush = manager.forceFlush();
    await replayStarted.promise;

    const persistedBeforeLive = persist.mock.calls.length;
    const delivery = manager.deliver(makeRecord({ id: "live-probe" }));

    assert.isTrue(await delivery);
    assert.strictEqual(persist.mock.calls.length, persistedBeforeLive + 1);
    assert.strictEqual(send.mock.calls.length, 0);

    replayToken.resolve("replay-token");

    await flush;
    assert.deepEqual(
      send.mock.calls.map(([record]) => record.id),
      ["replay-probe"],
    );
  });

  it("releases retryable, missing-token, timed-out, and unknown replay claims", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { claimBatch, manager, release, resolveToken, send } = createManager({
      options: {
        maxReplayBatchSize: 1,
        tokenResolutionTimeoutMilliseconds: 5,
      },
    });
    const retryable = makeClaim(makeRecord({ id: "retryable-claim" }));
    const missingToken = makeClaim(makeRecord({ id: "missing-token-claim" }));
    const timedOut = makeClaim(makeRecord({ id: "timed-out-claim" }));
    const unknown = makeClaim(makeRecord({ id: "unknown-claim" }));

    claimBatch
      .mockResolvedValueOnce([missingToken])
      .mockResolvedValueOnce([timedOut])
      .mockResolvedValueOnce([unknown])
      .mockResolvedValueOnce([retryable]);
    resolveToken.mockImplementation(async (record) => {
      switch (record.id) {
        case "missing-token-claim":
          return null;
        case "timed-out-claim":
          return new Promise<string | null>(() => undefined);
        default:
          return `${record.id}-token`;
      }
    });
    send.mockImplementation(async (record) => {
      switch (record.id) {
        case "unknown-claim":
          throw new Error("boom");
        case "retryable-claim":
          return { kind: "retryable", correlationId: "retryable", retryAfterMs: 60_000 };
        default:
          return { kind: "success", correlationId: "success" };
      }
    });

    await manager.forceFlush();

    const timedOutFlush = manager.forceFlush();
    await vi.advanceTimersByTimeAsync(5);
    await timedOutFlush;

    await vi.advanceTimersByTimeAsync(60_000);
    await manager.forceFlush();

    await vi.advanceTimersByTimeAsync(60_000);
    await manager.forceFlush();

    assert.deepEqual(release.mock.calls.map(([claim]) => claim.record.id).sort(), [
      "missing-token-claim",
      "retryable-claim",
      "timed-out-claim",
      "unknown-claim",
    ]);
    assert.isFalse(send.mock.calls.some(([record]) => record.id === "missing-token-claim"));
    assert.isFalse(send.mock.calls.some(([record]) => record.id === "timed-out-claim"));
  });

  it("closes the transmission gate after a permanent replay probe response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { claimBatch, complete, manager, persist, resolveToken, send } = createManager();
    const claim = makeClaim(makeRecord({ id: "permanent-replay-probe" }));
    const firstToken = deferred<string | null>();

    send.mockResolvedValueOnce({
      kind: "retryable",
      correlationId: "seed",
      retryAfterMs: 60_000,
    });
    assert.isTrue(await manager.deliver(makeRecord({ id: "seed" })));

    claimBatch.mockResolvedValueOnce([claim]);
    send.mockResolvedValueOnce({
      kind: "permanent",
      correlationId: "permanent",
      status: 400,
      reason: "bad request",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await manager.forceFlush();

    assert.deepEqual(
      complete.mock.calls.map(([completedClaim]) => completedClaim),
      [claim],
    );

    resolveToken.mockReset();
    resolveToken
      .mockImplementationOnce(async () => firstToken.promise)
      .mockResolvedValueOnce("second-token");
    send.mockReset();
    send
      .mockResolvedValueOnce({
        kind: "success",
        correlationId: "after-permanent-1",
      })
      .mockResolvedValueOnce({
        kind: "success",
        correlationId: "after-permanent-2",
      });

    const persistedBeforeRecovery = persist.mock.calls.length;
    const firstRecovery = manager.deliver(makeRecord({ id: "after-permanent-1" }));
    await settle();
    const secondRecovery = manager.deliver(makeRecord({ id: "after-permanent-2" }));

    firstToken.resolve("first-token");

    assert.isTrue(await firstRecovery);
    assert.isTrue(await secondRecovery);
    assert.strictEqual(persist.mock.calls.length, persistedBeforeRecovery);
    assert.deepEqual(send.mock.calls.map(([record]) => record.id).sort(), [
      "after-permanent-1",
      "after-permanent-2",
    ]);
  });

  it("abandons half-open live probes when token resolution returns null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { manager, persist, resolveToken, send } = createManager();

    send.mockResolvedValueOnce({
      kind: "retryable",
      correlationId: "seed",
      retryAfterMs: 60_000,
    });
    assert.isTrue(await manager.deliver(makeRecord({ id: "seed" })));

    await vi.advanceTimersByTimeAsync(60_000);

    resolveToken.mockReset();
    resolveToken.mockResolvedValueOnce(null).mockResolvedValueOnce("retry-token");
    send.mockReset();
    send.mockResolvedValueOnce({
      kind: "success",
      correlationId: "retry-token",
    });

    assert.isFalse(await manager.deliver(makeRecord({ id: "null-probe" })));

    const persistedBeforeRetry = persist.mock.calls.length;
    assert.isTrue(await manager.deliver(makeRecord({ id: "retry-after-null" })));

    assert.strictEqual(persist.mock.calls.length, persistedBeforeRetry);
    assert.strictEqual(send.mock.calls.length, 1);
    assert.strictEqual(send.mock.calls[0][0].id, "retry-after-null");
  });

  it("waits for active live work before forceFlush starts a replay pass", async () => {
    const { claimBatch, manager, send } = createManager();
    const sendDeferred = deferred<DeliveryAttempt>();
    send.mockReturnValueOnce(sendDeferred.promise);

    const delivery = manager.deliver(makeRecord({ id: "live-work" }));
    await settle();

    const forceFlush = manager.forceFlush();
    await settle();

    assert.strictEqual(claimBatch.mock.calls.length, 0);

    sendDeferred.resolve({ kind: "success", correlationId: "live-work" });

    assert.isTrue(await delivery);
    await forceFlush;
    assert.strictEqual(claimBatch.mock.calls.length, 1);
  });

  it("schedules the replay timer with unref", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const unref = vi.fn();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const timer = originalSetTimeout(
        handler as (...callbackArgs: unknown[]) => void,
        timeout,
        ...(args as []),
      );
      const originalUnref = timer.unref.bind(timer);
      timer.unref = vi.fn(() => {
        unref();
        return originalUnref();
      });
      return timer;
    }) as typeof setTimeout);

    const { manager } = createManager();

    assert.strictEqual(unref.mock.calls.length, 1);

    await manager.shutdown();
    setTimeoutSpy.mockRestore();
  });

  it("aborts in-flight sends during shutdown and persists the live record", async () => {
    const { manager, persist, send } = createManager();
    const aborted = deferred<void>();
    let capturedSignal: AbortSignal | undefined;

    send.mockImplementation(
      (_record, _token, signal) =>
        new Promise<DeliveryAttempt>((_resolve, reject) => {
          capturedSignal = signal;
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    const delivery = manager.deliver(makeRecord({ id: "abort-me" }));
    await settle();

    await manager.shutdown();
    await aborted.promise;

    assert.isDefined(capturedSignal);
    assert.isTrue(capturedSignal!.aborted);
    assert.isTrue(await delivery);
    assert.strictEqual(persist.mock.calls.length, 1);
  });

  it("rejects shutdown when aborted work never settles", async () => {
    const { manager, send } = createManager({
      options: {
        shutdownTimeoutMilliseconds: 5,
        tokenResolutionTimeoutMilliseconds: 50,
      },
    });
    let capturedSignal: AbortSignal | undefined;
    send.mockImplementation(
      (_record, _token, signal) =>
        new Promise<DeliveryAttempt>(() => {
          capturedSignal = signal;
        }),
    );

    void manager.deliver(makeRecord({ id: "hung-send" }));
    await settle();

    await expect(manager.shutdown()).rejects.toThrow(/shutdown timed out/);

    assert.isDefined(capturedSignal);
    assert.isTrue(capturedSignal!.aborted);
  });
});

function createManager(
  overrides: {
    options?: Partial<Agent365DurableDeliveryOptions>;
  } = {},
) {
  const logger = makeLogger();
  const persist = vi.fn(async (_record: DurableRecordV1) => "record.pending");
  const claimBatch = vi.fn(async (_limit: number) => [] as ClaimedRecord[]);
  const complete = vi.fn(async (_claim: ClaimedRecord) => undefined);
  const release = vi.fn(async (_claim: ClaimedRecord) => undefined);
  const resolveToken = vi.fn(async (_record: DurableRecordV1) => "token");
  const send = vi.fn(
    async (
      _record: DurableRecordV1,
      _token: string,
      _signal: AbortSignal,
    ): Promise<DeliveryAttempt> => ({
      kind: "success",
      correlationId: "success",
    }),
  );

  const manager = new DurableDeliveryManager(
    new ResolvedDurableDeliveryOptions({
      enabled: true,
      replayIntervalMilliseconds: 60_000,
      shutdownTimeoutMilliseconds: 25,
      tokenResolutionTimeoutMilliseconds: 25,
      ...overrides.options,
    }),
    { persist, claimBatch, complete, release } as unknown as PersistentStore,
    logger,
    { resolveToken, send },
  );
  managedInstances.push(manager);

  return {
    logger,
    manager,
    persist,
    claimBatch,
    complete,
    release,
    resolveToken,
    send,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies ILogger;
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

function makeClaim(record: DurableRecordV1): ClaimedRecord {
  return {
    record,
    leasePath: `${record.id}.lease`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
