// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ResourceDetectionConfig, Resource } from "@opentelemetry/resources";
import {
  defaultResource,
  detectResources,
  emptyResource,
  envDetector,
} from "@opentelemetry/resources";
import type {
  BrowserSdkLoaderOptions,
  InstrumentationOptions,
  MicrosoftOpenTelemetryOptions,
} from "../types.js";
import type { Sampler } from "@opentelemetry/sdk-trace-base";
import type { AzureMonitorExporterOptions } from "@azure/monitor-opentelemetry-exporter";
import { EnvConfig } from "./envConfig.js";
import { JsonConfig } from "./jsonConfig.js";
import { Logger } from "./logging/index.js";
import {
  azureAksDetector,
  azureAppServiceDetector,
  azureFunctionsDetector,
  azureVmDetector,
} from "@opentelemetry/resource-detector-azure";

/**
 * Internal configuration that merges global and Azure Monitor-scoped options.
 */
export class InternalConfig {
  /** The rate of telemetry items tracked that should be transmitted (Default 1.0) */
  public samplingRatio: number;
  /** The maximum number of spans to sample per second. */
  public tracesPerSecond?: number;
  /** Azure Monitor Exporter Configuration */
  public azureMonitorExporterOptions: AzureMonitorExporterOptions;
  /**
   * OpenTelemetry Instrumentations configuration included as part of Azure Monitor (azureSdk, http, mongoDb, mySql, postgreSql, redis, redis4)
   */
  public instrumentationOptions: InstrumentationOptions;
  /** Enable Live Metrics feature */
  enableLiveMetrics?: boolean;
  /** Enable Standard Metrics feature */
  enableStandardMetrics?: boolean;
  /** Enable log sampling based on trace (Default true) */
  enableTraceBasedSamplingForLogs?: boolean;
  /** Enable Performance Counter feature */
  enablePerformanceCounters?: boolean;
  /** Metric export interval in milliseconds */
  public metricExportIntervalMillis: number;
  /** Custom OpenTelemetry sampler (env-only) */
  public sampler?: Sampler;

  private _resource: Resource = emptyResource();

  public set resource(resource: Resource) {
    this._resource = this._resource.merge(resource);
  }

  /**
   *Get OpenTelemetry Resource
   */
  public get resource(): Resource {
    return this._resource;
  }

  public browserSdkLoaderOptions: BrowserSdkLoaderOptions;

  /**
   * Initializes a new instance of InternalConfig.
   * Accepts MicrosoftOpenTelemetryOptions (distro-level) — global options come
   * from the top level, Azure Monitor-specific options from the azureMonitor key.
   */
  constructor(options?: MicrosoftOpenTelemetryOptions) {
    // Default values
    this.azureMonitorExporterOptions = {};
    this.samplingRatio = 1;
    this.tracesPerSecond = 5;
    this.enableLiveMetrics = true;
    this.enableStandardMetrics = true;
    this.enableTraceBasedSamplingForLogs = false;
    this.enablePerformanceCounters = true;
    this.metricExportIntervalMillis = this.calculateMetricExportInterval();
    this.instrumentationOptions = {
      http: { enabled: true },
      azureSdk: { enabled: true },
      azureFunctions: { enabled: true },
      mongoDb: { enabled: true },
      mySql: { enabled: true },
      postgreSql: { enabled: true },
      redis: { enabled: true },
      redis4: { enabled: true },
    };
    this._setDefaultResource();
    this.browserSdkLoaderOptions = {
      enabled: false,
      connectionString: "",
    };

    if (options) {
      const azureMonitor = options.azureMonitor;
      // Global options
      this.instrumentationOptions = Object.assign(
        this.instrumentationOptions,
        options.instrumentationOptions,
      );
      this.resource = Object.assign(this.resource, options.resource);
      this.samplingRatio =
        options.samplingRatio !== undefined ? options.samplingRatio : this.samplingRatio;
      this.tracesPerSecond =
        options.tracesPerSecond !== undefined ? options.tracesPerSecond : this.tracesPerSecond;

      // Azure Monitor-scoped options
      if (azureMonitor) {
        this.azureMonitorExporterOptions = Object.assign(
          this.azureMonitorExporterOptions,
          azureMonitor.azureMonitorExporterOptions,
        );
        this.browserSdkLoaderOptions = Object.assign(
          this.browserSdkLoaderOptions,
          azureMonitor.browserSdkLoaderOptions,
        );
        this.enableLiveMetrics =
          azureMonitor.enableLiveMetrics !== undefined
            ? azureMonitor.enableLiveMetrics
            : this.enableLiveMetrics;
        this.enableStandardMetrics =
          azureMonitor.enableStandardMetrics !== undefined
            ? azureMonitor.enableStandardMetrics
            : this.enableStandardMetrics;
        this.enableTraceBasedSamplingForLogs =
          azureMonitor.enableTraceBasedSamplingForLogs !== undefined
            ? azureMonitor.enableTraceBasedSamplingForLogs
            : this.enableTraceBasedSamplingForLogs;
        this.enablePerformanceCounters =
          azureMonitor.enablePerformanceCounters !== undefined
            ? azureMonitor.enablePerformanceCounters
            : this.enablePerformanceCounters;
      }
    }
    // JSON configuration will take precedence over options provided
    this._mergeJsonConfig();
    // ENV configuration will take precedence over other configurations
    this._mergeEnvConfig();
  }

