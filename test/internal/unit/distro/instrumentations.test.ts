// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, assert, beforeEach, afterEach } from "vitest";
import type {
  UndiciInstrumentationConfig,
  UndiciRequest,
} from "@opentelemetry/instrumentation-undici";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { createInstrumentations } from "../../../../src/distro/instrumentations.js";
import { _resolveA365ExporterOrigins } from "../../../../src/distro/distro.js";
import { InternalConfig } from "../../../../src/shared/index.js";
import { A365Configuration, A365_ENV_VARS } from "../../../../src/a365/index.js";

const UNDICI_NAME = "@opentelemetry/instrumentation-undici";
const HTTP_NAME = "@opentelemetry/instrumentation-http";
const A365_PROD_ORIGIN = "https://agent365.svc.cloud.microsoft";

function findByName(
  instrumentations: Instrumentation[],
  name: string,
): Instrumentation | undefined {
  return instrumentations.find((i) => i.instrumentationName === name);
}

function getUndiciConfig(instrumentations: Instrumentation[]): UndiciInstrumentationConfig {
  const undici = findByName(instrumentations, UNDICI_NAME);
  assert.ok(undici, "undici instrumentation should be registered");
  return undici!.getConfig() as UndiciInstrumentationConfig;
}

/** Minimal UndiciRequest with just the fields the ignore hook inspects. */
function fakeUndiciRequest(origin: string): UndiciRequest {
  return {
    origin,
    method: "POST",
    path: "/v1/chat/completions",
    headers: [],
    addHeader: () => {},
    throwOnError: false,
    completed: false,
    aborted: false,
    idempotent: true,
    contentLength: null,
    contentType: null,
    body: null,
  } as UndiciRequest;
}

describe("createInstrumentations — undici / fetch HTTP client spans", () => {
  it("registers the undici (fetch) instrumentation by default", () => {
    const config = new InternalConfig();
    const instrumentations = createInstrumentations(config);

    assert.ok(findByName(instrumentations, UNDICI_NAME), "undici should be registered by default");
    assert.ok(findByName(instrumentations, HTTP_NAME), "http should still be registered");
  });

  it("does not register undici when explicitly disabled", () => {
    const config = new InternalConfig();
    config.instrumentationOptions.undici = { enabled: false };
    const instrumentations = createInstrumentations(config);

    assert.isUndefined(
      findByName(instrumentations, UNDICI_NAME),
      "undici should not be registered when disabled",
    );
  });

  it("does not add an ignoreRequestHook when no exporter origins are provided", () => {
    const config = new InternalConfig();
    const instrumentations = createInstrumentations(config);

    assert.isUndefined(
      getUndiciConfig(instrumentations).ignoreRequestHook,
      "no ignoreRequestHook should be added without origins to filter",
    );
  });

  it("ignores requests to the provided exporter origins but traces others", () => {
    const config = new InternalConfig();
    const instrumentations = createInstrumentations(config, {
      ignoreUndiciOrigins: [A365_PROD_ORIGIN],
    });
    const hook = getUndiciConfig(instrumentations).ignoreRequestHook;
    assert.ok(hook, "ignoreRequestHook should be added when origins are provided");

    assert.strictEqual(
      hook!(fakeUndiciRequest(A365_PROD_ORIGIN)),
      true,
      "exporter-origin request should be ignored (not traced)",
    );
    assert.strictEqual(
      hook!(fakeUndiciRequest("https://api.openai.com")),
      false,
      "a real fetch (e.g. LLM call) should still be traced",
    );
  });

  it("delegates to a caller-provided ignoreRequestHook for non-exporter origins", () => {
    const config = new InternalConfig();
    config.instrumentationOptions.undici = {
      enabled: true,
      ignoreRequestHook: (request: UndiciRequest) => request.origin === "https://blocked.example",
    };
    const instrumentations = createInstrumentations(config, {
      ignoreUndiciOrigins: [A365_PROD_ORIGIN],
    });
    const hook = getUndiciConfig(instrumentations).ignoreRequestHook!;

    assert.strictEqual(hook(fakeUndiciRequest(A365_PROD_ORIGIN)), true, "exporter origin ignored");
    assert.strictEqual(
      hook(fakeUndiciRequest("https://blocked.example")),
      true,
      "caller hook should still apply",
    );
    assert.strictEqual(
      hook(fakeUndiciRequest("https://api.openai.com")),
      false,
      "unrelated origin should be traced",
    );
  });

  it("does not mutate the caller-provided undici config object", () => {
    const config = new InternalConfig();
    const callerUndiciConfig: UndiciInstrumentationConfig = { enabled: true };
    config.instrumentationOptions.undici = callerUndiciConfig;

    createInstrumentations(config, { ignoreUndiciOrigins: [A365_PROD_ORIGIN] });

    assert.isUndefined(
      callerUndiciConfig.ignoreRequestHook,
      "caller config must be cloned, not mutated, when adding the ignore hook",
    );
  });
});

describe("_resolveA365ExporterOrigins", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const managedVars = [
    A365_ENV_VARS.DOMAIN,
    A365_ENV_VARS.CLUSTER_CATEGORY,
    A365_ENV_VARS.EXPORTER_ENABLED,
  ];

  beforeEach(() => {
    for (const key of managedVars) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of managedVars) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("returns [] when A365 is disabled", () => {
    const a365 = new A365Configuration({ enabled: false, enableObservabilityExporter: true });
    assert.deepStrictEqual(_resolveA365ExporterOrigins(a365), []);
  });

  it("returns [] when the A365 observability exporter is disabled", () => {
    const a365 = new A365Configuration({ enabled: true, enableObservabilityExporter: false });
    assert.deepStrictEqual(_resolveA365ExporterOrigins(a365), []);
  });

  it("returns the prod endpoint origin when the exporter is active", () => {
    const a365 = new A365Configuration({
      enabled: true,
      enableObservabilityExporter: true,
      clusterCategory: "prod",
    });
    assert.deepStrictEqual(_resolveA365ExporterOrigins(a365), [A365_PROD_ORIGIN]);
  });

  it("returns the domainOverride origin (host:port only) when set", () => {
    const a365 = new A365Configuration({
      enabled: true,
      enableObservabilityExporter: true,
      domainOverride: "https://custom-a365.example.com:8443/some/path",
    });
    assert.deepStrictEqual(_resolveA365ExporterOrigins(a365), [
      "https://custom-a365.example.com:8443",
    ]);
  });
});
