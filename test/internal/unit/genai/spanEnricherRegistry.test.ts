// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, describe, it } from "vitest";
import {
  registerSpanEnricher,
  getRegisteredSpanEnrichers,
  type SpanEnricher,
} from "../../../../src/genai/spanEnricherRegistry.js";

// Track everything we register so we can guarantee an empty registry between
// tests without needing a test-only reset helper in the source module.
const cleanups: Array<() => void> = [];
function track<T extends () => void>(unregister: T): T {
  cleanups.push(unregister);
  return unregister;
}

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      fn?.();
    } catch {
      // Ignore — best-effort cleanup.
    }
  }
});

describe("spanEnricherRegistry", () => {
  it("registers an enricher and returns a working unregister thunk", () => {
    const fn: SpanEnricher = () => undefined;
    const unregister = track(registerSpanEnricher(fn));
    assert.ok(getRegisteredSpanEnrichers().includes(fn));

    unregister();
    assert.ok(!getRegisteredSpanEnrichers().includes(fn));
  });

  it("is idempotent for the same function reference (single active entry, reference-counted)", () => {
    const fn: SpanEnricher = () => undefined;
    track(registerSpanEnricher(fn));
    track(registerSpanEnricher(fn));
    track(registerSpanEnricher(fn));
    const occurrences = getRegisteredSpanEnrichers().filter((e) => e === fn).length;
    assert.strictEqual(occurrences, 1);
  });

  it("treats distinct function references as distinct enrichers", () => {
    const fn1: SpanEnricher = () => undefined;
    const fn2: SpanEnricher = () => undefined;
    track(registerSpanEnricher(fn1));
    track(registerSpanEnricher(fn2));
    const registered = getRegisteredSpanEnrichers();
    assert.ok(registered.includes(fn1));
    assert.ok(registered.includes(fn2));
  });

  it("unregister thunk is a no-op when called twice", () => {
    const fn: SpanEnricher = () => undefined;
    const unregister = registerSpanEnricher(fn);
    unregister();
    unregister();
    assert.ok(!getRegisteredSpanEnrichers().includes(fn));
  });

  it("reference-counted: same enricher registered N times stays active until N unregisters run", () => {
    const fn: SpanEnricher = () => undefined;
    const u1 = registerSpanEnricher(fn);
    const u2 = registerSpanEnricher(fn);
    const u3 = registerSpanEnricher(fn);

    assert.ok(getRegisteredSpanEnrichers().includes(fn));
    u1();
    assert.ok(
      getRegisteredSpanEnrichers().includes(fn),
      "still active after one unregister of three",
    );
    u2();
    assert.ok(
      getRegisteredSpanEnrichers().includes(fn),
      "still active after two unregisters of three",
    );
    u3();
    assert.ok(!getRegisteredSpanEnrichers().includes(fn), "removed only when the last owner ends");

    // Each thunk is independently idempotent.
    u1();
    u2();
    u3();
    assert.ok(!getRegisteredSpanEnrichers().includes(fn));
  });

  it("re-registering after removal restores the enricher", () => {
    const fn: SpanEnricher = () => undefined;
    const u1 = registerSpanEnricher(fn);
    u1();
    assert.ok(!getRegisteredSpanEnrichers().includes(fn));

    const u2 = track(registerSpanEnricher(fn));
    assert.ok(getRegisteredSpanEnrichers().includes(fn));
    u2();
    assert.ok(!getRegisteredSpanEnrichers().includes(fn));
  });

  it("unregister thunk only removes its own enricher, not others", () => {
    const fn1: SpanEnricher = () => undefined;
    const fn2: SpanEnricher = () => undefined;
    const unregister1 = registerSpanEnricher(fn1);
    track(registerSpanEnricher(fn2));

    unregister1();

    const registered = getRegisteredSpanEnrichers();
    assert.ok(!registered.includes(fn1));
    assert.ok(registered.includes(fn2));
  });
});
