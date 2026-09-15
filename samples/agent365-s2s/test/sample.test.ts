// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { configureA365Logger, type ILogger } from "@microsoft/opentelemetry";

import { loadSampleConfig, parseSampleConfig } from "../src/config.js";
import { createTelemetryOptions } from "../src/index.js";
import { safeConsoleLogger } from "../src/safeLogger.js";
import { runScenario } from "../src/scenario.js";
import { S2STokenProvider } from "../src/s2sTokenProvider.js";
import {
  MsalTokenExchangeClient,
  OBSERVABILITY_SCOPES,
  TOKEN_EXCHANGE_SCOPE,
  type ConfidentialClientFactory,
  type TokenExchangeClient,
} from "../src/tokenExchangeClient.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const BLUEPRINT_CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const TEST_DIRECTORY = join(process.cwd(), ".test-tmp");

function validConfigObject(): Record<string, unknown> {
  return {
    authority: "https://login.microsoftonline.com",
    blueprintClientId: BLUEPRINT_CLIENT_ID,
    blueprintClientSecret: "sample-client-secret",
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
  };
}

after(async () => {
  await rm(TEST_DIRECTORY, { recursive: true, force: true });
});

describe("sample configuration", () => {
  it("parses valid settings and defaults the cluster to prod", () => {
    const config = parseSampleConfig(validConfigObject());

    assert.equal(config.authority.href, "https://login.microsoftonline.com/");
    assert.equal(config.blueprintClientId, BLUEPRINT_CLIENT_ID);
    assert.equal(config.blueprintClientSecret, "sample-client-secret");
    assert.equal(config.tenantId, TENANT_ID);
    assert.equal(config.agentId, AGENT_ID);
    assert.equal(config.clusterCategory, "prod");
  });

  it("loads configuration from a JSON file", async () => {
    await mkdir(TEST_DIRECTORY, { recursive: true });
    const path = join(TEST_DIRECTORY, "appsettings.json");
    await writeFile(path, JSON.stringify({ ...validConfigObject(), clusterCategory: "prod" }));

    const config = await loadSampleConfig(path);

    assert.equal(config.agentId, AGENT_ID);
    assert.equal(config.clusterCategory, "prod");
  });

  for (const key of [
    "authority",
    "blueprintClientId",
    "blueprintClientSecret",
    "tenantId",
    "agentId",
  ]) {
    it(`rejects missing ${key} without exposing another setting`, () => {
      const input = validConfigObject();
      delete input[key];

      assert.throws(
        () => parseSampleConfig(input),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(key, "i"));
          assert.doesNotMatch(error.message, /sample-client-secret/);
          return true;
        },
      );
    });

    it(`rejects placeholder ${key} without echoing it`, () => {
      const input = { ...validConfigObject(), [key]: `<replace-${key}-secret-value>` };

      assert.throws(
        () => parseSampleConfig(input),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(key, "i"));
          assert.doesNotMatch(error.message, /replace-|secret-value/);
          return true;
        },
      );
    });
  }

  for (const authority of [
    "http://login.microsoftonline.com",
    "https://login.microsoftonline.com/common",
    "https://login.microsoftonline.com/?query=unsafe",
  ]) {
    it(`rejects the non-HTTPS or non-root authority ${authority}`, () => {
      assert.throws(() => parseSampleConfig({ ...validConfigObject(), authority }), /authority/i);
    });
  }

  for (const [key, value] of [
    ["tenantId", "not-a-guid"],
    ["agentId", "agent-name"],
    ["blueprintClientId", "blueprint-name"],
  ] as const) {
    it(`rejects invalid ${key} GUIDs`, () => {
      assert.throws(
        () => parseSampleConfig({ ...validConfigObject(), [key]: value }),
        new RegExp(key, "i"),
      );
    });
  }

  it("rejects unsupported cluster values without echoing them", () => {
    assert.throws(
      () => parseSampleConfig({ ...validConfigObject(), clusterCategory: "secret-environment" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /clusterCategory/i);
        assert.doesNotMatch(error.message, /secret-environment/);
        return true;
      },
    );
  });
});

