// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Observable metric callbacks for SDK self-telemetry.
 *
 * Mirrors the Azure Monitor Exporter's feature/instrumentation gauge
 * pattern, but is backend-agnostic — the metrics are collected into a
 * caller-supplied `MeterProvider`.
 *
 * Mirrors `src/microsoft/opentelemetry/_sdkstats/_metrics.py` from the
 * Python distro.
 */

import os from "node:os";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import type { ObservableResult } from "@opentelemetry/api";

import { MICROSOFT_OPENTELEMETRY_VERSION } from "../types.js";
import { getSdkStatsFeatureFlags, getSdkStatsInstrumentationFlags } from "./state.js";

/**
 * Feature SDKStats `type` dimension values, per the Application Insights
 * SDKStats specification.
 *
 * @internal
 */
export const FEATURE_TYPE_FEATURE = 0;
export const FEATURE_TYPE_INSTRUMENTATION = 1;

const FEATURE_METRIC_NAME = "Feature";
const INSTRUMENTATION_METRIC_NAME = "Feature.instrumentations";
const STATSBEAT_LANGUAGE = "node";

/**
 * Registers observable gauges that emit feature/instrumentation data
 * derived from the global SDKStats state.
 */
export class SdkStatsMetrics {
  private readonly commonAttributes: Record<string, string>;

  constructor(meterProvider: MeterProvider, distroVersion?: string) {
    const meter = meterProvider.getMeter("microsoft.opentelemetry.sdkstats");

    this.commonAttributes = {
      runtimeVersion: process.version,
      os: os.type(),
      language: STATSBEAT_LANGUAGE,
      version: distroVersion || MICROSOFT_OPENTELEMETRY_VERSION,
    };

    const featureGauge = meter.createObservableGauge(FEATURE_METRIC_NAME, {
      description: "SDKStats metric tracking enabled features",
    });
    featureGauge.addCallback(this.observeFeatures);

    const instrumentationGauge = meter.createObservableGauge(INSTRUMENTATION_METRIC_NAME, {
      description: "SDKStats metric tracking enabled instrumentations",
    });
    instrumentationGauge.addCallback(this.observeInstrumentations);
  }

  private observeFeatures = (result: ObservableResult): void => {
    const featureBits = getSdkStatsFeatureFlags();
    if (featureBits === 0) {
      // Spec: don't send Feature SDKStats when the feature list is empty.
      return;
    }
    result.observe(1, {
      ...this.commonAttributes,
      // Numeric bitmasks are sent as strings because customDimensions are
      // `Map<string, string>` server-side (per the spec's "send as long
      // string" guidance).
      feature: String(featureBits),
      type: FEATURE_TYPE_FEATURE,
    });
  };

  private observeInstrumentations = (result: ObservableResult): void => {
    const instrBits = getSdkStatsInstrumentationFlags();
    if (instrBits === 0) {
      return;
    }
    result.observe(1, {
      ...this.commonAttributes,
      feature: String(instrBits),
      type: FEATURE_TYPE_INSTRUMENTATION,
    });
  };
}
