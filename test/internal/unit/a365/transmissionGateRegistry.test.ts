// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { TransmissionGateRegistry } from "../../../../src/a365/exporter/durable/TransmissionGateRegistry.js";

describe("TransmissionGateRegistry", () => {
  it("shares a tenant gate across concurrent leases but not across tenants", () => {
    const registry = new TransmissionGateRegistry();
    const first = registry.acquire("a");
    const second = registry.acquire("a");
    const other = registry.acquire("b");
    first.gate.recordRetryableFailure(first.gate.acquire()!, 60_000);

    expect(second.gate.canAcquire()).toBe(false);
    expect(other.gate.canAcquire()).toBe(true);
    first.release();
    second.release();
    other.release();
  });

  it("does not evict an active tenant under capacity pressure", () => {
    const registry = new TransmissionGateRegistry({ capacity: 1 });
    const first = registry.acquire("a");
    const second = registry.acquire("b");
    const again = registry.acquire("a");

    expect(again.gate).toBe(first.gate);
    again.release();
    second.release();
    const replacement = registry.acquire("b");
    expect(replacement.gate).not.toBe(second.gate);
    replacement.release();
    first.release();
  });

  it("preserves pending backoff under capacity and idle pressure", () => {
    let now = 0;
    const registry = new TransmissionGateRegistry({
      capacity: 1,
      idleTimeoutMilliseconds: 10,
      now: () => now,
    });
    const blocked = registry.acquire("a");
    blocked.gate.recordRetryableFailure(blocked.gate.acquire()!, 60_000);
    blocked.release();
    now = 20;
    const other = registry.acquire("b");
    other.release();
    const again = registry.acquire("a");

    expect(again.gate).toBe(blocked.gate);
    expect(again.gate.canAcquire()).toBe(false);
    again.release();

    now = 60_000;
    const expired = registry.acquire("a");
    expect(expired.gate).not.toBe(blocked.gate);
    expired.release();
  });

  it("evicts least recently used inactive gates and tolerates repeated release", () => {
    let now = 0;
    const registry = new TransmissionGateRegistry({ capacity: 2, now: () => now });
    const oldest = registry.acquire("a");
    oldest.release();
    now++;
    const recent = registry.acquire("b");
    recent.release();
    now++;
    const third = registry.acquire("c");
    third.release();
    oldest.release();
    const retained = registry.acquire("b");
    expect(retained.gate).toBe(recent.gate);
    retained.release();
    const evicted = registry.acquire("a");
    expect(evicted.gate).not.toBe(oldest.gate);
    evicted.release();
  });

  it("removes idle gates without waiting for capacity pressure", () => {
    let now = 0;
    const registry = new TransmissionGateRegistry({
      idleTimeoutMilliseconds: 10,
      now: () => now,
    });
    const first = registry.acquire("a");
    first.release();
    now = 10;
    const again = registry.acquire("a");
    expect(again.gate).not.toBe(first.gate);
    again.release();
  });

  it("rejects invalid limits and empty tenant identifiers", () => {
    expect(() => new TransmissionGateRegistry({ capacity: 0 })).toThrow(RangeError);
    expect(() => new TransmissionGateRegistry({ capacity: 1.5 })).toThrow(RangeError);
    expect(() => new TransmissionGateRegistry({ idleTimeoutMilliseconds: 0 })).toThrow(RangeError);
    expect(() => new TransmissionGateRegistry().acquire(" ")).toThrow(TypeError);
  });
});