describe("two-stage MSAL token exchange", () => {
  it("uses the blueprint token as the agent application client assertion", async () => {
    const configurations: Array<Record<string, unknown>> = [];
    const requests: Array<Record<string, unknown>> = [];
    const expiresOn = new Date("2030-01-01T00:00:00.000Z");
    let clientNumber = 0;
    const factory: ConfidentialClientFactory = (configuration) => {
      configurations.push(configuration as unknown as Record<string, unknown>);
      const currentClient = clientNumber++;
      return {
        acquireTokenByClientCredential: async (request) => {
          requests.push(request as unknown as Record<string, unknown>);
          return currentClient === 0
            ? { accessToken: "blueprint-exchange-token", expiresOn }
            : { accessToken: "agent-observability-token", expiresOn };
        },
      };
    };
    const config = parseSampleConfig(validConfigObject());
    const client = new MsalTokenExchangeClient(config, factory);

    const result = await client.exchange();

    assert.deepEqual(requests[0], {
      scopes: [TOKEN_EXCHANGE_SCOPE],
      fmiPath: AGENT_ID,
    });
    assert.deepEqual(requests[1], { scopes: [...OBSERVABILITY_SCOPES] });
    assert.deepEqual(configurations[0], {
      auth: {
        authority: `https://login.microsoftonline.com/${TENANT_ID}`,
        clientId: BLUEPRINT_CLIENT_ID,
        clientSecret: "sample-client-secret",
      },
    });
    assert.deepEqual(configurations[1], {
      auth: {
        authority: `https://login.microsoftonline.com/${TENANT_ID}`,
        clientId: AGENT_ID,
        clientAssertion: "blueprint-exchange-token",
      },
    });
    assert.deepEqual(result, {
      accessToken: "agent-observability-token",
      expiresOn,
    });
  });
});

describe("S2STokenProvider", () => {
  it("reuses a cached token only outside the 60-second refresh window", async () => {
    let now = Date.parse("2029-01-01T00:00:00.000Z");
    let exchangeCount = 0;
    const client: TokenExchangeClient = {
      exchange: async () => ({
        accessToken: `token-${++exchangeCount}`,
        expiresOn: new Date(now + 120_000),
      }),
    };
    const config = parseSampleConfig(validConfigObject());
    const provider = new S2STokenProvider(config, client, () => now);

    assert.equal(await provider.resolve(AGENT_ID, TENANT_ID), "token-1");
    now += 59_999;
    assert.equal(await provider.resolve(AGENT_ID, TENANT_ID), "token-1");
    now += 1;
    assert.equal(await provider.resolve(AGENT_ID, TENANT_ID), "token-2");
    assert.equal(exchangeCount, 2);
  });

  it("uses one in-flight exchange for concurrent callers", async () => {
    let completeExchange: ((value: { accessToken: string; expiresOn: Date }) => void) | undefined;
    let exchangeCount = 0;
    const client: TokenExchangeClient = {
      exchange: () => {
        exchangeCount++;
        return new Promise((resolve) => {
          completeExchange = resolve;
        });
      },
    };
    const config = parseSampleConfig(validConfigObject());
    const provider = new S2STokenProvider(config, client);

    const resolutions = [
      provider.resolve(AGENT_ID, TENANT_ID),
      provider.resolve(AGENT_ID.toUpperCase(), TENANT_ID.toUpperCase()),
      provider.resolve(AGENT_ID, TENANT_ID, [...OBSERVABILITY_SCOPES]),
    ];
    await Promise.resolve();
    assert.equal(exchangeCount, 1);
    completeExchange?.({
      accessToken: "shared-token",
      expiresOn: new Date(Date.now() + 120_000),
    });

    assert.deepEqual(await Promise.all(resolutions), [
      "shared-token",
      "shared-token",
      "shared-token",
    ]);
  });

  it("clears a failed in-flight exchange so a later call retries", async () => {
    let exchangeCount = 0;
    const client: TokenExchangeClient = {
      exchange: async () => {
        exchangeCount++;
        if (exchangeCount === 1) {
          throw new Error("Blueprint token exchange failed (temporarily_unavailable).");
        }
        return {
          accessToken: "retry-token",
          expiresOn: new Date(Date.now() + 120_000),
        };
      },
    };
    const config = parseSampleConfig(validConfigObject());
    const provider = new S2STokenProvider(config, client);

    await assert.rejects(provider.resolve(AGENT_ID, TENANT_ID), /temporarily_unavailable/);
    assert.equal(await provider.resolve(AGENT_ID, TENANT_ID), "retry-token");
    assert.equal(exchangeCount, 2);
  });

  for (const [agentId, tenantId, expectedKey] of [
    ["44444444-4444-4444-8444-444444444444", TENANT_ID, "agentId"],
    [AGENT_ID, "55555555-5555-4555-8555-555555555555", "tenantId"],
    ["not-a-guid", TENANT_ID, "agentId"],
  ]) {
    it(`rejects ${expectedKey} identity mismatch before MSAL`, async () => {
      let exchangeCount = 0;
      const client: TokenExchangeClient = {
        exchange: async () => {
          exchangeCount++;
          throw new Error("MSAL must not run");
        },
      };
      const provider = new S2STokenProvider(parseSampleConfig(validConfigObject()), client);

      await assert.rejects(provider.resolve(agentId, tenantId), new RegExp(expectedKey, "i"));
      assert.equal(exchangeCount, 0);
    });
  }
});

