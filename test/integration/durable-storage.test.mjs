// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CHILD_SCRIPT = `
  import assert from "node:assert/strict";
  import { stat } from "node:fs/promises";
  import { dirname } from "node:path";
  import {
    DURABLE_RECORD_VERSION,
    PersistentStore,
    ResolvedDurableDeliveryOptions,
  } from "./dist/esm/a365/exporter/durable/index.js";

  const store = await PersistentStore.create(
    new ResolvedDurableDeliveryOptions({
      storageDirectory: process.env.DURABLE_STORAGE_DIRECTORY,
    }),
    { info() {}, warn() {}, error() {} },
  );
  let path;
  if (process.env.DURABLE_STORAGE_ACTION === "persist") {
    path = await store.persist({
      version: DURABLE_RECORD_VERSION,
      id: "restart-record",
      createdAt: Date.now(),
      tenantId: "tenant",
      agentId: "agent",
      agenticUserId: "user",
      useS2SEndpoint: false,
      body: '{"resourceSpans":[]}',
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } else {
    const claims = await store.claimBatch(1);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].record.id, "restart-record");
    assert.equal(claims[0].record.body, '{"resourceSpans":[]}');
    path = claims[0].leasePath;
    await store.complete(claims[0]);
    assert.deepEqual(await store.claimBatch(1), []);
  }
  const root = dirname(path);
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(dirname(root))).mode & 0o777, 0o700);
  }
  console.log(root);
`;

test("durable telemetry replays from the same private cache across process restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "a365-secure-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "cache"), { mode: 0o700 });
  const roots = [];

  for (const action of ["persist", "replay"]) {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", CHILD_SCRIPT],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DURABLE_STORAGE_DIRECTORY: join(directory, "cache"),
          DURABLE_STORAGE_ACTION: action,
        },
        timeout: 20_000,
      },
    );
    roots.push(stdout.trim());
  }

  assert.equal(roots[0], roots[1]);
});
