// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * SDKStats manager — sends SDK self-telemetry to the Application Insights
 * statsbeat ingestion endpoint, independent of the customer's telemetry
 * pipeline.
 *
 * When the full Azure Monitor pipeline is enabled, the exporter package's
 * own statsbeat machinery handles SDKStats emission and the distro just
 * publishes its bits via the `AZURE_MONITOR_STATSBEAT_FEATURES` env var
 * for the exporter to read. For A365-only, OTLP-only, or Console-only
 * customers this manager spins up a standalone `MeterProvider` →
 * `AzureMonitorStatsbeatExporter` pipeline so feature/instrumentation
 * SDKStats are still collected.
 *
 * Mirrors `src/microsoft/opentelemetry/_sdkstats/_manager.py` from the
 * Python distro.
 */

import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { Logger } from "../shared/logging/index.js";
import { getModuleParentURL } from "../shared/module.js";
import { isSdkStatsEnabled, setSdkStatsShutdown } from "./state.js";
import { SdkStatsMetrics } from "./metrics.js";

/**
 * Default short export interval (15 minutes) for the standalone SDKStats
 * pipeline. This matches the Application Insights statsbeat
 * short-interval cadence used by the network statsbeat counters and the
 * Python distro (`_get_stats_short_export_interval()` in
 * `azure.monitor.opentelemetry.exporter.statsbeat._utils`).
 *
 * The pipeline emits both Feature/Feature.instrumentations gauges
 * (when not in `networkOnly` mode) and the six `request_*` network
 * gauges; the network counters dominate cadence requirements, so the
 * single shared interval defaults to short rather than long.
 *
 * @internal
 */
const DEFAULT_SHORT_EXPORT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Override env var: standalone SDKStats export interval in seconds.
 * Matches the Python distro env var name.
 *
 * @internal
 */
const SDKSTATS_SHORT_EXPORT_INTERVAL_ENV = "APPLICATIONINSIGHTS_STATS_SHORT_EXPORT_INTERVAL";

/**
 * Override env var: redirect SDKStats envelopes to a custom App
 * Insights connection string. When unset, SDKStats flow to the
 * Microsoft-owned statsbeat resource (`NON_EU_CONNECTION_STRING` in
 * the AzMon exporter package). Primarily useful for testing.
 * Matches the Python distro env var name.
 *
 * @internal
 */
const SDKSTATS_CONNECTION_STRING_ENV = "APPLICATIONINSIGHTS_STATS_CONNECTION_STRING";

/**
 * Initial-export delay (15 seconds) before the first flush.
 *
 * The spec recommends this delay specifically for the Node.js SDK to
 * avoid short-running CLI-style applications generating excess SDKStats
 * traffic on every startup.
 *
 * @internal
 */
const INITIAL_EXPORT_DELAY_MS = 15 * 1000;

/**
 * Singleton manager for the standalone SDKStats pipeline.
 *
 * The manager is safe to call `initialize()` on multiple times — only the
 * first invocation takes effect.
 */
export class SdkStatsManager {
  private static _instance: SdkStatsManager | undefined;

  private _meterProvider: MeterProvider | undefined;
  private _metrics: SdkStatsMetrics | undefined;
  private _initialized = false;
  private _initialExportTimer: NodeJS.Timeout | undefined;

