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
import { REQUEST_SUCCESS_NAME, drain, type NetworkMetricName } from "./networkStats.js";

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
 * Per-metric configuration for the network statsbeat gauges.
 */
interface NetworkGaugeSpec {
  metric: NetworkMetricName;
  unit: string;
  description: string;
}

const NETWORK_GAUGE_SPECS: readonly NetworkGaugeSpec[] = [
  {
    metric: REQUEST_SUCCESS_NAME,
    unit: "count",
    description: "Number of successful HTTP exports per endpoint",
  },
];

/**
 * Options for {@link SdkStatsMetrics}.
 */
export interface SdkStatsMetricsOptions {
  /** Override the distro version reported on every observation. */
  distroVersion?: string;
  /**
   * Customer instrumentation key emitted as the `cikey` customDimension
   * on every SDKStats observation, per the Application Insights SDKStats
   * spec. Reported as `"N/A"` when undefined or empty (e.g. for OTLP-only
   * customers without an Application Insights connection string).
   */
  cikey?: string;
  /**
   * When `true`, skip the Feature / Feature.instrumentations gauges. Used
   * on the Azure-Monitor-enabled path because the AzMon exporter's own
   * long-interval statsbeat already emits those gauges (with our distro
   * bits bridged in via `AZURE_MONITOR_STATSBEAT_FEATURES`); registering
   * them here would double-count.
   *
   * The network statsbeat gauge (`Request_Success_Count`) is always
   * registered regardless of this flag — coexistence with AzMon's own
   * network statsbeat is safe because the (endpoint, host) attributes
   * partition the time series.
   */
  networkOnly?: boolean;
  /**
   * MeterProvider for long-interval gauges (Feature /
   * Feature.instrumentations). May be undefined when `networkOnly` is
   * true. When provided, gauges are registered on a meter from this
   * provider so they export at the long (24h) cadence.
   */
  longMeterProvider?: MeterProvider;
  /**
   * MeterProvider for short-interval gauges (network statsbeat like
   * `Request_Success_Count`). Gauges are registered on a meter from
   * this provider so they export at the short (15 min) cadence.
   */
  shortMeterProvider: MeterProvider;
}

/**
 * Registers observable gauges that emit feature/instrumentation data
 * derived from the global SDKStats state, plus per-export network
 * statsbeat counters drained from {@link ./networkStats.js}.
 */
export class SdkStatsMetrics {
  private readonly commonAttributes: Record<string, string>;

  constructor(options: SdkStatsMetricsOptions);
  /** @deprecated Use the options-object overload instead. */
  constructor(
    meterProvider: MeterProvider,
    options?: Omit<SdkStatsMetricsOptions, "shortMeterProvider" | "longMeterProvider">,
  );
  constructor(
    providerOrOptions: MeterProvider | SdkStatsMetricsOptions,
    legacyOptions?: Omit<SdkStatsMetricsOptions, "shortMeterProvider" | "longMeterProvider">,
  ) {
    let longMeterProvider: MeterProvider | undefined;
    let shortMeterProvider: MeterProvider;
    let distroVersion: string | undefined;
    let networkOnly: boolean;
    let cikey: string | undefined;

    if ("shortMeterProvider" in providerOrOptions) {
      // New options-object overload
      longMeterProvider = providerOrOptions.longMeterProvider;
      shortMeterProvider = providerOrOptions.shortMeterProvider;
      distroVersion = providerOrOptions.distroVersion;
      networkOnly = providerOrOptions.networkOnly ?? false;
      cikey = providerOrOptions.cikey;
    } else {
      // Legacy single-provider overload (used by tests)
      longMeterProvider = providerOrOptions;
      shortMeterProvider = providerOrOptions;
      distroVersion = legacyOptions?.distroVersion;
      networkOnly = legacyOptions?.networkOnly ?? false;
      cikey = legacyOptions?.cikey;
    }

    // Per spec/sdkstats.md the required customDimensions on every
    // SDKStats observation are: rp, attach, runtimeVersion, os,
    // language, version, cikey (plus endpoint/host on network gauges and
    // statusCode/exceptionType where applicable). `cikey` falls back to
    // "N/A" when unset.
    this.commonAttributes = {
      rp: "unknown",
      attach: "Manual",
      runtimeVersion: process.version,
      os: os.type(),
      language: STATSBEAT_LANGUAGE,
      version: distroVersion || MICROSOFT_OPENTELEMETRY_VERSION,
      cikey: cikey || "N/A",
    };

    // Feature / instrumentation bitmask gauges are skipped when running
    // alongside the Azure Monitor exporter's own statsbeat — that pipeline
    // already emits them (with our distro bits bridged in via
    // `_bridge_sdkstats_to_azure_monitor`) and would collide with these.
    // These gauges are registered on the long-interval MeterProvider.
    if (!networkOnly && longMeterProvider) {
      const longMeter = longMeterProvider.getMeter("microsoft.opentelemetry.sdkstats");

      const featureGauge = longMeter.createObservableGauge(FEATURE_METRIC_NAME, {
        description: "SDKStats metric tracking enabled features",
      });
      featureGauge.addCallback(this.observeFeatures);

      const instrumentationGauge = longMeter.createObservableGauge(INSTRUMENTATION_METRIC_NAME, {
        description: "SDKStats metric tracking enabled instrumentations",
      });
      instrumentationGauge.addCallback(this.observeInstrumentations);
    }

    // Network statsbeat gauges — always registered on the short-interval
    // MeterProvider. Each callback drains the counts accumulated by
    // exporters between observations and emits one Observation per
    // (endpoint, host) tuple.
    const shortMeter = shortMeterProvider.getMeter("microsoft.opentelemetry.sdkstats.network");
    for (const spec of NETWORK_GAUGE_SPECS) {
      const gauge = shortMeter.createObservableGauge(spec.metric, {
        unit: spec.unit,
        description: spec.description,
      });
      gauge.addCallback(this.makeNetworkCallback(spec));
    }
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

  private makeNetworkCallback(spec: NetworkGaugeSpec): (result: ObservableResult) => void {
    return (result: ObservableResult): void => {
      for (const [key, value] of drain(spec.metric)) {
        const attrs: Record<string, string | number> = {
          ...this.commonAttributes,
          endpoint: key[0],
          host: key[1],
        };
        result.observe(value, attrs);
      }
    };
  }
}
