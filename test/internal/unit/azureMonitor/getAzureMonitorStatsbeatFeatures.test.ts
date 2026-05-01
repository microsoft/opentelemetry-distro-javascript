// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { InternalConfig } from "../../../../src/shared/config.js";
import { getAzureMonitorStatsbeatFeatures } from "../../../../src/azureMonitor/index.js";
import { SEMRESATTRS_K8S_CLUSTER_NAME } from "@opentelemetry/semantic-conventions";
import { resourceFromAttributes } from "@opentelemetry/resources";

describe("getAzureMonitorStatsbeatFeatures", () => {
  it("should return browserSdkLoader true when enabled in config", () => {
    const config = new InternalConfig();
    config.browserSdkLoaderOptions.enabled = true;

    const features = getAzureMonitorStatsbeatFeatures(config);
    expect(features.browserSdkLoader).toBe(true);
  });

  it("should return browserSdkLoader false when disabled in config", () => {
    const config = new InternalConfig();
    config.browserSdkLoaderOptions.enabled = false;

    const features = getAzureMonitorStatsbeatFeatures(config);
    expect(features.browserSdkLoader).toBe(false);
  });

  it("should return aadHandling true when credential is provided", () => {
    const config = new InternalConfig();
    config.azureMonitorExporterOptions.credential = {
      getToken: () => Promise.resolve({ token: "test", expiresOnTimestamp: Date.now() + 10000 }),
    };

    const features = getAzureMonitorStatsbeatFeatures(config);
    expect(features.aadHandling).toBe(true);
  });

  it("should return aadHandling false when no credential is provided", () => {
    const config = new InternalConfig();

    const features = getAzureMonitorStatsbeatFeatures(config);
    expect(features.aadHandling).toBe(false);
  });

  it("should return diskRetry true when disableOfflineStorage is falsy", () => {
    const config = new InternalConfig();

    const features = getAzureMonitorStatsbeatFeatures(config);
    expect(features.diskRetry).toBe(true);
  });

  it("should return diskRetry false when disableOfflineStorage is true", () => {
    const config = new InternalConfig();
    config.azureMonitorExporterOptions.disableOfflineStorage = true;

    const features = getAzureMonitorStatsbeatFeatures(config);
    expect(features.diskRetry).toBe(false);
  });

  it("should detect AKS resource when k8s.cluster.name attribute is present", () => {
    const config = new InternalConfig();
    config.resource = resourceFromAttributes({
      [SEMRESATTRS_K8S_CLUSTER_NAME]: "my-cluster",
    });

    const features = getAzureMonitorStatsbeatFeatures(config);
    expect(features.aksResourceDetectorPopulation).toBe(true);
  });

  it("should not detect AKS resource when no k8s attributes are present", () => {
    const config = new InternalConfig();

    const features = getAzureMonitorStatsbeatFeatures(config);
    expect(features.aksResourceDetectorPopulation).toBe(false);
  });
});
