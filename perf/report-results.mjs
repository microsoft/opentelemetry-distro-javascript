// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { scenarios } from "./benchmark-sdk.mjs";

export function median(values) {
  assert(values.length > 0 && values.every(Number.isFinite), "Expected finite observations");
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? sorted[midpoint - 1] / 2 + sorted[midpoint] / 2
    : sorted[midpoint];
}

function text(value, name) {
  assert(typeof value === "string" && value.trim().length > 0, `Invalid ${name}`);
  return value;
}

function count(value, name) {
  assert(Number.isSafeInteger(value) && value > 0, `Invalid ${name}`);
  return value;
}

function timestamp(value) {
  text(value, "measurement timestamp");
  const milliseconds = Date.parse(value);
  assert(Number.isFinite(milliseconds) && milliseconds > 0, "Invalid measurement timestamp");
  const nanoseconds = BigInt(milliseconds) * 1_000_000n;
  assert(nanoseconds <= 18_446_744_073_709_551_615n, "Measurement timestamp exceeds uint64");
  return nanoseconds.toString();
}

function attributes(values) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
  }));
}

function event(benchmark, metric, value, unit, statistic, counts) {
  assert(Number.isFinite(value), `Non-finite ${metric}`);
  return {
    eventName: "microsoft.opentelemetry.benchmark.result",
    timeUnixNano: timestamp(benchmark.completedAt),
    attributes: [
      ...attributes({
        "test.case.name": text(benchmark.test, "test case"),
        "test.suite.name": "microsoft-opentelemetry-sdk",
        "benchmark.scenario": text(benchmark.name, "scenario"),
        "benchmark.category": text(benchmark.category, "category"),
        "benchmark.metric": `microsoft.opentelemetry.benchmark.${metric}`,
        "benchmark.unit": unit,
        "benchmark.statistic": statistic,
        ...counts,
      }),
      { key: "benchmark.value", value: { doubleValue: value } },
    ],
  };
}

export function createEvents(result) {
  assert.equal(result.schemaVersion, 1, "Unsupported raw benchmark schema");
  assert.equal(result.package?.name, "@microsoft/opentelemetry", "Unexpected measured package");
  text(result.package.version, "measured package version");
  assert.equal(result.harness?.name, "microsoft-opentelemetry-benchmark", "Unexpected harness");
  assert.equal(result.harness.version, "1", "Unsupported harness version");
  const iterations = count(result.iterations, "iterations");
  const rounds = count(result.rounds, "rounds");
  const memoryIterations = count(result.memoryIterations, "memory iterations");
  const memoryTrials = count(result.memoryTrials, "memory trials");
  count(result.warmupIterations, "warmup iterations");
  timestamp(result.startedAt);
  timestamp(result.completedAt);
  const env = result.environment;
  assert(env && env.runtimeName === "nodejs", "Expected Node.js benchmark environment");
  const resource = {
    "package.name": result.package.name,
    "package.version": result.package.version,
    "service.name": result.harness.name,
    "telemetry.sdk.name": result.harness.name,
    "telemetry.sdk.version": result.harness.version,
    "telemetry.sdk.language": "javascript",
    "user_agent.synthetic.type": "test",
    "process.runtime.name": env.runtimeName,
    "process.runtime.version": text(env.runtimeVersion, "runtime version"),
    "os.type": text(env.osType, "OS type"),
    "os.version": text(env.osVersion, "OS version"),
    "host.arch": text(env.architecture, "architecture"),
  };
  if (result.runId !== undefined) resource["benchmark.run_id"] = text(result.runId, "run ID");
  if (result.revision !== undefined)
    resource["vcs.ref.head.revision"] = text(result.revision, "revision");
  const logRecords = [];
  for (const collection of [result.benchmarks, result.memory]) {
    assert(Array.isArray(collection), "Missing benchmark observations");
    assert.deepEqual(
      collection.map((item) => item.name).sort(),
      scenarios.map((item) => item.name).sort(),
      "Expected one result for each SDK scenario",
    );
  }
  for (const benchmark of result.benchmarks) {
    assert.equal(benchmark.unit, "ns/op", "Unexpected timing unit");
    assert.equal(benchmark.durationsNs?.length, rounds, "Timing round count mismatch");
    assert(
      benchmark.durationsNs.every((duration) => Number.isSafeInteger(duration) && duration > 0),
      "Invalid raw duration",
    );
    const samples = benchmark.durationsNs.map((duration) => duration / iterations);
    assert.deepEqual(benchmark.samples, samples, "Raw timing samples mismatch");
    assert.equal(benchmark.stats?.median, median(samples), "Raw timing median mismatch");
    const rates = benchmark.durationsNs.map((duration) => (iterations * 1e9) / duration);
    assert.deepEqual(benchmark.operationsPerSecond, rates, "Raw operation rates mismatch");
    logRecords.push(
      event(benchmark, "throughput", median(rates), "operations/s", "median", {
        "benchmark.iterations": iterations,
        "benchmark.rounds": rounds,
        "benchmark.warmup_iterations": result.warmupIterations,
      }),
    );
  }
  for (const benchmark of result.memory) {
    const throughput = result.benchmarks.find((item) => item.name === benchmark.name);
    assert.equal(benchmark.test, throughput.test, "Memory test identity mismatch");
    assert.equal(benchmark.category, throughput.category, "Memory category mismatch");
    assert.equal(benchmark.trials?.length, memoryTrials, "Memory trial count mismatch");
    for (const trial of benchmark.trials) {
      timestamp(trial.completedAt);
      assert.equal(
        trial.warmupIterations,
        Math.min(memoryIterations, 1_000),
        "Memory warmup mismatch",
      );
      for (const snapshot of [trial.baseline, trial.immediate, trial.retained]) {
        for (const field of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"]) {
          assert(
            Number.isSafeInteger(snapshot?.[field]) && snapshot[field] >= 0,
            `Invalid memory snapshot ${field}`,
          );
        }
      }
    }
    const heap = median(
      benchmark.trials.map((trial) => trial.immediate.heapUsed - trial.baseline.heapUsed),
    );
    const retained = median(
      benchmark.trials.map((trial) => trial.retained.heapUsed - trial.baseline.heapUsed),
    );
    const rss = median(benchmark.trials.map((trial) => trial.immediate.rss - trial.baseline.rss));
    for (const [metric, value, unit] of [
      ["heap_used_delta", heap, "By"],
      ["heap_used_delta_per_operation", heap / memoryIterations, "By/{operation}"],
      ["retained_heap_delta", retained, "By"],
      ["retained_heap_delta_per_operation", retained / memoryIterations, "By/{operation}"],
      ["rss_delta", rss, "By"],
    ]) {
      logRecords.push(
        event(benchmark, `memory.${metric}`, value, unit, "median_delta", {
          "benchmark.iterations": memoryIterations,
          "benchmark.memory_trials": memoryTrials,
          "benchmark.warmup_iterations": Math.min(memoryIterations, 1_000),
        }),
      );
    }
  }
  return {
    resourceLogs: [
      {
        resource: { attributes: attributes(resource) },
        scopeLogs: [
          {
            scope: { name: result.harness.name, version: result.harness.version },
            logRecords,
          },
        ],
      },
    ],
  };
}
