// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { scenarios } from "../../perf/benchmark-sdk.mjs";
import { exportEvents } from "../../perf/export-events.mjs";
import { createEvents, median } from "../../perf/report-results.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const run = (args, options = {}) =>
  execute(process.execPath, args, { cwd: root, timeout: 60_000, ...options });
const asMap = (attributes) => Object.fromEntries(attributes.map(({ key, value }) => [key, value]));
const records = (payload) => payload.resourceLogs[0].scopeLogs[0].logRecords;

// Deliberately synthetic arithmetic fixtures, never submitted outside a loopback test server.
function fixture() {
  const completedAt = "2026-01-01T00:00:00.000Z";
  const snapshot = (heapUsed, rss) => ({
    heapUsed,
    rss,
    heapTotal: 100,
    external: 0,
    arrayBuffers: 0,
  });
  return {
    schemaVersion: 1,
    package: { name: "@microsoft/opentelemetry", version: "1.2.3-test" },
    harness: { name: "microsoft-opentelemetry-benchmark", version: "1" },
    environment: {
      runtimeName: "nodejs",
      runtimeVersion: "22.0.0",
      osType: "windows",
      osVersion: "test",
      architecture: "amd64",
    },
    startedAt: completedAt,
    completedAt,
    iterations: 2,
    rounds: 2,
    warmupIterations: 20_000,
    memoryIterations: 2,
    memoryTrials: 2,
    benchmarks: scenarios.map((scenario) => ({
      ...scenario,
      completedAt,
      unit: "ns/op",
      durationsNs: [1_000_000_000, 2_000_000_000],
      samples: [500_000_000, 1_000_000_000],
      operationsPerSecond: [2, 1],
      stats: { median: 750_000_000 },
    })),
    memory: scenarios.map((scenario) => ({
      ...scenario,
      completedAt,
      trials: [-8, -4].map((delta) => ({
        baseline: snapshot(20, 50),
        immediate: snapshot(20 + delta, 50),
        retained: snapshot(18, 50),
        warmupIterations: 2,
        completedAt,
      })),
    })),
  };
}

