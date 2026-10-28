// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { setMaxListeners } from "node:events";
import type { ILogger } from "../../logging.js";
import { ResolvedDurableDeliveryOptions } from "./DurableDeliveryOptions.js";
import type { DurableRecordV1 } from "./DurableRecord.js";
import { PersistentStore, type ClaimedRecord } from "./PersistentStore.js";
import type { TransmissionGate, TransmissionPermit } from "./TransmissionGate.js";
import { TransmissionGateRegistry } from "./TransmissionGateRegistry.js";

export type DeliveryAttempt =
  | { kind: "success"; correlationId: string }
  | { kind: "retryable"; correlationId: string; status?: number; retryAfterMs?: number }
  | { kind: "permanent"; correlationId: string; status?: number; reason: string };

export interface DurableDeliveryDependencies {
  validateReplay?(record: DurableRecordV1): Promise<void> | void;
  resolveToken(record: DurableRecordV1): Promise<string | null>;
  send(record: DurableRecordV1, token: string, signal: AbortSignal): Promise<DeliveryAttempt>;
}

type GateDecision =
  | { kind: "deferred" }
  | { kind: "endpointInvalid"; error: Error }
  | { kind: "tokenUnavailable"; error?: unknown }
  | { kind: "success" }
  | { kind: "permanent" }
  | { kind: "retryable"; error?: unknown };

/**
 * Outcome of processing one claimed replay record:
 * - "advance": completed (success/permanent); safe to claim the next record.
 * - "exclude": token unavailable or retryable response; count the attempt but
 *   skip this released record on later claims in the same pass.
 * - "deferred": tenant gate is backed off; skip without spending an attempt.
 * - "stop": unknown fault or global misconfiguration; stop this replay pass.
 */
type ReplayClaimOutcome = "advance" | "exclude" | "deferred" | "stop";

