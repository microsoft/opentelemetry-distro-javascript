// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Instrumentation } from "@opentelemetry/instrumentation";
import type { SdkStatsEnvironmentConfig } from "../types.js";
import { AZURE_MONITOR_STATSBEAT_FEATURES, SdkStatsInstrumentationMap } from "../types.js";
import { Logger } from "../shared/logging/index.js";

/**
 * Patch OpenTelemetry Instrumentation enablement to update the SDK Stats environment variable with the enabled instrumentations
 * @internal
 */
export function patchOpenTelemetryInstrumentationEnable(): void {
  const emptySdkStatsConfig: string = JSON.stringify({ instrumentation: 0, feature: 0 });
  try {
    require.resolve("@opentelemetry/instrumentation");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const autoLoaderUtils = require("@opentelemetry/instrumentation/build/src/autoLoaderUtils");

    const originalModuleDefinition = autoLoaderUtils.enableInstrumentations;

    // Parses the enabled instrumentations and then ammends the SDK Stats instrumentation environment variable
    autoLoaderUtils.enableInstrumentations = function (instrumentations: Instrumentation[]) {
      try {
        if (instrumentations.length > 0) {
          const sdkStatsOptions: SdkStatsEnvironmentConfig = JSON.parse(
            process.env[AZURE_MONITOR_STATSBEAT_FEATURES] || emptySdkStatsConfig,
          );
          let updatedSdkStats = {};
          for (let i = 0; i < instrumentations.length; i++) {
            updatedSdkStats = {
              instrumentation: (sdkStatsOptions.instrumentation |=
                SdkStatsInstrumentationMap.get(instrumentations[i].instrumentationName) || 0),
              feature: sdkStatsOptions.feature,
            };
          }
          process.env[AZURE_MONITOR_STATSBEAT_FEATURES] = JSON.stringify(updatedSdkStats);
        }
      } catch (_e) {
        Logger.getInstance().warn("Failed to parse the SDK Stats environment variable");
      }
      // eslint-disable-next-line prefer-rest-params
      return originalModuleDefinition.apply(this, arguments);
    };
  } catch (_e) {
    // Fail silently if the module is not found
  }
}
