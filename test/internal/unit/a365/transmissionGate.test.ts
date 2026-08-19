// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, describe, it, vi } from "vitest";
import {
  TransmissionGate,
  parseRetryAfterMs,
} from "../../../../src/a365/exporter/durable/index.js";

describe("TransmissionGate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows one half-open probe", () => {
    let now = 0;
    const gate = new TransmissionGate({ now: () => now, random: () => 0 });

    const first = gate.acquire();
    assert.isDefined(first);

    gate.recordRetryableFailure(first!, 10_000);

    assert.isUndefined(gate.acquire());

    now += 10_000;

    const probe = gate.acquire();
    assert.isDefined(probe);
    assert.isTrue(probe!.probe);
    assert.isUndefined(gate.acquire());
  });

  it("does not let a stale success erase newer backoff", () => {
    const gate = new TransmissionGate({ now: () => 0, random: () => 0 });

    const oldPermit = gate.acquire();
    const concurrentPermit = gate.acquire();

    assert.isDefined(oldPermit);
    assert.isDefined(concurrentPermit);

    gate.recordRetryableFailure(concurrentPermit!, 60_000);
    gate.recordSuccess(oldPermit!);

    assert.isUndefined(gate.acquire());
  });

  it("parses Retry-After delay-seconds", () => {
    assert.strictEqual(parseRetryAfterMs(makeHeaders("5")), 5_000);
  });

  it("parses Retry-After HTTP-date", () => {
    const fakeNow = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(fakeNow);

    assert.strictEqual(
      parseRetryAfterMs(makeHeaders(new Date(fakeNow + 8_000).toUTCString())),
      8_000,
    );
  });

  it("uses a 10-second minimum fallback delay", () => {
    let now = 0;
    const gate = new TransmissionGate({ now: () => now, random: () => 0 });

    const permit = gate.acquire();
    assert.isDefined(permit);

    gate.recordRetryableFailure(permit!, undefined);

    assert.isUndefined(gate.acquire());

    now = 9_999;
    assert.isUndefined(gate.acquire());

    now = 10_000;
    assert.isDefined(gate.acquire());
  });

  it("honors a positive Retry-After shorter than the fallback", () => {
    let now = 0;
    const gate = new TransmissionGate({ now: () => now, random: () => 0 });
    const permit = gate.acquire();

    assert.isDefined(permit);

    gate.recordRetryableFailure(permit!, 1_000);

    now = 999;
    assert.isUndefined(gate.acquire());

    now = 1_000;
    assert.isDefined(gate.acquire());
  });

  it("always uses the injected clock when acquiring", () => {
    let now = 0;
    const gate = new TransmissionGate({ now: () => now, random: () => 0 });

    const permit = gate.acquire();
    assert.isDefined(permit);

    gate.recordRetryableFailure(permit!, undefined);

    now = 5_000;

    assert.isUndefined(gate.acquire(20_000));
  });

  it("increases fallback delay on repeated failures", () => {
    let now = 0;
    const gate = new TransmissionGate({ now: () => now, random: () => 0 });

    const first = gate.acquire();
    assert.isDefined(first);
    gate.recordRetryableFailure(first!, undefined);

    now = 10_000;
    const probe = gate.acquire();
    assert.isDefined(probe);

    gate.recordRetryableFailure(probe!, undefined);

    now = 25_999;
    assert.isUndefined(gate.acquire());

    now = 26_000;
    assert.isDefined(gate.acquire());
  });

  it("caps fallback delay at one hour", () => {
    let now = 0;
    const gate = new TransmissionGate({ now: () => now, random: () => 1 });

    let permit = gate.acquire();
    assert.isDefined(permit);

    for (let i = 0; i < 9; i++) {
      gate.recordRetryableFailure(permit!, undefined);
      now += expectedDelayForAttempt(i);
      permit = gate.acquire();
      assert.isDefined(permit);
    }

    gate.recordRetryableFailure(permit!, undefined);

    now += 3_599_999;
    assert.isUndefined(gate.acquire());

    now += 1;
    assert.isDefined(gate.acquire());
  });

  it("caps a huge Retry-After delay-seconds value at one hour", () => {
    let now = 0;
    const gate = new TransmissionGate({ now: () => now, random: () => 0 });
    const permit = gate.acquire();
    assert.isDefined(permit);

    const retryAfterMs = parseRetryAfterMs(makeHeaders("999999999999999999"));
    assert.isNotNull(retryAfterMs);
    gate.recordRetryableFailure(permit!, retryAfterMs!);

    now = 3_599_999;
    assert.isUndefined(gate.acquire());

    now = 3_600_000;
    assert.isDefined(gate.acquire());
  });

  it("caps a future Retry-After HTTP-date at one hour", () => {
    const fakeNow = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(fakeNow);
    let now = fakeNow;
    const gate = new TransmissionGate({ now: () => now, random: () => 0 });
    const permit = gate.acquire();
    assert.isDefined(permit);

    const retryAfterMs = parseRetryAfterMs(
      makeHeaders(new Date(fakeNow + 4 * 3_600_000).toUTCString()),
    );
    assert.isNotNull(retryAfterMs);
    gate.recordRetryableFailure(permit!, retryAfterMs!);

    now += 3_599_999;
    assert.isUndefined(gate.acquire());

    now += 1;
    assert.isDefined(gate.acquire());
  });

  it("resets after a current-generation success", () => {
    let now = 0;
    const gate = new TransmissionGate({ now: () => now, random: () => 0 });

    const permit = gate.acquire();
    assert.isDefined(permit);

    gate.recordRetryableFailure(permit!, undefined);

    now = 10_000;
    const probe = gate.acquire();
    assert.isDefined(probe);

    gate.recordSuccess(probe!);

    assert.isDefined(gate.acquire());
    assert.isFalse(gate.acquire()!.probe);
  });
});

function makeHeaders(value: string): Pick<Headers, "get"> {
  return {
    get(name: string): string | null {
      return name.toLowerCase() === "retry-after" ? value : null;
    },
  };
}

function expectedDelayForAttempt(attempt: number): number {
  const fallback = Math.min(3_600_000, 10_000 * 2 ** attempt);
  return Math.floor(fallback * 1.2);
}
