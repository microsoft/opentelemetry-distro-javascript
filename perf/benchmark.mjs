// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { startBenchmarkSdk } from "./benchmark-sdk.mjs";
import { median } from "./report-results.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      ["package-root", process.cwd()],
      ["output", undefined],
      ["iterations", "100000"],
      ["rounds", "12"],
      ["memory-iterations", "10000"],
      ["memory-trials", "5"],
      ["run-id", undefined],
      ["revision", undefined],
    ].map(([name, defaultValue]) => [name, { type: "string", default: defaultValue }]),
  ),
});
function count(name) {
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive safe integer`);
  }
  return value;
}
const iterations = count("iterations");
const rounds = count("rounds");
const memoryIterations = count("memory-iterations");
const memoryTrials = count("memory-trials");
const warmupIterations = 20_000;
if (typeof globalThis.gc !== "function") {
  throw new Error("Benchmark requires Node --expose-gc");
}
for (const option of ["run-id", "revision"]) {
  if (values[option] !== undefined && !values[option].trim()) {
    throw new Error(`--${option} must not be empty`);
  }
}
const packageRoot = resolve(values["package-root"]);
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
if (
  manifest.name !== "@microsoft/opentelemetry" ||
  typeof manifest.version !== "string" ||
  !manifest.version
) {
  throw new Error("--package-root must identify a built @microsoft/opentelemetry package");
}
const startedAt = new Date().toISOString();
const benchmarks = [];
function runIterations(operation, count) {
  const start = process.hrtime.bigint();
  for (let index = 0; index < count; index += 1) {
    operation();
  }
  return Number(process.hrtime.bigint() - start);
}
const { scenarios, shutdown } = await startBenchmarkSdk(packageRoot);
try {
  for (const scenario of scenarios) {
    runIterations(scenario.operation, warmupIterations);
    const durationsNs = [];
    for (let round = 0; round < rounds; round += 1) {
      globalThis.gc();
      durationsNs.push(runIterations(scenario.operation, iterations));
      await new Promise((resolveRound) => setImmediate(resolveRound));
    }
    const samples = durationsNs.map((duration) => duration / iterations);
    benchmarks.push({
      name: scenario.name,
      test: scenario.test,
      category: scenario.category,
      gating: scenario.category === "span",
      samples,
      durationsNs,
      operationsPerSecond: durationsNs.map((duration) => (iterations * 1e9) / duration),
      stats: { median: median(samples) },
      unit: "ns/op",
      completedAt: new Date().toISOString(),
    });
  }
} finally {
  await shutdown();
}
const memory = [];
const execute = promisify(execFile);
for (const scenario of scenarios) {
  const trials = [];
  for (let trial = 0; trial < memoryTrials; trial += 1) {
    const { stdout } = await execute(
      process.execPath,
      [
        "--expose-gc",
        fileURLToPath(new URL("./memory-worker.mjs", import.meta.url)),
        "--package-root",
        packageRoot,
        "--scenario",
        scenario.name,
        "--iterations",
        String(memoryIterations),
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith("MEMORY_RESULT:"));
    if (lines.length !== 1) {
      throw new Error(`Memory worker ${scenario.name} did not return exactly one result`);
    }
    trials.push(JSON.parse(lines[0].slice("MEMORY_RESULT:".length)));
  }
  memory.push({
    name: scenario.name,
    test: scenario.test,
    category: scenario.category,
    trials,
    completedAt: new Date().toISOString(),
  });
}
const result = {
  schemaVersion: 1,
  package: { name: manifest.name, version: manifest.version },
  packageRoot,
  harness: { name: "microsoft-opentelemetry-benchmark", version: "1" },
  environment: {
    runtimeName: "nodejs",
    runtimeVersion: process.versions.node,
    osType: { win32: "windows", darwin: "darwin" }[process.platform] ?? process.platform,
    osVersion: release(),
    architecture:
      { x64: "amd64", ia32: "x86", arm: "arm32", arm64: "arm64" }[process.arch] ?? process.arch,
  },
  ...(values["run-id"] === undefined ? {} : { runId: values["run-id"] }),
  ...(values.revision === undefined ? {} : { revision: values.revision }),
  startedAt,
  completedAt: new Date().toISOString(),
  iterations,
  rounds,
  warmupIterations,
  memoryIterations,
  memoryTrials,
  benchmarks,
  memory,
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (values.output) {
  await mkdir(dirname(resolve(values.output)), { recursive: true });
  await writeFile(values.output, json, "utf8");
} else {
  process.stdout.write(json);
}
