// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ILogger } from "../../logging.js";
import { ResolvedDurableDeliveryOptions } from "./DurableDeliveryOptions.js";
import type { DurableRecordV1 } from "./DurableRecord.js";
import { PersistentStore, type ClaimedRecord } from "./PersistentStore.js";
import { TransmissionGate, type TransmissionPermit } from "./TransmissionGate.js";

export type DeliveryAttempt =
  | { kind: "success"; correlationId: string }
  | { kind: "retryable"; correlationId: string; status?: number; retryAfterMs?: number }
  | { kind: "permanent"; correlationId: string; status?: number; reason: string };

export interface DurableDeliveryDependencies {
  resolveToken(record: DurableRecordV1): Promise<string | null>;
  send(record: DurableRecordV1, token: string, signal: AbortSignal): Promise<DeliveryAttempt>;
}

type GateDecision =
  | { kind: "deferred" }
  | { kind: "abandoned" }
  | { kind: "success" }
  | { kind: "permanent" }
  | { kind: "retryable"; error?: unknown };

export class DurableDeliveryManager {
  private readonly gate = new TransmissionGate();
  private readonly abortController = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private replayTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private shutdownComplete = false;

  constructor(
    private readonly options: ResolvedDurableDeliveryOptions,
    private readonly store: PersistentStore,
    private readonly logger: ILogger,
    private readonly dependencies: DurableDeliveryDependencies,
  ) {
    this.scheduleReplay();
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

    await Promise.allSettled([...this.active]);
    if (this.closed) {
      return;
    }

    await this.runReplayPass();
  }

  public async shutdown(): Promise<void> {
    if (this.shutdownComplete) {
      return;
    }

    this.closed = true;
    if (this.replayTimer) {
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
    }
    this.abortController.abort();

    const completed = await Promise.race([
      Promise.allSettled([...this.active]).then(() => true),
      delay(this.options.shutdownTimeoutMilliseconds).then(() => false),
    ]);

    if (!completed) {
      throw new Error("Agent365 durable delivery shutdown timed out");
    }

    this.shutdownComplete = true;
  }

  private async deliverInternal(record: DurableRecordV1): Promise<boolean> {
    const decision = await this.attemptSend(record);
    if (decision.kind === "success") {
      return true;
    }
    if (decision.kind === "permanent" || decision.kind === "abandoned") {
      return false;
    }
    if (decision.kind === "retryable" && decision.error !== undefined) {
      this.logger.warn("[DurableDeliveryManager] Live delivery failed; persisting for replay", decision.error);
    }

    return this.persist(record);
  }

  private scheduleReplay(): void {
    if (this.closed || this.replayTimer) {
      return;
    }

    this.replayTimer = setTimeout(() => {
      this.replayTimer = undefined;
      void this.runReplayPass().finally(() => this.scheduleReplay());
    }, this.options.replayIntervalMilliseconds);
    this.replayTimer.unref();
  }

  private runReplayPass(): Promise<void> {
    return this.track(this.runReplayPassInternal());
  }

  private async runReplayPassInternal(): Promise<void> {
    let claims: ClaimedRecord[];
    try {
      claims = await this.store.claimBatch(this.options.maxReplayBatchSize);
    } catch (error) {
      this.logger.error("[DurableDeliveryManager] Failed to claim durable records", error);
      return;
    }

    for (const claim of claims) {
      await this.processClaim(claim);
    }
  }

  private async processClaim(claim: ClaimedRecord): Promise<void> {
    const decision = await this.attemptSend(claim.record);
    if (decision.kind === "success" || decision.kind === "permanent") {
      await this.completeClaim(claim);
      return;
    }
    if (decision.kind === "retryable" && decision.error !== undefined) {
      this.logger.warn("[DurableDeliveryManager] Replay failed; releasing durable record", decision.error);
    }

    await this.releaseClaim(claim);
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

  private async releaseClaim(claim: ClaimedRecord): Promise<void> {
    try {
      await this.store.release(claim);
    } catch (error) {
      this.logger.error("[DurableDeliveryManager] Failed to release durable record", error);
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

  private async attemptSend(record: DurableRecordV1): Promise<GateDecision> {
    const permit = this.gate.acquire();
    if (!permit) {
      return { kind: "deferred" };
    }

    try {
      const token = await this.withTimeout(
        this.dependencies.resolveToken(record),
        this.options.tokenResolutionTimeoutMilliseconds,
        "token resolution",
      );
      if (!token) {
        this.gate.abandon(permit);
        return { kind: "abandoned" };
      }

      const attempt = await this.dependencies.send(record, token, this.abortController.signal);
      return this.classifyAttempt(permit, attempt);
    } catch (error) {
      this.gate.recordRetryableFailure(permit);
      return { kind: "retryable", error };
    }
  }

  private classifyAttempt(permit: TransmissionPermit, attempt: DeliveryAttempt): GateDecision {
    if (attempt.kind === "success") {
      this.gate.recordSuccess(permit);
      return { kind: "success" };
    }
    if (attempt.kind === "permanent") {
      this.gate.recordSuccess(permit);
      return { kind: "permanent" };
    }

    this.gate.recordRetryableFailure(permit, attempt.retryAfterMs);
    return { kind: "retryable" };
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Agent365 durable delivery ${operationName} timed out`));
          }, timeoutMs);
          timeoutHandle.unref?.();
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
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