async function serverFor(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/otlp/v1/logs`;
}

async function tempFor(t) {
  const directory = await mkdtemp(join(tmpdir(), "sdk-perf-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("named logs preserve measured identity, exact units, optional run and signed memory", () => {
  const raw = fixture();
  const payload = createEvents(raw);
  const resource = asMap(payload.resourceLogs[0].resource.attributes);
  assert.deepEqual(resource["package.name"], { stringValue: "@microsoft/opentelemetry" });
  assert.deepEqual(resource["package.version"], { stringValue: "1.2.3-test" });
  assert.deepEqual(resource["telemetry.sdk.name"], { stringValue: raw.harness.name });
  assert.notEqual(
    resource["telemetry.sdk.version"].stringValue,
    resource["package.version"].stringValue,
  );
  assert.equal(resource["benchmark.run_id"], undefined);
  assert.equal(resource["service.instance.id"], undefined);
  assert.equal(resource["vcs.ref.head.revision"], undefined);
  assert.deepEqual(resource["os.type"], { stringValue: "windows" });
  assert.deepEqual(resource["host.arch"], { stringValue: "amd64" });
  assert.equal(records(payload).length, 24);
  const byMetric = new Map();
  for (const record of records(payload)) {
    assert.equal(record.eventName, "microsoft.opentelemetry.benchmark.result");
    assert.equal(record.timeUnixNano, "1767225600000000000");
    const attrs = asMap(record.attributes);
    assert.equal(typeof attrs["benchmark.value"].doubleValue, "number");
    assert.equal(attrs["benchmark.iterations"].intValue, "2");
    assert.equal(attrs["benchmark.source"], undefined);
    assert.equal(attrs["benchmark.test"], undefined);
    assert.equal(attrs["benchmark.name"], undefined);
    byMetric.set(attrs["benchmark.metric"].stringValue, attrs);
  }
  const throughput = byMetric.get("microsoft.opentelemetry.benchmark.throughput");
  assert.equal(
    throughput["benchmark.value"].doubleValue,
    1.5,
    "median of rates, not reciprocal median duration",
  );
  assert.equal(throughput["benchmark.unit"].stringValue, "operations/s");
  assert.equal(throughput["benchmark.rounds"].intValue, "2");
  for (const [suffix, value, unit] of [
    ["heap_used_delta", -6, "By"],
    ["heap_used_delta_per_operation", -3, "By/{operation}"],
    ["retained_heap_delta", -2, "By"],
    ["retained_heap_delta_per_operation", -1, "By/{operation}"],
    ["rss_delta", 0, "By"],
  ]) {
    const attrs = byMetric.get(`microsoft.opentelemetry.benchmark.memory.${suffix}`);
    assert.equal(attrs["benchmark.value"].doubleValue, value);
    assert.equal(attrs["benchmark.unit"].stringValue, unit);
    assert.equal(attrs["benchmark.statistic"].stringValue, "median_delta");
    assert.equal(attrs["benchmark.memory_trials"].intValue, "2");
  }
  const first = asMap(records(payload)[0].attributes);
  assert.equal(first["test.case.name"].stringValue, "span_creation");
  assert.equal(first["benchmark.scenario"].stringValue, "span");
  raw.runId = "explicit-execution";
  raw.revision = "tested-package-revision";
  const correlated = asMap(createEvents(raw).resourceLogs[0].resource.attributes);
  assert.equal(correlated["benchmark.run_id"].stringValue, raw.runId);
  assert.equal(correlated["vcs.ref.head.revision"].stringValue, raw.revision);
});

test("raw artifact validation rejects missing, non-finite, mismatched or fabricated summaries", () => {
  const mutations = [
    (raw) => {
      raw.iterations = 0;
    },
    (raw) => {
      raw.rounds = 3;
    },
    (raw) => {
      raw.memoryTrials = 1;
    },
    (raw) => {
      raw.package.version = "";
    },
    (raw) => {
      raw.package.name = "reporter-not-tested-package";
    },
    (raw) => {
      raw.runId = "";
    },
    (raw) => {
      raw.benchmarks[0].durationsNs[0] = Infinity;
    },
    (raw) => {
      raw.benchmarks[0].samples[0] = NaN;
    },
    (raw) => {
      raw.benchmarks[0].stats.median = 1;
    },
    (raw) => {
      raw.benchmarks[0].operationsPerSecond[0] = 5;
    },
    (raw) => {
      raw.benchmarks[0].completedAt = "unknown";
    },
    (raw) => {
      raw.benchmarks[0].completedAt = "3000-01-01T00:00:00.000Z";
    },
    (raw) => {
      raw.benchmarks[0].test = "";
    },
    (raw) => {
      raw.memory[0].trials[0].baseline.heapUsed = undefined;
    },
    (raw) => {
      raw.memory[0].trials[0].immediate.rss = -1;
    },
    (raw) => {
      raw.memory[0].trials[0].warmupIterations = 0;
    },
    (raw) => {
      raw.benchmarks.pop();
    },
    (raw) => {
      raw.memory[0].name = raw.memory[1].name;
    },
  ];
  for (const mutate of mutations) {
    const raw = fixture();
    mutate(raw);
    assert.throws(() => createEvents(raw));
  }
  assert.throws(() => median([]));
  assert.throws(() => median([NaN]));
});

test("explicit export posts native OTLP JSON to the exact logs path once", async (t) => {
  const received = [];
  const endpoint = await serverFor(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      path: request.url,
      method: request.method,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks)),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const payload = createEvents(fixture());
  await exportEvents(payload, endpoint);
  assert.equal(received.length, 1);
  assert.equal(received[0].path, "/otlp/v1/logs");
  assert.equal(received[0].method, "POST");
  assert.equal(received[0].headers["content-type"], "application/json");
  assert.equal(received[0].headers.authorization, undefined);
  assert.deepEqual(received[0].body, payload);
});

test("export rejects non-2xx, redirects, malformed responses, partial success and timeout without retries", async (t) => {
  for (const [status, body] of [
    [400, "{}"],
    [429, "{}"],
    [500, "{}"],
    [302, "{}"],
    [200, ""],
    [200, "invalid"],
    [200, "null"],
    [200, "[]"],
    [200, '{"partialSuccess":{"rejectedLogRecords":"1","errorMessage":"rejected"}}'],
    [200, '{"partialSuccess":{"rejectedLogRecords":"0"}}'],
    [200, '{"error":"failed"}'],
    [200, '{"code":3,"message":"invalid"}'],
  ]) {
    await t.test(`${status} ${body}`, async (t) => {
      let requests = 0;
      const endpoint = await serverFor(t, (_request, response) => {
        requests += 1;
        response.writeHead(status, {
          location: "/must-not-follow",
          "content-type": "application/json",
        });
        response.end(body);
      });
      await assert.rejects(exportEvents(createEvents(fixture()), endpoint), /OTLP export failed/);
      assert.equal(requests, 1);
    });
  }
  await t.test("timeout", async (t) => {
    let requests = 0;
    const endpoint = await serverFor(t, () => {
      requests += 1;
    });
    await assert.rejects(exportEvents(createEvents(fixture()), endpoint, 100), /timeout/);
    assert.equal(requests, 1);
  });
});

test("unsafe or wrong endpoints are rejected before making a request", async () => {
  for (const endpoint of [
    "http://example.invalid/otlp/v1/logs",
    "https://example.invalid/v1/logs",
    "https://example.invalid/otlp/v1/metrics",
    "https://user:secret@example.invalid/otlp/v1/logs",
    "https://example.invalid/otlp/v1/logs?token=secret",
    "https://example.invalid/otlp/v1/logs#fragment",
  ]) {
    await assert.rejects(exportEvents(createEvents(fixture()), endpoint), /Endpoint must/);
  }
  await assert.rejects(exportEvents({}, "https://example.invalid/otlp/v1/logs", 0), /timeout-ms/);
});

test("offline CLI ignores exporter environment and preserves both artifacts on export failure", async (t) => {
  const directory = await tempFor(t);
  const input = join(directory, "raw.json");
  const output = join(directory, "events.json");
  const raw = JSON.stringify(fixture());
  await writeFile(input, raw);
  let requests = 0;
  const endpoint = await serverFor(t, (_request, response) => {
    requests += 1;
    response.writeHead(503);
    response.end("{}");
  });
  const args = ["perf/export-events.mjs", "--input", input, "--output", output];
  await run(args, {
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
    },
  });
  assert.equal(requests, 0);
  assert.equal(records(JSON.parse(await readFile(output))).length, 24);
  await assert.rejects(run([...args, "--endpoint", endpoint]), /HTTP 503/);
  assert.equal(requests, 1);
  assert.equal(await readFile(input, "utf8"), raw);
  assert.equal(records(JSON.parse(await readFile(output))).length, 24);
  await assert.rejects(
    run(["perf/export-events.mjs", "--input", input, "--output", input]),
    /must not overwrite/,
  );
  assert.equal(await readFile(input, "utf8"), raw);
});

test("export CLI preserves raw input through filesystem aliases", async (t) => {
  for (const kind of ["hardlink", "symlink", "directory alias", "case variant"]) {
    await t.test(kind, async (t) => {
      if (kind === "case variant" && process.platform !== "win32") {
        t.skip("Case-insensitive path regression applies to Windows");
        return;
      }
      const directory = await tempFor(t);
      const input = join(directory, "raw.json");
      const output =
        kind === "directory alias"
          ? join(directory, "alias", "raw.json")
          : join(directory, kind === "case variant" ? "RAW.JSON" : "events.json");
      const raw = JSON.stringify(fixture());
      await writeFile(input, raw);
      if (kind === "hardlink") await link(input, output);
      if (kind === "directory alias") {
        await symlink(
          directory,
          join(directory, "alias"),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      if (kind === "symlink") {
        try {
          await symlink(input, output, "file");
        } catch (error) {
          if (process.platform !== "win32" || error.code !== "EPERM") throw error;
          t.skip("Creating file symlinks requires Windows developer mode or elevation");
          return;
        }
      }
      await assert.rejects(
        run(["perf/export-events.mjs", "--input", input, "--output", output]),
        /must not overwrite/,
      );
      assert.equal(await readFile(input, "utf8"), raw);
      assert(!(await readdir(directory)).some((name) => name.startsWith(".sdk-perf-")));
    });
  }
});

test("export CLI replaces legitimate existing output without modifying its other hardlinks", async (t) => {
  const directory = await tempFor(t);
  const input = join(directory, "raw.json");
  const output = join(directory, "events.json");
  const previous = join(directory, "previous.json");
  const raw = JSON.stringify(fixture());
  await writeFile(input, raw);
  await writeFile(previous, "old output");
  await link(previous, output);
  await run(["perf/export-events.mjs", "--input", input, "--output", output]);
  assert.equal(await readFile(input, "utf8"), raw);
  assert.equal(await readFile(previous, "utf8"), "old output");
  assert.equal(records(JSON.parse(await readFile(output))).length, 24);
  assert.deepEqual((await readdir(directory)).sort(), ["events.json", "previous.json", "raw.json"]);
});

test("built SDK benchmark records genuine workloads offline despite inherited telemetry configuration", async (t) => {
  const directory = await tempFor(t);
  const output = join(directory, "raw.json");
  const networkGuard = join(directory, "deny-network.mjs");
  await writeFile(
    networkGuard,
    `
    import net from "node:net";
    net.Socket.prototype.connect = function () {
      process.stderr.write("Unexpected network connection in offline benchmark\\n");
      process.exit(73);
    };
  `,
  );
  let requests = 0;
  const endpoint = await serverFor(t, (_request, response) => {
    requests += 1;
    response.end("{}");
  });
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import="${pathToFileURL(networkGuard).href}"`,
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
    OTEL_RESOURCE_ATTRIBUTES: "secret=must-not-leak",
    OTEL_TRACES_SAMPLER: "always_off",
    OTEL_SDK_DISABLED: "true",
    MICROSOFT_OTEL_SDKSTATS_DISABLED: "false",
    APPLICATIONINSIGHTS_STATS_CONNECTION_STRING: `InstrumentationKey=00000000-0000-0000-0000-000000000001;IngestionEndpoint=${endpoint}`,
    APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=00000000-0000-0000-0000-000000000001;IngestionEndpoint=${endpoint}`,
  };
  await run(
    [
      "--expose-gc",
      "perf/benchmark.mjs",
      "--package-root",
      root,
      "--output",
      output,
      "--iterations",
      "20",
      "--rounds",
      "2",
      "--memory-iterations",
      "20",
      "--memory-trials",
      "1",
    ],
    { env },
  );
  assert.equal(requests, 0, "workload must not export telemetry");
  const rawText = await readFile(output, "utf8");
  assert(!rawText.includes("must-not-leak"));
  assert(!rawText.includes("00000000-0000-0000-0000-000000000001"));
  const raw = JSON.parse(rawText);
  assert.equal(raw.runId, undefined);
  assert.equal(raw.revision, undefined);
  assert.equal(raw.environment.runtimeVersion, process.versions.node);
  assert.equal(raw.environment.osType, process.platform === "win32" ? "windows" : process.platform);
  const manifest = JSON.parse(await readFile(join(root, "package.json")));
  assert.deepEqual(raw.package, { name: manifest.name, version: manifest.version });
  assert.equal(raw.benchmarks.length, 4);
  assert.equal(raw.memory.length, 4);
  assert.equal(records(createEvents(raw)).length, 24);
  await run(["perf/compare.mjs", "--baseline", output, "--candidate", output]);
});

test("invalid benchmark arguments fail before SDK startup", async () => {
  for (const [flag, value] of [
    ["--iterations", "0"],
    ["--rounds", "1.5"],
    ["--memory-trials", "-1"],
    ["--memory-iterations", "NaN"],
    ["--iterations", "9007199254740992"],
  ]) {
    await assert.rejects(
      run(["--expose-gc", "perf/benchmark.mjs", `${flag}=${value}`]),
      /positive safe integer/,
    );
  }
  await assert.rejects(run(["perf/benchmark.mjs"]), /requires Node --expose-gc/);
  await assert.rejects(run(["--expose-gc", "perf/benchmark.mjs", "--typo", "1"]), /Unknown option/);
});
