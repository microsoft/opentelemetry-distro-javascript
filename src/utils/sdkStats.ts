// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  SdkStatsEnvironmentConfig,
  SdkStatsFeatures,
  SdkStatsInstrumentations,
  SdkStatsOption,
} from "../types.js";
import {
  AZURE_MONITOR_STATSBEAT_FEATURES,
  SdkStatsFeature,
  SdkStatsFeaturesMap,
  SdkStatsInstrumentation,
} from "../types.js";

let instance: SdkStatsConfiguration;

class SdkStatsConfiguration {
  // Initial SDK Stats options
  private initializedByShim = false;
  private currentSdkStatsInstrumentations: SdkStatsInstrumentations = {};
  private currentSdkStatsFeatures: SdkStatsFeatures = {};

  constructor() {
    // Check for shim initialization upon construction
    try {
      if (
        JSON.parse(process.env[AZURE_MONITOR_STATSBEAT_FEATURES] || "{}").feature &
        SdkStatsFeature.SHIM
      ) {
        this.initializedByShim = true;
      }
    } catch (_error) {
      // Fail silently — SDK Stats is best-effort
    }
  }

  public setSdkStatsFeatures = (
    sdkStatsInstrumentations: SdkStatsInstrumentations,
    sdkStatsFeatures: SdkStatsFeatures,
  ) => {
    let sdkStatsEnv: SdkStatsEnvironmentConfig;
    try {
      sdkStatsEnv = JSON.parse(process.env[AZURE_MONITOR_STATSBEAT_FEATURES] || "{}");
    } catch (_error) {
      // Fail silently — SDK Stats is best-effort
      return;
    }
    this.currentSdkStatsInstrumentations = {
      ...this.currentSdkStatsInstrumentations,
      ...sdkStatsInstrumentations,
    };
    this.currentSdkStatsFeatures = { ...this.currentSdkStatsFeatures, ...sdkStatsFeatures };

    // Set the SDK Stats options for community instrumentations based on the environment variable
    sdkStatsInstrumentations = {
      ...this.currentSdkStatsInstrumentations,
      amqplib: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.AMQPLIB ? true : false,
      cucumber: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.CUCUMBER ? true : false,
      dataloader:
        sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.DATALOADER ? true : false,
      fs: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.FS ? true : false,
      lruMemoizer:
        sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.LRU_MEMOIZER ? true : false,
      mongoose: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.MONGOOSE ? true : false,
      runtimeNode:
        sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.RUNTIME_NODE ? true : false,
      socketIo: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.SOCKET_IO ? true : false,
      tedious: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.TEDIOUS ? true : false,
      undici: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.UNDICI ? true : false,
      cassandra: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.CASSANDRA ? true : false,
      connect: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.CONNECT ? true : false,
      dns: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.DNS ? true : false,
      express: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.EXPRESS ? true : false,
      fastify: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.FASTIFY ? true : false,
      genericPool:
        sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.GENERIC_POOL ? true : false,
      graphql: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.GRAPHQL ? true : false,
      hapi: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.HAPI ? true : false,
      ioredis: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.IOREDIS ? true : false,
      knex: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.KNEX ? true : false,
      koa: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.KOA ? true : false,
      memcached: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.MEMCACHED ? true : false,
      mysql2: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.MYSQL2 ? true : false,
      nestjsCore:
        sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.NESTJS_CORE ? true : false,
      net: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.NET ? true : false,
      pino: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.PINO ? true : false,
      restify: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.RESTIFY ? true : false,
      router: sdkStatsEnv!.instrumentation & SdkStatsInstrumentation.ROUTER ? true : false,
    };

    let instrumentationBitMap = SdkStatsInstrumentation.NONE;

    const instrumentationArray: Array<SdkStatsOption> = Object.entries(
      sdkStatsInstrumentations,
    ).map((entry) => {
      return { option: entry[0], value: entry[1] };
    });

    // Map the instrumentation options to a bit map
    for (let i = 0; i < instrumentationArray.length; i++) {
      if (instrumentationArray[i].value) {
        instrumentationBitMap |= 2 ** i;
      }
    }

    // Create feature bit map
    let featureBitMap = SdkStatsFeature.NONE;

    if (this.initializedByShim) {
      this.currentSdkStatsFeatures.shim = true;
    } else {
      this.currentSdkStatsFeatures.distro = true;
    }

    if (sdkStatsFeatures.liveMetrics) {
      this.currentSdkStatsFeatures.liveMetrics = true;
    }

    const featureArray: Array<SdkStatsOption> = Object.entries(this.currentSdkStatsFeatures).map(
      (entry) => {
        return { option: entry[0], value: entry[1] };
      },
    );

    // Map the feature options to a bit map
    for (let i = 0; i < featureArray.length; i++) {
      if (featureArray[i].value) {
        featureBitMap |= SdkStatsFeaturesMap.get(featureArray[i].option)!;
      }
    }

    // Merge old SDK Stats options with new SDK Stats options overriding any common properties
    try {
      const currentFeaturesBitMap = Number(process.env[AZURE_MONITOR_STATSBEAT_FEATURES]);
      if (!isNaN(currentFeaturesBitMap)) {
        featureBitMap |= currentFeaturesBitMap;
      }
      process.env[AZURE_MONITOR_STATSBEAT_FEATURES] = JSON.stringify({
        instrumentation: instrumentationBitMap,
        feature: featureBitMap,
      });
    } catch (_error) {
      // Fail silently — SDK Stats is best-effort
    }
  };
}

/**
 * Singleton SDK Stats instance.
 * @internal
 */
export function getInstance(): SdkStatsConfiguration {
  if (!instance) {
    instance = new SdkStatsConfiguration();
  }
  return instance;
}