describe("safe logger and package exports", () => {
  it("exposes the A365 logger API from the root package", () => {
    const logger: ILogger = safeConsoleLogger;
    assert.equal(logger, safeConsoleLogger);
    assert.equal(typeof configureA365Logger, "function");
  });

  it("writes only the formatted message and ignores unsafe additional arguments", () => {
    const original = {
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const output: string[] = [];
    console.info = (message?: unknown) => output.push(String(message));
    console.warn = (message?: unknown) => output.push(String(message));
    console.error = (message?: unknown) => output.push(String(message));

    try {
      safeConsoleLogger.info("[S2S sample] Token cache refreshed.", {
        accessToken: "unsafe-token",
      });
      safeConsoleLogger.warn("[S2S sample] Retry scheduled.", "raw-secret-message");
      safeConsoleLogger.error("[S2S sample] Authentication failed (invalid_client).", {
        clientSecret: "unsafe-secret",
        stack: "unsafe-stack",
        nested: new Error("nested-error-message"),
      });
    } finally {
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    }

    assert.deepEqual(output, [
      "[S2S sample] Token cache refreshed.",
      "[S2S sample] Retry scheduled.",
      "[S2S sample] Authentication failed (invalid_client).",
    ]);
    assert.doesNotMatch(output.join("\n"), /unsafe|raw-secret|nested-error/);
  });
});

describe("deterministic four-span scenario", () => {
  it("configures the explicit S2S exporter and observability scope", () => {
    const config = parseSampleConfig(validConfigObject());
    const tokenProvider = {
      resolve: async () => "token",
    };

    const options = createTelemetryOptions(config, tokenProvider);

    assert.equal(options.a365?.enabled, true);
    assert.equal(options.a365?.enableObservabilityExporter, true);
    assert.equal(options.a365?.useS2SEndpoint, true);
    assert.equal(options.a365?.clusterCategory, "prod");
    assert.deepEqual(options.a365?.authScopes, [...OBSERVABILITY_SCOPES]);
    assert.equal(typeof options.a365?.tokenResolver, "function");
  });

  it("emits exactly four deterministic spans in one trace with direct child parentage", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const scenarioStart = Date.parse("2029-01-01T00:00:00.000Z");
    trace.disable();
    provider.register();

    try {
      await runScenario(parseSampleConfig(validConfigObject()), scenarioStart);
      await provider.forceFlush();
      const spans = exporter
        .getFinishedSpans()
        .sort(
          (left, right) =>
            left.startTime[0] - right.startTime[0] || left.startTime[1] - right.startTime[1],
        );

      assert.equal(spans.length, 4);
      const [invoke, toolSelectingInference, executeTool, finalInference] = spans;
      assert.deepEqual(
        spans.map((span) => span.attributes["gen_ai.operation.name"]),
        ["invoke_agent", "Chat", "execute_tool", "Chat"],
      );
      assert.equal(new Set(spans.map((span) => span.spanContext().traceId)).size, 1);
      assert.equal(invoke.parentSpanContext, undefined);
      assert.equal(invoke.startTime[0] * 1_000 + invoke.startTime[1] / 1_000_000, scenarioStart);
      for (const child of spans.slice(1)) {
        assert.equal(child.parentSpanContext?.spanId, invoke.spanContext().spanId);
      }

      assert.equal(invoke.attributes["gen_ai.agent.id"], AGENT_ID);
      assert.equal(invoke.attributes["microsoft.tenant.id"], TENANT_ID);
      assert.equal(
        invoke.attributes["microsoft.a365.caller.agent.id"],
        "44444444-4444-4444-8444-444444444444",
      );
      assert.equal(invoke.attributes["user.id"], "synthetic-publisher-user");

      assert.equal(toolSelectingInference.attributes["gen_ai.usage.input_tokens"], 48);
      assert.equal(toolSelectingInference.attributes["gen_ai.usage.output_tokens"], 18);
      assert.deepEqual(toolSelectingInference.attributes["gen_ai.response.finish_reasons"], [
        "tool_call",
      ]);
      assert.equal(finalInference.attributes["gen_ai.usage.input_tokens"], 32);
      assert.equal(finalInference.attributes["gen_ai.usage.output_tokens"], 14);
      assert.deepEqual(finalInference.attributes["gen_ai.response.finish_reasons"], ["stop"]);

      assert.equal(executeTool.attributes["gen_ai.tool.name"], "lookup_weather");
      assert.equal(
        executeTool.attributes["gen_ai.tool.call.arguments"],
        JSON.stringify({ city: "Seattle" }),
      );
      assert.equal(
        executeTool.attributes["gen_ai.tool.call.result"],
        JSON.stringify({ condition: "sunny", temperatureFahrenheit: 72 }),
      );

      const durations = spans.map(
        (span) => span.duration[0] * 1_000 + span.duration[1] / 1_000_000,
      );
      assert.deepEqual(durations, [400, 100, 50, 100]);
    } finally {
      await provider.shutdown();
      trace.disable();
    }
  });
});

