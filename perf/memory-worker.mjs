// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { parseArgs } from "node:util";
import { startBenchmarkSdk } from "./benchmark-sdk.mjs";

const { values } = parseArgs({
  options: {
    "package-root": { type: "string" },
    scenario: { type: "string" },
    iterations: { type: "string" },
  },
});
const iterations = Number(values.iterations);
if (!values["package-root"] || !Number.isSafeInteger(iterations) || iterations <= 0) {
  throw new Error("Memory worker requires --package-root and positive integer --iterations");
}
if (typeof globalThis.gc !== "function") {
  throw new Error("Memory benchmark requires Node --expose-gc");
}

async function settle() {
  for (let round = 0; round < 3; round += 1) {
    globalThis.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const { scenarios, shutdown } = await startBenchmarkSdk(values["package-root"]);
try {
  const scenario = scenarios.find((candidate) => candidate.name === values.scenario);
  if (!scenario) {
    throw new Error("Unknown memory scenario");
  }
  const warmupIterations = Math.min(iterations, 1_000);
  for (let index = 0; index < warmupIterations; index += 1) {
    scenario.operation();
  }
  await settle();
  const baseline = process.memoryUsage();
  for (let index = 0; index < iterations; index += 1) {
    scenario.operation();
  }
  const immediate = process.memoryUsage();
  await settle();
  const retained = process.memoryUsage();
  process.stdout.write(
    `MEMORY_RESULT:${JSON.stringify({
      baseline,
      immediate,
      retained,
      warmupIterations,
      completedAt: new Date().toISOString(),
    })}\n`,
  );
} finally {
  await shutdown();
}