  private _mergeEnvConfig(): void {
    const envConfig = EnvConfig.getInstance();
    this.samplingRatio =
      envConfig.samplingRatio !== undefined ? envConfig.samplingRatio : this.samplingRatio;
    this.tracesPerSecond =
      envConfig.tracesPerSecond !== undefined ? envConfig.tracesPerSecond : this.tracesPerSecond;
    this.sampler = envConfig.sampler ?? this.sampler;
  }

  private _mergeJsonConfig(): void {
    try {
      const jsonConfig = JsonConfig.getInstance();
      // Global options
      this.samplingRatio =
        jsonConfig.samplingRatio !== undefined ? jsonConfig.samplingRatio : this.samplingRatio;
      this.tracesPerSecond =
        jsonConfig.tracesPerSecond !== undefined
          ? jsonConfig.tracesPerSecond
          : this.tracesPerSecond;
      this.instrumentationOptions = Object.assign(
        this.instrumentationOptions,
        jsonConfig.instrumentationOptions,
      );
      // Azure Monitor-scoped options
      const azureMonitor = jsonConfig.azureMonitor;
      if (azureMonitor) {
        this.browserSdkLoaderOptions = Object.assign(
          this.browserSdkLoaderOptions,
          azureMonitor.browserSdkLoaderOptions,
        );
        this.enableLiveMetrics =
          azureMonitor.enableLiveMetrics !== undefined
            ? azureMonitor.enableLiveMetrics
            : this.enableLiveMetrics;
        this.enableStandardMetrics =
          azureMonitor.enableStandardMetrics !== undefined
            ? azureMonitor.enableStandardMetrics
            : this.enableStandardMetrics;
        this.enableTraceBasedSamplingForLogs =
          azureMonitor.enableTraceBasedSamplingForLogs !== undefined
            ? azureMonitor.enableTraceBasedSamplingForLogs
            : this.enableTraceBasedSamplingForLogs;
        this.azureMonitorExporterOptions = Object.assign(
          this.azureMonitorExporterOptions,
          azureMonitor.azureMonitorExporterOptions,
        );
      }
    } catch (error) {
      Logger.getInstance().error("Failed to load JSON config file values.", error);
    }
  }

  private _setDefaultResource(): void {
    let resource = defaultResource();
    // Load resource attributes from env
    const detectResourceConfig: ResourceDetectionConfig = {
      detectors: [envDetector],
    };
    const envResource = detectResources(detectResourceConfig);
    resource = resource.merge(envResource);

    // Load resource attributes from Azure
    const azureResource: Resource = detectResources({
      detectors: [azureAksDetector, azureAppServiceDetector, azureFunctionsDetector],
    });
    this._resource = resource.merge(azureResource);

    // Handle VM resource detection asynchronously to avoid warnings
    // about accessing resource attributes before async attributes are settled
    this._initializeVmResourceAsync();
  }

  /**
   * Initialize VM resource detection asynchronously to avoid warnings
   * about accessing resource attributes before async attributes settle
   */
  private _initializeVmResourceAsync(): void {
    const vmResource = detectResources({
      detectors: [azureVmDetector],
    });

    // Don't wait for VM resource detection to complete during initialization
    // This prevents warnings about accessing resource attributes before async attributes are settled
    if (vmResource.asyncAttributesPending) {
      void vmResource
        .waitForAsyncAttributes?.()
        .then(() => {
          this._resource = this._resource.merge(vmResource);
          return;
        })
        .catch(() => {
          // Silently ignore VM detection errors to avoid unnecessary warnings
          // VM detection is optional and failures shouldn't impact core functionality
        });
    } else {
      // If VM detection completed synchronously, merge immediately
      this._resource = this._resource.merge(vmResource);
    }
  }

  public calculateMetricExportInterval(options?: { collectionInterval: number }): number {
    const defaultInterval = 60000; // 60 seconds

    // Prioritize OTEL_METRIC_EXPORT_INTERVAL env var
    if (process.env.OTEL_METRIC_EXPORT_INTERVAL) {
      const envInterval = parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL.trim(), 10);
      if (!isNaN(envInterval) && envInterval > 0) {
        return envInterval;
      }
    }

    // Then use options if provided
    if (options?.collectionInterval) {
      return options.collectionInterval;
    }

    // Default fallback
    return defaultInterval;
  }
}