describe("sanitized MSAL failures", () => {
  it("sanitizes client-construction failures at the correct stage", async () => {
    let clientNumber = 0;
    const factory: ConfidentialClientFactory = () => {
      if (clientNumber++ === 1) {
        throw {
          errorCode: "invalid_client",
          message: "constructor exposed sample-client-secret",
        };
      }
      return {
        acquireTokenByClientCredential: async () => ({
          accessToken: "blueprint-exchange-token",
          expiresOn: new Date("2030-01-01T00:00:00.000Z"),
        }),
      };
    };
    const client = new MsalTokenExchangeClient(parseSampleConfig(validConfigObject()), factory);

    await assert.rejects(
      client.exchange(),
      new Error("Agent token exchange failed (invalid_client)."),
    );
  });

  it("sanitizes blueprint-stage MSAL failures", async () => {
    const factory: ConfidentialClientFactory = () => ({
      acquireTokenByClientCredential: async () => {
        throw {
          errorCode: "invalid_client",
          message: "raw failure with sample-client-secret",
          stack: "raw-stack-with-token",
          nested: { accessToken: "nested-token" },
        };
      },
    });
    const client = new MsalTokenExchangeClient(parseSampleConfig(validConfigObject()), factory);

    await assert.rejects(client.exchange(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Blueprint token exchange failed (invalid_client).");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /sample-client-secret|raw|nested/i);
      return true;
    });
  });

  it("sanitizes agent-stage MSAL failures", async () => {
    let clientNumber = 0;
    const factory: ConfidentialClientFactory = () => {
      const currentClient = clientNumber++;
      return {
        acquireTokenByClientCredential: async () => {
          if (currentClient === 0) {
            return {
              accessToken: "blueprint-exchange-token",
              expiresOn: new Date("2030-01-01T00:00:00.000Z"),
            };
          }
          throw new Error("agent-stage-secret-and-stack");
        },
      };
    };
    const client = new MsalTokenExchangeClient(parseSampleConfig(validConfigObject()), factory);

    await assert.rejects(client.exchange(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Agent token exchange failed (unknown_error).");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /secret|stack/);
      return true;
    });
  });

  it("treats missing MSAL results as sanitized stage failures", async () => {
    const factory: ConfidentialClientFactory = () => ({
      acquireTokenByClientCredential: async () => null,
    });
    const client = new MsalTokenExchangeClient(parseSampleConfig(validConfigObject()), factory);

    await assert.rejects(
      client.exchange(),
      new Error("Blueprint token exchange failed (empty_result)."),
    );
  });
});