  static getInstance(): SdkStatsManager {
    if (!SdkStatsManager._instance) {
      SdkStatsManager._instance = new SdkStatsManager();
    }
    return SdkStatsManager._instance;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Set up SDKStats export via the Azure Monitor statsbeat endpoint.
   *
   * @param options.networkOnly When `true`, the {@link SdkStatsMetrics}
   *   instance only registers the six network gauges and skips the
   *   feature/instrumentation gauges. Used on the Azure-Monitor-enabled
   *   path because the AzMon exporter's own long-interval statsbeat
   *   already emits those gauges (with our distro bits bridged in via
   *   `AZURE_MONITOR_STATSBEAT_FEATURES`).
   * @param options.cikey Customer iKey to report as the `cikey`
   *   customDimension on every observation. Required by the SDKStats
   *   spec; pass an empty string only if no customer iKey is available.
   *
   * Returns `true` if the standalone pipeline was initialized (or was
   * already initialized), `false` if SDKStats are disabled via env var
   * or initialization failed.
   */
  async initialize(
    options: { networkOnly?: boolean; cikey?: string } = {},
  ): Promise<boolean> {
    if (!isSdkStatsEnabled()) {
      return false;
    }
    if (this._initialized) {
      return true;
    }

    try {
      // The exporter package's `exports` map blocks subpath imports, so
      // we resolve the package's own package.json to find its install
      // location on disk and require the internal modules by absolute
      // path. The statsbeat exporter is the correct vehicle for SDKStats
      // — it tags envelopes with the statsbeat ikey/endpoint and avoids
      // recursive statsbeat-of-statsbeat reporting via its
      // `isStatsbeatExporter` flag.
      const baseUrl = getModuleParentURL() ?? pathToFileURL(process.cwd() + "/").href;
      const requireFromHere = createRequire(baseUrl);
      const exporterPackageJsonPath = requireFromHere.resolve(
        "@azure/monitor-opentelemetry-exporter/package.json",
      );
      const exporterPackageDir = dirname(exporterPackageJsonPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statsbeatExporterModule: any = requireFromHere(
        join(exporterPackageDir, "dist", "esm", "export", "statsbeat", "statsbeatExporter.js"),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statsbeatTypesModule: any = requireFromHere(
        join(exporterPackageDir, "dist", "esm", "export", "statsbeat", "types.js"),
      );
      const AzureMonitorStatsbeatExporter = statsbeatExporterModule.AzureMonitorStatsbeatExporter;
      const NON_EU_CONNECTION_STRING = statsbeatTypesModule.NON_EU_CONNECTION_STRING;

      // Allow overriding the SDKStats ingestion target via env var,
      // matching the Python distro's APPLICATIONINSIGHTS_STATS_CONNECTION_STRING
      // hook. Primarily useful for testing — production should leave
      // this unset so SDKStats flows to the Microsoft-owned statsbeat
      // resource (NON_EU_CONNECTION_STRING).
      const connectionString =
        process.env[SDKSTATS_CONNECTION_STRING_ENV] ?? NON_EU_CONNECTION_STRING;

      const exporter = new AzureMonitorStatsbeatExporter({
        connectionString,
        disableOfflineStorage: true,
      });

      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: resolveExportInterval(),
      });

      this._meterProvider = new MeterProvider({
        readers: [reader],
        resource: resourceFromAttributes({}),
      });
      this._metrics = new SdkStatsMetrics(this._meterProvider, {
        networkOnly: options.networkOnly,
        cikey: options.cikey,
      });
      this._initialized = true;
      setSdkStatsShutdown(false);

      // Spec: long-interval SDKStats should perform an initial export
      // shortly after startup (rather than waiting a full 24h cycle), but
      // delay ~15s so short-running Node.js CLI apps don't generate
      // excess startup traffic. `unref()` so the timer never blocks
      // process shutdown.
      this._initialExportTimer = setTimeout(() => {
        this._meterProvider?.forceFlush().catch((err) => {
          Logger.getInstance().debug("[SDKStats] Initial forceFlush failed.", err);
        });
      }, INITIAL_EXPORT_DELAY_MS);
      this._initialExportTimer.unref?.();

      Logger.getInstance().debug("[SDKStats] Standalone SDKStats pipeline initialized.");
      return true;
    } catch (error) {
      Logger.getInstance().debug(
        "[SDKStats] Failed to initialize standalone SDKStats pipeline; SDKStats will not be exported.",
        error,
      );
      this._cleanup();
      return false;
    }
  }

  async shutdown(): Promise<boolean> {
    if (!this._initialized) {
      return false;
    }
    if (this._initialExportTimer) {
      clearTimeout(this._initialExportTimer);
      this._initialExportTimer = undefined;
    }
    try {
      await this._meterProvider?.shutdown();
    } catch (error) {
      Logger.getInstance().debug("[SDKStats] Error shutting down standalone pipeline.", error);
    } finally {
      this._cleanup();
      setSdkStatsShutdown(true);
    }
    return true;
  }

  private _cleanup(): void {
    this._meterProvider = undefined;
    this._metrics = undefined;
    this._initialized = false;
    if (this._initialExportTimer) {
      clearTimeout(this._initialExportTimer);
      this._initialExportTimer = undefined;
    }
  }

  /**
   * @internal Test-only: discard the singleton so a fresh instance is
   * created on the next `getInstance()` call.
   */
  static _resetForTest(): void {
    SdkStatsManager._instance = undefined;
  }
}

function resolveExportInterval(): number {
  const raw = process.env[SDKSTATS_SHORT_EXPORT_INTERVAL_ENV];
  if (!raw) return DEFAULT_SHORT_EXPORT_INTERVAL_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_SHORT_EXPORT_INTERVAL_MS;
  }
  return Math.floor(seconds * 1000);
}
