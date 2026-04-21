// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from "node:fs";
import path from "node:path";
import type {
  AzureMonitorOpenTelemetryOptions,
  BrowserSdkLoaderOptions,
  InstrumentationOptions,
} from "../types.js";
import type { A365Options } from "../a365/index.js";
import type { AzureMonitorExporterOptions } from "@azure/monitor-opentelemetry-exporter";
import type { MicrosoftOpenTelemetryOptions } from "../types.js";
import { Logger } from "./logging/index.js";
import { dirName } from "./module.js";

/**
 * Walk up from a starting directory until a directory containing package.json is found.
 * Falls back to the starting directory if no package.json is located.
 * @internal
 */
function findPackageRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding package.json
      return startDir;
    }
    current = parent;
  }
}

const ENV_CONFIGURATION_FILE = "APPLICATIONINSIGHTS_CONFIGURATION_FILE";
const ENV_CONTENT = "APPLICATIONINSIGHTS_CONFIGURATION_CONTENT";

/**
 * Azure Monitor OpenTelemetry Client Configuration through JSON File.
 *
 * Implements {@link MicrosoftOpenTelemetryOptions}.
 * Azure Monitor-specific fields are grouped under `azureMonitor`.
 * The JSON file format remains flat for backward compatibility; the constructor
 * maps the flat structure to the nested shape.
 * @internal
 */
export class JsonConfig implements MicrosoftOpenTelemetryOptions {
  /** The rate of telemetry items tracked that should be transmitted (Default 1.0) */
  public samplingRatio?: number;
  /** The maximum number of spans to sample per second. */
  public tracesPerSecond?: number;
  /**
   * OpenTelemetry Instrumentations configuration included as part of Azure Monitor (azureSdk, http, mongoDb, mySql, postgreSql, redis, redis4)
   */
  public instrumentationOptions?: InstrumentationOptions;
  /** Azure Monitor scoped options */
  public azureMonitor?: AzureMonitorOpenTelemetryOptions;
  /** A365 scoped options */
  public a365?: A365Options;

  private static _instance: JsonConfig;

  private _tempDir: string;

  /** Get Singleton instance */
  public static getInstance(): JsonConfig {
    if (!JsonConfig._instance) {
      JsonConfig._instance = new JsonConfig();
    }
    return JsonConfig._instance;
  }

  /**
   * Initializes a new instance of the JsonConfig class.
   */
  constructor() {
    let jsonString = "";
    this._tempDir = "";
    const contentJsonConfig = process.env[ENV_CONTENT];
    // JSON string added directly in env variable
    if (contentJsonConfig) {
      jsonString = contentJsonConfig;
    }
    // JSON file
    else {
      const configFileName = "applicationinsights.json";
      const rootPath = findPackageRoot(dirName());
      this._tempDir = path.join(rootPath, configFileName); // default
      const configFile = process.env[ENV_CONFIGURATION_FILE];
      if (configFile) {
        if (path.isAbsolute(configFile)) {
          this._tempDir = configFile;
        } else {
          this._tempDir = path.join(rootPath, configFile); // Relative path to applicationinsights folder
        }
      }
      try {
        jsonString = fs.readFileSync(this._tempDir, "utf8");
      } catch (err) {
        Logger.getInstance().info("Failed to read JSON config file: ", err);
      }
    }
    try {
      const jsonConfig = JSON.parse(jsonString) as Record<string, unknown>;
      // Global options
      this.samplingRatio = jsonConfig.samplingRatio as number | undefined;
      this.tracesPerSecond = jsonConfig.tracesPerSecond as number | undefined;
      this.instrumentationOptions = jsonConfig.instrumentationOptions as
        | InstrumentationOptions
        | undefined;
      // Azure Monitor-scoped options (flat JSON → nested structure)
      this.azureMonitor = {
        azureMonitorExporterOptions: jsonConfig.azureMonitorExporterOptions as
          | AzureMonitorExporterOptions
          | undefined,
        browserSdkLoaderOptions: jsonConfig.browserSdkLoaderOptions as
          | BrowserSdkLoaderOptions
          | undefined,
        enableLiveMetrics: jsonConfig.enableLiveMetrics as boolean | undefined,
        enableStandardMetrics: jsonConfig.enableStandardMetrics as boolean | undefined,
        enableTraceBasedSamplingForLogs: jsonConfig.enableTraceBasedSamplingForLogs as
          | boolean
          | undefined,
      };
      // A365-scoped options
      if (jsonConfig.a365 && typeof jsonConfig.a365 === "object") {
        this.a365 = jsonConfig.a365 as A365Options;
      }
    } catch (err) {
      Logger.getInstance().info("Missing or invalid JSON config file: ", err);
    }
  }
}
