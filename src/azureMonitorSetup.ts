// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Azure Monitor–specific initialization that runs alongside the distro.
 * Statsbeat, Browser SDK Loader, and Live Metrics SDK prefix are
 * Azure Monitor concerns — not part of the generic OTel distro lifecycle.
 */

import type { InternalConfig } from "./shared/config.js";
import type { StatsbeatFeatures, StatsbeatInstrumentations } from "./types.js";
import { APPLICATIONINSIGHTS_SDKSTATS_DISABLED } from "./types.js";
import { BrowserSdkLoader } from "./browserSdkLoader/browserSdkLoader.js";
import { setSdkPrefix } from "./metrics/quickpulse/utils.js";
import { getInstance } from "./utils/statsbeat.js";
import { SEMRESATTRS_K8S_CLUSTER_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Semantic attribute for cloud resource ID, defined by \@opentelemetry/resource-detector-azure
 * @internal
 */
const CLOUD_RESOURCE_ID_ATTRIBUTE = "cloud.resource_id";

/**
 * Set up Azure Monitor–specific components (statsbeat, browser SDK loader,
 * live-metrics SDK prefix). Returns a dispose callback for shutdown.
 *
 * @internal
 */
export function setupAzureMonitorComponents(config: InternalConfig): () => void {
  // ── Statsbeat ─────────────────────────────────────────────────────
  const statsbeatInstrumentations: StatsbeatInstrumentations = {
    azureSdk: config.instrumentationOptions?.azureSdk?.enabled,
    mongoDb: config.instrumentationOptions?.mongoDb?.enabled,
    mySql: config.instrumentationOptions?.mySql?.enabled,
    postgreSql: config.instrumentationOptions?.postgreSql?.enabled,
    redis: config.instrumentationOptions?.redis?.enabled,
    bunyan: config.instrumentationOptions?.bunyan?.enabled,
    winston: config.instrumentationOptions?.winston?.enabled,
  };
  const resourceAttributes = config.resource.attributes;
  const aksResourceDetected =
    SEMRESATTRS_K8S_CLUSTER_NAME in resourceAttributes ||
    CLOUD_RESOURCE_ID_ATTRIBUTE in resourceAttributes;
  const statsbeatFeatures: StatsbeatFeatures = {
    browserSdkLoader: config.browserSdkLoaderOptions.enabled,
    aadHandling: !!config.azureMonitorExporterOptions?.credential,
    diskRetry: !config.azureMonitorExporterOptions?.disableOfflineStorage,
    customerSdkStats: process.env[APPLICATIONINSIGHTS_SDKSTATS_DISABLED]?.toLowerCase() === "true",
    aksResourceDetectorPopulation: aksResourceDetected,
  };
  getInstance().setStatsbeatFeatures(statsbeatInstrumentations, statsbeatFeatures);

  // ── Browser SDK Loader ────────────────────────────────────────────
  let browserSdkLoader: BrowserSdkLoader | undefined;
  if (config.browserSdkLoaderOptions.enabled) {
    browserSdkLoader = new BrowserSdkLoader(config);
  }

  // ── Live Metrics SDK prefix ───────────────────────────────────────
  setSdkPrefix();

  // Return dispose callback for shutdown
  return () => {
    browserSdkLoader?.dispose();
  };
}
