// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ILogger } from "../../logging.js";
import { ResolvedDurableDeliveryOptions } from "./DurableDeliveryOptions.js";
import type { DurableRecordV1 } from "./DurableRecord.js";
import { PersistentStore, type ClaimedRecord } from "./PersistentStore.js";
import { TransmissionGate } from "./TransmissionGate.js";

export type DeliveryAttempt =
  | { kind: "success"; correlationId: string }
  | { kind: "retryable"; correlationId: string; status?: number; retryAfterMs?: number }
  | { kind: "permanent"; correlationId: string; status?: number; reason: string };

export interface DurableDeliveryDependencies {
  resolveToken(record: DurableRecordV1): Promise<string | null>;
  send(record: DurableRecordV1, token: string, signal: AbortSignal): Promise<DeliveryAttempt>;
}

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
    const permit = this.gate.acquire();
    if (!permit) {
      return this.persist(record);
    }

    try {
      const token = await this.withTimeout(
        this.dependencies.resolveToken(record),
        this.options.tokenResolutionTimeoutMilliseconds,
        "token resolution",
      );
      if (!token) {
        return false;
      }

      const attempt = await this.dependencies.send(record, token, this.abortController.signal);
      if (attempt.kind === "success") {
        this.gate.recordSuccess(permit);
        return true;
      }
      if (attempt.kind === "permanent") {
        return false;
      }

      this.gate.recordRetryableFailure(permit, attempt.retryAfterMs);
      return this.persist(record);
    } catch (error) {
      this.gate.recordRetryableFailure(permit);
      this.logger.warn("[DurableDeliveryManager] Live delivery failed; persisting for replay", error);
      return this.persist(record);
    }
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
    try {
      const token = await this.withTimeout(
        this.dependencies.resolveToken(claim.record),
        this.options.tokenResolutionTimeoutMilliseconds,
        "token resolution",
      );

      if (!token) {
        await this.releaseClaim(claim);
        return;
      }

      const attempt = await this.dependencies.send(claim.record, token, this.abortController.signal);
      if (attempt.kind === "success" || attempt.kind === "permanent") {
        await this.completeClaim(claim);
        return;
      }

      await this.releaseClaim(claim);
    } catch (error) {
      this.logger.warn("[DurableDeliveryManager] Replay failed; releasing durable record", error);
      await this.releaseClaim(claim);
    }
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
