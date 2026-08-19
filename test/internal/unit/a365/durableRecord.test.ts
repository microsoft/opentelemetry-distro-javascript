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
      domainOverride: "https://legacy.example.com",
      useS2SEndpoint: false,
      body: '{"resourceSpans":[]}',
    });

    assert.strictEqual(record.version, DURABLE_RECORD_VERSION);
    assert.strictEqual(record.createdAt, 1_725_000_000_000);
    assert.match(record.id, /^[0-9a-f-]{36}$/i);
    assert.isFalse(Object.hasOwn(record, "clusterCategory"));
    assert.isFalse(Object.hasOwn(record, "domainOverride"));

    const parsed = parseDurableRecord(JSON.stringify(record));
    assert.deepEqual(parsed, record);
    assert.notInclude(JSON.stringify(record), "Bearer");
  });

  it("accepts legacy routing fields while parsing to a routing-independent record", () => {
    const parsed = parseDurableRecord(
      JSON.stringify({
        version: DURABLE_RECORD_VERSION,
        id: "record-id",
        createdAt: 1_725_000_000_000,
        tenantId: "tenant",
        agentId: "agent",
        agenticUserId: "user",
        clusterCategory: "prod",
        domainOverride: "https://legacy.example.com",
        useS2SEndpoint: false,
        body: '{"resourceSpans":[]}',
      }),
    );

    assert.deepEqual(parsed, {
      version: DURABLE_RECORD_VERSION,
      id: "record-id",
      createdAt: 1_725_000_000_000,
      tenantId: "tenant",
      agentId: "agent",
      agenticUserId: "user",
      useS2SEndpoint: false,
      body: '{"resourceSpans":[]}',
    });
    assert.isFalse(Object.hasOwn(parsed, "clusterCategory"));
    assert.isFalse(Object.hasOwn(parsed, "domainOverride"));
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

  it.each(["1e309", "9007199254740992", "1.5", "-1"])(
    "rejects an invalid durable record timestamp: %s",
    (createdAt) => {
      assert.throws(
        () =>
          parseDurableRecord(
            `{"version":${DURABLE_RECORD_VERSION},"id":"record-id","createdAt":${createdAt},"tenantId":"tenant","agentId":"agent","useS2SEndpoint":false,"body":"{}"}`,
          ),
        /Invalid durable record/,
      );
    },
  );

  it("accepts an id at the safe length bound for the durable lease filename format", () => {
    const id = "a".repeat(128);
    const parsed = parseDurableRecord(
      JSON.stringify({
        version: DURABLE_RECORD_VERSION,
        id,
        createdAt: Date.now(),
        tenantId: "tenant",
        agentId: "agent",
        agenticUserId: "user",
        useS2SEndpoint: false,
        body: '{"resourceSpans":[]}',
      }),
    );

    assert.strictEqual(parsed.id, id);
  });

  it.each(["../escape", "..\\escape", "", "a".repeat(129), "a".repeat(181)])(
    "rejects unsafe durable record ids: %j",
    (id) => {
      assert.throws(
        () =>
          parseDurableRecord(
            JSON.stringify({
              version: DURABLE_RECORD_VERSION,
              id,
              createdAt: Date.now(),
              tenantId: "tenant",
              agentId: "agent",
              agenticUserId: "user",
              useS2SEndpoint: false,
              body: '{"resourceSpans":[]}',
            }),
          ),
        /Invalid durable record/,
      );
    },
  );
});
