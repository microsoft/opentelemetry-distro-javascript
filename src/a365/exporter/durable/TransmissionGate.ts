// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const MIN_FALLBACK_DELAY_MS = 10_000;
const MAX_FALLBACK_DELAY_MS = 60 * 60 * 1000;

export interface TransmissionPermit {
  readonly generation: number;
  readonly probe: boolean;
}

export class TransmissionGate {
  private generation = 0;
  private blockedUntil = 0;
  private probeInFlight = false;
  private consecutiveFailures = 0;

  constructor(
    private readonly options: {
      now?: () => number;
      random?: () => number;
    } = {},
  ) {}

  acquire(): TransmissionPermit | undefined {
    const currentTime = this.now();
    if (currentTime < this.blockedUntil) return undefined;
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

  abandon(permit: TransmissionPermit): void {
    if (permit.generation !== this.generation || !permit.probe) return;
    this.probeInFlight = false;
  }

  recordRetryableFailure(permit: TransmissionPermit, retryAfterMs?: number): void {
    if (permit.generation !== this.generation) return;

    this.generation++;
    this.probeInFlight = false;
    this.consecutiveFailures++;

    const currentTime = this.now();
    const fallback = this.computeFallbackDelay();
    const delayMs = Math.max(retryAfterMs ?? 0, fallback);
    this.blockedUntil = currentTime + delayMs;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private random(): number {
    return this.options.random?.() ?? Math.random();
  }

  private computeFallbackDelay(): number {
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    const exponential = MIN_FALLBACK_DELAY_MS * 2 ** Math.min(exponent, 30);
    const jittered = Math.floor(exponential * (0.8 + this.random() * 0.4));
    return Math.max(MIN_FALLBACK_DELAY_MS, Math.min(MAX_FALLBACK_DELAY_MS, jittered));
  }
}

export function parseRetryAfterMs(headers: Pick<Headers, "get">): number | null {
  const value = headers.get("retry-after") ?? headers.get("Retry-After");
  if (value == null) return null;

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}
