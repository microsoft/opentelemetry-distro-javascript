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
      await managedInstances.pop()!.shutdown().catch(() => undefined);
    }
    vi.restoreAllMocks();
  });

  it.each([408, 429, 500, 503])("persists retryable live attempts for status %s", async (status) => {
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
  });

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
      .mockResolvedValueOnce({
        kind: "retryable",
        correlationId: "live-retryable",
        retryAfterMs: 60_000,
      })
      .mockResolvedValueOnce({ kind: "success", correlationId: "replayed" });
    claimBatch.mockResolvedValueOnce([claim]);

    assert.isTrue(await manager.deliver(record));

    await manager.forceFlush();

    assert.strictEqual(resolveToken.mock.calls.length, 2);
    assert.strictEqual(send.mock.calls.length, 2);
    assert.strictEqual(send.mock.calls[1][1], "fresh-token");
    assert.deepEqual(complete.mock.calls.map(([releasedClaim]) => releasedClaim), [claim]);
    assert.strictEqual(release.mock.calls.length, 0);
  });

  it("releases retryable, missing-token, timed-out, and unknown replay claims while completing permanent ones", async () => {
    const { claimBatch, complete, manager, release, resolveToken, send } = createManager({
      options: { tokenResolutionTimeoutMilliseconds: 5 },
    });
    const retryable = makeClaim(makeRecord({ id: "retryable-claim" }));
    const missingToken = makeClaim(makeRecord({ id: "missing-token-claim" }));
    const timedOut = makeClaim(makeRecord({ id: "timed-out-claim" }));
    const unknown = makeClaim(makeRecord({ id: "unknown-claim" }));
    const permanent = makeClaim(makeRecord({ id: "permanent-claim" }));

    claimBatch.mockResolvedValueOnce([retryable, missingToken, timedOut, unknown, permanent]);
    resolveToken.mockImplementation(async (record) => {
      switch (record.id) {
        case "retryable-claim":
          return "retryable-token";
        case "missing-token-claim":
          return null;
        case "timed-out-claim":
          return new Promise<string | null>(() => undefined);
        case "unknown-claim":
          return "unknown-token";
        case "permanent-claim":
          return "permanent-token";
        default:
          return "default-token";
      }
    });
    send.mockImplementation(async (record) => {
      switch (record.id) {
        case "retryable-claim":
          return { kind: "retryable", correlationId: "retryable" };
        case "unknown-claim":
          throw new Error("boom");
        case "permanent-claim":
          return {
            kind: "permanent",
            correlationId: "permanent",
            status: 400,
            reason: "bad request",
          };
        default:
          return { kind: "success", correlationId: "success" };
      }
    });

    await manager.forceFlush();

    const releasedIds = release.mock.calls.map(([claim]) => claim.record.id).sort();
    const completedIds = complete.mock.calls.map(([claim]) => claim.record.id).sort();

    assert.deepEqual(releasedIds, [
      "missing-token-claim",
      "retryable-claim",
      "timed-out-claim",
      "unknown-claim",
    ]);
    assert.deepEqual(completedIds, ["permanent-claim"]);
    assert.isFalse(send.mock.calls.some(([record]) => record.id === "missing-token-claim"));
    assert.isFalse(send.mock.calls.some(([record]) => record.id === "timed-out-claim"));
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

    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
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

function createManager(overrides: {
  options?: Partial<Agent365DurableDeliveryOptions>;
} = {}) {
  const logger = makeLogger();
  const persist = vi.fn(async (_record: DurableRecordV1) => "record.pending");
  const claimBatch = vi.fn(async (_limit: number) => [] as ClaimedRecord[]);
  const complete = vi.fn(async (_claim: ClaimedRecord) => undefined);
  const release = vi.fn(async (_claim: ClaimedRecord) => undefined);
  const resolveToken = vi.fn(async (_record: DurableRecordV1) => "token");
  const send = vi.fn(
    async (_record: DurableRecordV1, _token: string, _signal: AbortSignal): Promise<DeliveryAttempt> => ({
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
