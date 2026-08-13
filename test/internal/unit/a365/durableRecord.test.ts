// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, describe, it, vi } from "vitest";
import {
  DURABLE_RECORD_VERSION,
  createDurableRecord,
  parseDurableRecord,
} from "../../../../src/a365/exporter/durable/index.js";

describe("DurableRecord", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips a v1 record without credentials", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_725_000_000_000);

    const record = createDurableRecord({
      tenantId: "tenant",
      agentId: "agent",
      agenticUserId: "user",
      clusterCategory: "prod",
      useS2SEndpoint: false,
      body: '{"resourceSpans":[]}',
    });

    assert.strictEqual(record.version, DURABLE_RECORD_VERSION);
    assert.strictEqual(record.createdAt, 1_725_000_000_000);
    assert.match(record.id, /^[0-9a-f-]{36}$/i);

    const parsed = parseDurableRecord(JSON.stringify(record));
    assert.deepEqual(parsed, record);
    assert.notInclude(JSON.stringify(record), "Bearer");
  });

  it("rejects unsupported versions", () => {
    assert.throws(() => parseDurableRecord('{"version":2}'), /Unsupported durable record version/);
  });

  it("rejects invalid record shapes", () => {
    assert.throws(
      () =>
        parseDurableRecord(
          JSON.stringify({
            version: DURABLE_RECORD_VERSION,
            id: "record-id",
            createdAt: Date.now(),
            tenantId: "tenant",
            agentId: "agent",
            clusterCategory: "prod",
            useS2SEndpoint: "false",
            body: '{"resourceSpans":[]}',
          }),
        ),
      /Invalid durable record/,
    );
  });
});
