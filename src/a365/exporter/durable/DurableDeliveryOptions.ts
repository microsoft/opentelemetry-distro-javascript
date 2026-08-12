// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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
  public readonly enabled: boolean;
  public readonly storageDirectory?: string;
  public readonly maxStorageBytes: number;
  public readonly maxRecordAgeMilliseconds: number;
  public readonly replayIntervalMilliseconds: number;
  public readonly maxReplayBatchSize: number;
  public readonly leaseDurationMilliseconds: number;
  public readonly shutdownTimeoutMilliseconds: number;
  public readonly tokenResolutionTimeoutMilliseconds: number;

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
