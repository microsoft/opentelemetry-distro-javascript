// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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
    a365: {
      enabled: true,
      enableObservabilityExporter: true,
      tokenResolver: (agentId, tenantId, scopes) =>
        tokenProvider.resolve(agentId, tenantId, scopes),
      authScopes: [...OBSERVABILITY_SCOPES],
      clusterCategory: "prod",
      useS2SEndpoint: true,
    },
  };
}

function safeFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Agent365 S2S sample failed.";
  }
  if (
    /^(?:Invalid sample configuration \([A-Za-z]+\)|Unable to load sample configuration|(?:Blueprint|Agent) token exchange failed \([A-Za-z0-9_.-]+\))\.$/.test(
      error.message,
    )
  ) {
    return error.message;
  }
  return "Agent365 S2S sample failed.";
}

export async function main(configPath = "appsettings.json"): Promise<void> {
  configureA365Logger({
    logger: safeConsoleLogger,
    logLevel: "info|warn|error",
  });

  let initialized = false;
  try {
    const config = await loadSampleConfig(configPath);
    const tokenProvider = new S2STokenProvider(config, new MsalTokenExchangeClient(config));
    useMicrosoftOpenTelemetry(createTelemetryOptions(config, tokenProvider));
    initialized = true;
    await runScenario(config);
  } catch (error) {
    safeConsoleLogger.error(`[S2S sample] ${safeFailureMessage(error)}`);
    throw new Error("Agent365 S2S sample failed.");
  } finally {
    if (initialized) {
      await shutdownMicrosoftOpenTelemetry();
    }
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  void main(process.argv[2]).catch(() => {
    process.exitCode = 1;
  });
}
