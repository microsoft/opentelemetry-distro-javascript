// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { isPatchedNodeVersion, requiredNodeVersion } from "../../scripts/check-node-version.cjs";

test("accepts the October security releases and subsequent stable versions", () => {
  for (const version of [
    "22.23.4",
    "22.23.5",
    "22.24.0",
    "24.22.1",
    "24.22.2",
    "24.23.0",
    "26.12.1",
    "26.12.2",
    "26.13.0",
    "27.0.0",
    "v22.23.4",
  ]) {
    assert.equal(isPatchedNodeVersion(version), true, version);
  }
});

test("rejects vulnerable patches, end-of-life lines, and prereleases", () => {
  for (const version of [
    "20.99.99",
    "22.0.0",
    "22.22.99",
    "22.23.3",
    "23.99.99",
    "24.21.99",
    "24.22.0",
    "25.99.99",
    "26.11.99",
    "26.12.0",
    "22.23.4-rc.1",
    "27.0.0-rc.1",
    "",
    "22",
    "22.23",
    "022.23.4",
    "not-a-version",
  ]) {
    assert.equal(isPatchedNodeVersion(version), false, version);
  }
});

test("checks the running executable, not a supplied version argument or environment override", () => {
  const script = fileURLToPath(new URL("../../scripts/check-node-version.cjs", import.meta.url));
  for (const version of ["0.0.0", "99.0.0"]) {
    const result = spawnSync(process.execPath, [script, version], {
      encoding: "utf8",
      env: { ...process.env, NODE_VERSION: version },
    });
    assert.ifError(result.error);
    const expected = isPatchedNodeVersion(process.versions.node) ? 0 : 1;
    assert.equal(result.status, expected, result.stderr);
    assert.ok(`${result.stdout}${result.stderr}`.includes(process.versions.node));
  }
});

test("reports failure for an old selected runtime even with patched-version overrides", () => {
  const entry = {};
  const errors = [];
  const runtime = {
    versions: { node: "24.18.0" },
    argv: ["node", "check-node-version.cjs", "24.22.1"],
    env: { NODE_VERSION: "24.22.1" },
  };
  const script = readFileSync(
    new URL("../../scripts/check-node-version.cjs", import.meta.url),
    "utf8",
  );
  runInNewContext(script, {
    require: { main: entry },
    module: entry,
    process: runtime,
    console: {
      error: (message) => errors.push(message),
      log: () => assert.fail("Reported success"),
    },
  });
  assert.equal(runtime.exitCode, 1);
  assert.match(errors[0], /Node\.js 24\.18\.0 does not meet/);
});

test("keeps repository package and linked lockfile runtime requirements aligned", () => {
  for (const directory of [
    "",
    "samples/",
    "samples/agent365-s2s/",
    "samples/aks-langchain/",
    "samples/fabric/",
  ]) {
    const manifest = JSON.parse(
      readFileSync(new URL(`../../${directory}package.json`, import.meta.url), "utf8"),
    );
    assert.equal(manifest.engines.node, requiredNodeVersion, directory || "root");
    if (directory === "samples/fabric/") {
      continue;
    }
    const lock = JSON.parse(
      readFileSync(new URL(`../../${directory}package-lock.json`, import.meta.url), "utf8"),
    );
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path === "" || path === ".." || path === "../..") {
        assert.equal(entry.engines.node, requiredNodeVersion, `${directory}${path}`);
      }
    }
  }
});
