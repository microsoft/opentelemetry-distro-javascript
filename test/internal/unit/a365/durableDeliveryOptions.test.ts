// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert, describe, it } from "vitest";
import {
  DEFAULT_DURABLE_STORAGE_BYTES,
  ResolvedDurableDeliveryOptions,
} from "../../../../src/a365/exporter/durable/index.js";

describe("ResolvedDurableDeliveryOptions", () => {
  it("is enabled by default and applies bounded defaults", () => {
    const options = new ResolvedDurableDeliveryOptions();

    assert.isTrue(options.enabled);
    assert.strictEqual(options.maxStorageBytes, DEFAULT_DURABLE_STORAGE_BYTES);
    assert.strictEqual(options.maxRecordAgeMilliseconds, 2 * 24 * 60 * 60 * 1000);
    assert.strictEqual(options.replayIntervalMilliseconds, 2 * 60 * 1000);
    assert.strictEqual(options.maxReplayBatchSize, 10);
    assert.strictEqual(options.leaseDurationMilliseconds, 2 * 60 * 1000);
    assert.strictEqual(options.shutdownTimeoutMilliseconds, 10_000);
    assert.strictEqual(options.tokenResolutionTimeoutMilliseconds, 30_000);
  });

  it("supports explicit disable", () => {
    assert.isFalse(new ResolvedDurableDeliveryOptions({ enabled: false }).enabled);
  });

  it("rejects non-positive limits", () => {
    assert.throws(
      () => new ResolvedDurableDeliveryOptions({ enabled: true, maxStorageBytes: 0 }),
      /maxStorageBytes must be greater than 0/,
    );
  });
});
