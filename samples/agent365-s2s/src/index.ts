// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "dotenv/config";

import { pathToFileURL } from "node:url";
import {
  configureA365Logger,
  shutdownMicrosoftOpenTelemetry,
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryOptions,
} from "@microsoft/opentelemetry";

import { loadSampleConfig, type SampleConfig } from "./config.js";
import { safeConsoleLogger } from "./safeLogger.js";
import { runScenario } from "./scenario.js";
import { S2STokenProvider } from "./s2sTokenProvider.js";
import { MsalTokenExchangeClient, OBSERVABILITY_SCOPES } from "./tokenExchangeClient.js";

interface TokenProvider {
  resolve(agentId: string, tenantId: string, scopes?: string[]): Promise<string>;
}

export function createTelemetryOptions(
  config: SampleConfig,
  tokenProvider: TokenProvider,
): MicrosoftOpenTelemetryOptions {
  return {
    samplingRatio: 1,
    tracesPerSecond: 0,
    a365: {
      enabled: true,
      enableObservabilityExporter: true,
      tokenResolver: (agentId, tenantId, scopes) =>
        tokenProvider.resolve(agentId, tenantId, scopes),
      observabilityScopeOverride: OBSERVABILITY_SCOPES[0],
      clusterCategory: config.clusterCategory,
      useS2SEndpoint: true,
    },
  };
}

function safeFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Agent365 S2S sample failed.";
  }
  if (
    /^(?:Invalid sample configuration \([A-Za-z]+\)|(?:Blueprint|Agent) token exchange failed \([A-Za-z0-9_.-]+\))\.$/.test(
      error.message,
    )
  ) {
    return error.message;
  }
  return "Agent365 S2S sample failed.";
}

export async function main(): Promise<void> {
  configureA365Logger({
    logger: safeConsoleLogger,
    logLevel: "info|warn|error",
  });

  let initialized = false;
  try {
    const config = loadSampleConfig();
    const tokenProvider = new S2STokenProvider(config, new MsalTokenExchangeClient(config));
    await tokenProvider.resolve(config.agentId, config.tenantId, [...OBSERVABILITY_SCOPES]);
    useMicrosoftOpenTelemetry(createTelemetryOptions(config, tokenProvider));
    initialized = true;
    await runScenario(config);
  } catch (error) {
    safeConsoleLogger.error(`[S2S sample] ${safeFailureMessage(error)}`);
    throw new Error("Agent365 S2S sample failed.", { cause: error });
  } finally {
    if (initialized) {
      await shutdownMicrosoftOpenTelemetry();
    }
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
