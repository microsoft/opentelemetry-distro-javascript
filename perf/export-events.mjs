// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createEvents } from "./report-results.mjs";

export async function exportEvents(payload, endpoint, timeoutMs = 20_000) {
  const url = new URL(endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.pathname !== "/otlp/v1/logs" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Endpoint must be an explicit HTTPS /otlp/v1/logs URL without credentials or query (HTTP allowed only on loopback)",
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("--timeout-ms must be a positive integer at most 120000");
  }
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) {
    throw new Error("OTLP payload exceeds 4 MiB");
  }
  let response;
  let responseBody = "";
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (response.body) {
      for await (const chunk of response.body) {
        responseBody += Buffer.from(chunk).toString("utf8");
        if (Buffer.byteLength(responseBody) > 64 * 1024) {
          throw new Error("Response exceeds 64 KiB");
        }
      }
    }
  } catch {
    throw new Error(
      "OTLP export failed: network error, redirect, oversized response, or timeout; delivery may be unknown. No retry was attempted.",
    );
  }
  if (!response.ok) {
    throw new Error(`OTLP export failed: HTTP ${response.status}; no retry was attempted`);
  }
  let reply;
  try {
    reply = JSON.parse(responseBody);
  } catch {
    throw new Error("OTLP export failed: malformed JSON response");
  }
  if (
    reply === null ||
    Array.isArray(reply) ||
    typeof reply !== "object" ||
    Object.keys(reply).length !== 0
  ) {
    throw new Error(
      "OTLP export failed: expected an empty success object, received partialSuccess, error, or unexpected fields",
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      endpoint: { type: "string" },
      "timeout-ms": { type: "string", default: "20000" },
    },
  });
  if (!values.input || !values.output) throw new Error("--input and --output are required");
  const input = resolve(values.input);
  const output = resolve(values.output);
  if (
    process.platform === "win32" ? input.toLowerCase() === output.toLowerCase() : input === output
  ) {
    throw new Error("--output must not overwrite the raw --input artifact");
  }
  const payload = createEvents(JSON.parse(await readFile(input, "utf8")));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (values.endpoint !== undefined) {
    await exportEvents(payload, values.endpoint, Number(values["timeout-ms"]));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