export class DurableDeliveryManager {
  private readonly gates = new TransmissionGateRegistry();
  private readonly abortController = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private replayTimer?: ReturnType<typeof setTimeout>;
  private replayQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private replayStopped = false;
  private shutdownComplete = false;
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly options: ResolvedDurableDeliveryOptions,
    private readonly store: PersistentStore,
    private readonly logger: ILogger,
    private readonly dependencies: DurableDeliveryDependencies,
  ) {
    setMaxListeners(0, this.abortController.signal);
    this.scheduleReplay();
  }

  /**
   * Starts a replay pass immediately. The regular replay timer remains active
   * for subsequent passes.
   */
  public startReplay(): void {
    if (this.closed || this.replayStopped) {
      return;
    }

    void this.runReplayPass().then(
      () => undefined,
      (error) => this.logger.error("[DurableDeliveryManager] Initial replay failed", error),
    );
  }

  public deliver(record: DurableRecordV1): Promise<boolean> {
    if (this.closed) {
      return Promise.resolve(false);
    }
    return this.track(this.deliverInternal(record));
  }

  public async forceFlush(): Promise<void> {
    if (this.closed) {
      return;
    }

    await this.waitForActiveWorkToStability();
    if (this.closed) {
      return;
    }

    await this.runReplayPass();
  }

  /**
   * Stops new replay work and aborts active network requests without rejecting
   * already-admitted durable records. Callers can then wait for those records
   * to finish their durable handoff before invoking {@link shutdown}.
   */
  public beginShutdown(): void {
    this.replayStopped = true;
    if (this.replayTimer) {
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
    }
    this.abortController.abort();
  }

  public shutdown(): Promise<void> {
    if (this.shutdownComplete) {
      return Promise.resolve();
    }

    this.shutdownPromise ??= this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    this.closed = true;
    this.beginShutdown();

    if (!(await this.waitForActiveWork(this.options.shutdownTimeoutMilliseconds))) {
      throw new Error("Agent365 durable delivery shutdown timed out");
    }

    this.shutdownComplete = true;
  }

  private async deliverInternal(record: DurableRecordV1): Promise<boolean> {
    const decision = await this.attemptSend(record, "live");
    if (decision.kind === "success") {
      return true;
    }
    if (decision.kind === "permanent") {
      return false;
    }
    if (decision.kind === "tokenUnavailable") {
      if (decision.error !== undefined) {
        this.logger.warn(
          "[DurableDeliveryManager] Live token resolution failed; persisting durable record for replay",
          decision.error,
        );
      }

      return this.persist(record);
    }
    if (decision.kind === "retryable" && decision.error !== undefined) {
      this.logger.warn(
        "[DurableDeliveryManager] Live delivery failed; persisting for replay",
        decision.error,
      );
    }

    return this.persist(record);
  }

  private scheduleReplay(): void {
    if (this.closed || this.replayStopped || this.replayTimer) {
      return;
    }

    this.replayTimer = setTimeout(() => {
      this.replayTimer = undefined;
      void this.runReplayPass().then(
        () => this.scheduleReplay(),
        (error) => {
          this.logger.error("[DurableDeliveryManager] Scheduled replay failed", error);
          this.scheduleReplay();
        },
      );
    }, this.options.replayIntervalMilliseconds);
    this.replayTimer.unref();
  }

  private runReplayPass(): Promise<void> {
    const replayPass = this.replayQueue.then(async () => {
      if (this.closed || this.replayStopped) {
        return;
      }
      await this.runReplayPassInternal();
    });
    this.replayQueue = replayPass.catch(() => undefined);
    return this.track(replayPass);
  }

  private async runReplayPassInternal(): Promise<void> {
    const skippedRecordIds = new Set<string>();
    const scanBudget = Math.min(Number.MAX_SAFE_INTEGER, this.options.maxReplayBatchSize * 10);
    let attempted = 0;

    for (
      let scanned = 0;
      attempted < this.options.maxReplayBatchSize && scanned < scanBudget;
      scanned++
    ) {
      if (this.closed || this.replayStopped) {
        return;
      }

      let claim: ClaimedRecord | undefined;
      try {
        [claim] = await this.store.claimBatch(1, { excludeRecordIds: skippedRecordIds });
      } catch (error) {
        this.logger.error("[DurableDeliveryManager] Failed to claim durable records", error);
        return;
      }

      if (!claim) {
        return;
      }

      const outcome = await this.processClaim(claim);
      if (outcome === "stop") {
        return;
      }
      if (outcome !== "deferred") {
        attempted++;
      }
      if (outcome === "exclude" || outcome === "deferred") {
        skippedRecordIds.add(claim.record.id);
      }
    }
  }

  private async processClaim(claim: ClaimedRecord): Promise<ReplayClaimOutcome> {
    const decision = await this.attemptSend(claim.record, "replay");
    if (decision.kind === "success" || decision.kind === "permanent") {
      await this.completeClaim(claim);
      return "advance";
    }
    if (decision.kind === "endpointInvalid") {
      this.logger.warn(
        `[DurableDeliveryManager] Replay endpoint validation failed; releasing durable record: ${decision.error.message}`,
        decision.error,
      );
      await this.releaseClaim(claim);
      return "stop";
    }
    if (decision.kind === "tokenUnavailable") {
      if (decision.error !== undefined) {
        this.logger.warn(
          "[DurableDeliveryManager] Replay token resolution failed; releasing durable record",
          decision.error,
        );
      }

      if (!(await this.releaseClaim(claim))) {
        return "stop";
      }
      // Exclude this record from later claims in the same pass instead of
      // stopping outright, so unrelated records that sort after it are not
      // starved by repeatedly reclaiming the same released record.
      return "exclude";
    }
    if (decision.kind === "retryable" && decision.error !== undefined) {
      this.logger.warn(
        "[DurableDeliveryManager] Replay failed; releasing durable record",
        decision.error,
      );
    }

    if (!(await this.releaseClaim(claim))) {
      return "stop";
    }
    if (decision.kind === "deferred") {
      return "deferred";
    }
    return decision.kind === "retryable" && decision.error === undefined ? "exclude" : "stop";
  }

  private async persist(record: DurableRecordV1): Promise<boolean> {
    try {
      await this.store.persist(record);
      return true;
    } catch (error) {
      this.logger.error("[DurableDeliveryManager] Failed to persist durable record", error);
      return false;
    }
  }

  private async releaseClaim(claim: ClaimedRecord): Promise<boolean> {
    try {
      await this.store.release(claim);
      return true;
    } catch (error) {
      this.logger.error("[DurableDeliveryManager] Failed to release durable record", error);
      return false;
    }
  }

  private async completeClaim(claim: ClaimedRecord): Promise<void> {
    try {
      await this.store.complete(claim);
    } catch (error) {
      this.logger.error("[DurableDeliveryManager] Failed to complete durable record", error);
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      this.active.delete(tracked);
    });
    this.active.add(tracked);
    return tracked;
  }

  private async waitForActiveWork(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (this.active.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return false;
      }

      const settled = await Promise.race([
        Promise.allSettled([...this.active]).then(() => true),
        delay(remainingMs).then(() => false),
      ]);
      if (!settled) {
        return false;
      }
    }

    return true;
  }

  private async waitForActiveWorkToStability(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }

  private async attemptSend(
    record: DurableRecordV1,
    mode: "live" | "replay",
  ): Promise<GateDecision> {
    const lease = this.gates.acquire(record.tenantId);
    const gate = lease.gate;
    try {
      if (!gate.canAcquire()) {
        return { kind: "deferred" };
      }

      if (mode === "replay") {
        const decision = await this.validateReplay(record);
        if (decision) {
          return decision;
        }
      }

      let token: string | null;
      try {
        token = await this.withTimeout(
          this.dependencies.resolveToken(record),
          this.options.tokenResolutionTimeoutMilliseconds,
          "token resolution",
        );
      } catch (error) {
        return { kind: "tokenUnavailable", error };
      }

      if (!token) {
        return { kind: "tokenUnavailable" };
      }

      const permit = gate.acquire();
      if (!permit) {
        return { kind: "deferred" };
      }

      try {
        const attempt = await this.dependencies.send(record, token, this.abortController.signal);
        return this.classifyAttempt(gate, permit, attempt);
      } catch (error) {
        gate.recordRetryableFailure(permit);
        return { kind: "retryable", error };
      }
    } finally {
      lease.release();
    }
  }

  private classifyAttempt(
    gate: TransmissionGate,
    permit: TransmissionPermit,
    attempt: DeliveryAttempt,
  ): GateDecision {
    if (attempt.kind === "success") {
      gate.recordSuccess(permit);
      return { kind: "success" };
    }
    if (attempt.kind === "permanent") {
      gate.recordSuccess(permit);
      return { kind: "permanent" };
    }

    gate.recordRetryableFailure(permit, attempt.retryAfterMs);
    return { kind: "retryable" };
  }

  private async validateReplay(record: DurableRecordV1): Promise<GateDecision | undefined> {
    if (!this.dependencies.validateReplay) {
      return undefined;
    }

    try {
      await this.dependencies.validateReplay(record);
      return undefined;
    } catch (error) {
      if (isEndpointValidationError(error, "ReplayEndpointError")) {
        return { kind: "endpointInvalid", error };
      }
      return { kind: "retryable", error };
    }
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    operationName: string,
  ): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const signal = this.abortController.signal;

    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Agent365 durable delivery ${operationName} timed out`));
          }, timeoutMs);
          timeoutHandle.unref?.();
        }),
        new Promise<T>((_resolve, reject) => {
          // Abort a hung wait promptly on shutdown, even when timeoutMs
          // exceeds the shutdown deadline; always remove the listener so
          // repeated calls do not accumulate listeners on the shared signal.
          const rejectAborted = () =>
            reject(new Error(`Agent365 durable delivery ${operationName} aborted`));
          if (signal.aborted) {
            rejectAborted();
            return;
          }
          onAbort = rejectAborted;
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isEndpointValidationError(error: unknown, name: string): error is Error {
  return error instanceof Error
    ? error.name === name
    : typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: unknown }).name === name;
}
