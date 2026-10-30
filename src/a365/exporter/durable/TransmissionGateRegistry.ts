// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TransmissionGate } from "./TransmissionGate.js";

interface GateEntry {
  gate: TransmissionGate;
  activeLeases: number;
  lastAccess: number;
}

/** Shares backoff by tenant without evicting active sends or pending backoff. */
export class TransmissionGateRegistry {
  private readonly entries = new Map<string, GateEntry>();
  private readonly capacity: number;
  private readonly idleTimeoutMilliseconds: number;
  private readonly now: () => number;

  constructor(
    options: {
      capacity?: number;
      idleTimeoutMilliseconds?: number;
      now?: () => number;
    } = {},
  ) {
    this.capacity = options.capacity ?? 256;
    this.idleTimeoutMilliseconds = options.idleTimeoutMilliseconds ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new RangeError("Transmission gate registry capacity must be a positive integer");
    }
    if (!Number.isFinite(this.idleTimeoutMilliseconds) || this.idleTimeoutMilliseconds <= 0) {
      throw new RangeError("Transmission gate registry idle timeout must be positive");
    }
  }

  acquire(tenantId: string): { gate: TransmissionGate; release(): void } {
    if (!tenantId?.trim()) {
      throw new TypeError("Transmission gate registry requires a tenant identifier");
    }

    const now = this.now();
    this.trim(now);
    let entry = this.entries.get(tenantId);
    if (!entry) {
      entry = {
        gate: new TransmissionGate({ now: this.now }),
        activeLeases: 0,
        lastAccess: now,
      };
      this.entries.set(tenantId, entry);
    }
    const acquired = entry;
    acquired.activeLeases++;
    acquired.lastAccess = now;
    this.trim(now);
    let released = false;

    return {
      gate: acquired.gate,
      release: () => {
        if (released) return;
        released = true;
        acquired.activeLeases--;
        acquired.lastAccess = this.now();
        this.trim(acquired.lastAccess);
      },
    };
  }

  getDeferredTenantIds(): ReadonlySet<string> {
    const deferred = new Set<string>();
    for (const [tenantId, entry] of this.entries) {
      if (!entry.gate.canAcquire()) {
        deferred.add(tenantId);
      }
    }
    return deferred;
  }

  private trim(now: number): void {
    const inactive: [string, GateEntry][] = [];
    for (const [tenantId, entry] of this.entries) {
      if (entry.activeLeases > 0 || entry.gate.hasPendingBackoff) continue;
      if (now - entry.lastAccess >= this.idleTimeoutMilliseconds) {
        this.entries.delete(tenantId);
      } else {
        inactive.push([tenantId, entry]);
      }
    }

    inactive.sort(
      ([leftId, left], [rightId, right]) =>
        left.lastAccess - right.lastAccess || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
    );
    for (const [tenantId] of inactive) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(tenantId);
    }
  }
}
