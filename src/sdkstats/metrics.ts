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
import {
  NETWORK_METRIC_NAMES,
  REQUEST_DURATION_NAME,
  REQUEST_EXCEPTION_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_RETRY_NAME,
  REQUEST_SUCCESS_NAME,
  REQUEST_THROTTLE_NAME,
  drain,
  type NetworkMetricName,
} from "./networkStats.js";

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
 * Per-metric configuration for the six network statsbeat gauges.
 *
 * - `secondAttr` — name of the additional dimension (`statusCode` or
 *   `exceptionType`) reported alongside `endpoint`. `undefined` means the
 *   metric is keyed on `endpoint` only.
 */
interface NetworkGaugeSpec {
  metric: NetworkMetricName;
  secondAttr?: "statusCode" | "exceptionType";
  unit: string;
  description: string;
}

const NETWORK_GAUGE_SPECS: readonly NetworkGaugeSpec[] = [
  {
    metric: REQUEST_SUCCESS_NAME,
    unit: "count",
    description: "Number of successful HTTP exports per endpoint",
  },
  {
    metric: REQUEST_FAILURE_NAME,
    secondAttr: "statusCode",
    unit: "count",
    description: "Number of failed HTTP exports per endpoint and status code",
  },
  {
    metric: REQUEST_RETRY_NAME,
    secondAttr: "statusCode",
    unit: "count",
    description: "Number of retried HTTP exports per endpoint and status code",
  },
  {
    metric: REQUEST_THROTTLE_NAME,
    secondAttr: "statusCode",
    unit: "count",
    description: "Number of throttled HTTP exports per endpoint and status code",
  },
  {
    metric: REQUEST_EXCEPTION_NAME,
    secondAttr: "exceptionType",
    unit: "count",
    description: "Number of HTTP exports that raised an exception, per endpoint and exception type",
  },
  {
    metric: REQUEST_DURATION_NAME,
    unit: "s",
    description: "Cumulative HTTP export duration per endpoint",
  },
];

// Sanity check at module load — keeps NETWORK_GAUGE_SPECS in sync with
// NETWORK_METRIC_NAMES if either is edited.
/* istanbul ignore next */
if (NETWORK_GAUGE_SPECS.length !== NETWORK_METRIC_NAMES.length) {
  throw new Error("NETWORK_GAUGE_SPECS is out of sync with NETWORK_METRIC_NAMES");
}

/**
 * Options for {@link SdkStatsMetrics}.
 */
export interface SdkStatsMetricsOptions {
  /** Override the distro version reported on every observation. */
  distroVersion?: string;
  /**
   * Customer instrumentation key emitted as the `cikey` customDimension
   * on every SDKStats observation, per the Application Insights SDKStats
   * spec. Pass an empty string when no customer iKey is available.
   */
  cikey?: string;
  /**
   * When `true`, skip the Feature / Feature.instrumentations gauges. Used
   * on the Azure-Monitor-enabled path because the AzMon exporter's own
   * long-interval statsbeat already emits those gauges (with our distro
   * bits bridged in via `AZURE_MONITOR_STATSBEAT_FEATURES`); registering
   * them here would double-count.
   *
   * The six network statsbeat gauges (`Request_*` etc.) are always
   * registered regardless of this flag — coexistence with AzMon's own
   * network statsbeat is safe because the (endpoint, host) attributes
   * partition the time series.
   */
  networkOnly?: boolean;
}

/**
 * Registers observable gauges that emit feature/instrumentation data
 * derived from the global SDKStats state, plus per-export network
 * statsbeat counters drained from {@link ./networkStats.js}.
 */
export class SdkStatsMetrics {
  private readonly commonAttributes: Record<string, string>;

  constructor(meterProvider: MeterProvider, options: SdkStatsMetricsOptions = {}) {
    const { distroVersion, networkOnly = false, cikey = "" } = options;
    const meter = meterProvider.getMeter("microsoft.opentelemetry.sdkstats");

    // Per spec/sdkstats.md the required customDimensions on every
    // SDKStats observation are: rp, attach, cikey, runtimeVersion, os,
    // language, version (plus endpoint/host on network gauges and
    // statusCode/exceptionType where applicable). Missing dimensions
    // cause envelopes to be silently dropped on the backend.
    this.commonAttributes = {
      rp: "unknown",
      attach: "Manual",
      cikey,
      runtimeVersion: process.version,
      os: os.type(),
      language: STATSBEAT_LANGUAGE,
      version: distroVersion || MICROSOFT_OPENTELEMETRY_VERSION,
    };

    // Feature / instrumentation bitmask gauges are skipped when running
    // alongside the Azure Monitor exporter's own statsbeat — that pipeline
    // already emits them (with our distro bits bridged in via
    // `_bridge_sdkstats_to_azure_monitor`) and would collide with these.
    if (!networkOnly) {
      const featureGauge = meter.createObservableGauge(FEATURE_METRIC_NAME, {
        description: "SDKStats metric tracking enabled features",
      });
      featureGauge.addCallback(this.observeFeatures);

      const instrumentationGauge = meter.createObservableGauge(INSTRUMENTATION_METRIC_NAME, {
        description: "SDKStats metric tracking enabled instrumentations",
      });
      instrumentationGauge.addCallback(this.observeInstrumentations);
    }

    // Network statsbeat gauges — always registered. Each callback drains
    // the counts accumulated by exporters between observations and emits
    // one Observation per (endpoint[, second-attr]) tuple.
    for (const spec of NETWORK_GAUGE_SPECS) {
      const gauge = meter.createObservableGauge(spec.metric, {
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
        // Key layout (from networkStats.ts):
        //   [endpoint, host]                        → success / duration
        //   [endpoint, host, statusCode|exceptionType] → others
        const attrs: Record<string, string | number> = {
          ...this.commonAttributes,
          endpoint: key[0],
          host: key[1],
        };
        if (spec.secondAttr && key.length === 3) {
          attrs[spec.secondAttr] = key[2];
        }
        result.observe(value, attrs);
      }
    };
  }
}
