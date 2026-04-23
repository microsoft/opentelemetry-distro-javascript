// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { InternalConfig } from "../../../../src/shared/index.js";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  CloudPlatformValues,
  SemanticResourceAttributes,
} from "@opentelemetry/semantic-conventions";
import type { MicrosoftOpenTelemetryOptions } from "../../../../src/types.js";
import type { MockInstance } from "vitest";
import { assert, expect, afterEach, describe, it, vi, beforeEach } from "vitest";
import { azureVmDetector } from "@opentelemetry/resource-detector-azure";

const testAttributes: Record<string, string> = {
  "azure.vm.scaleset.name": "crpteste9vflji9",
  "azure.vm.sku": "2019-Datacenter",
  "cloud.platform": "azure_vm",
  "cloud.provider": "azure",
  "cloud.region": "westus",
  "cloud.resource_id":
    "/subscriptions/xxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxx/resourceGroups/macikgo-test-may-23/providers/Microsoft.Compute/virtualMachines/examplevmname",
  "host.id": "02aab8a4-74ef-476e-8182-f6d2ba4166a6",
  "host.name": "examplevmname",
  "host.type": "Standard_A3",
  "os.type": "Windows",
  "os.version": "20.04.202307240",
  "service.instance.id": "02aab8a4-74ef-476e-8182-f6d2ba4166a6",
  "service.name": `unknown_service:${process.argv0}`, // Match OTel's default
  "telemetry.sdk.language": "nodejs",
  "telemetry.sdk.name": "opentelemetry",
  "telemetry.sdk.version": "2.0.0",
};

describe("Library/Config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("#constructor", () => {
    it("merge programmatic options", () => {
      const options: MicrosoftOpenTelemetryOptions = {
        samplingRatio: 0.3,
        tracesPerSecond: 0.2,
        instrumentationOptions: {
          azureSdk: { enabled: true },
          mongoDb: { enabled: true },
          mySql: { enabled: true },
          postgreSql: { enabled: true },
          redis: { enabled: true },
          redis4: { enabled: true },
        },
        azureMonitor: {
          azureMonitorExporterOptions: {
            connectionString:
              "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333;IngestionEndpoint=https://centralus-0.in.applicationinsights.azure.com/",
            disableOfflineStorage: true,
            storageDirectory: "testPath",
          },
        },
      };
      const mergedConfig = new InternalConfig(options);
      assert.deepStrictEqual(
        mergedConfig.azureMonitorExporterOptions.connectionString,
        "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333;IngestionEndpoint=https://centralus-0.in.applicationinsights.azure.com/",
      );
      assert.deepStrictEqual(mergedConfig.samplingRatio, 0.3, "Wrong samplingRatio");
      assert.deepStrictEqual(mergedConfig.tracesPerSecond, 0.2, "Wrong tracesPerSecond");
      assert.deepStrictEqual(
        mergedConfig.azureMonitorExporterOptions?.disableOfflineStorage,
        true,
        "Wrong disableOfflineStorage",
      );
      assert.deepStrictEqual(
        mergedConfig.azureMonitorExporterOptions?.storageDirectory,
        "testPath",
        "Wrong storageDirectory",
      );
      assert.deepStrictEqual(
        mergedConfig.instrumentationOptions.azureSdk?.enabled,
        true,
        "Wrong azureSdk",
      );
      assert.deepStrictEqual(
        mergedConfig.instrumentationOptions.mongoDb?.enabled,
        true,
        "Wrong mongoDb",
      );
      assert.deepStrictEqual(
        mergedConfig.instrumentationOptions.mySql?.enabled,
        true,
        "Wrong mySql",
      );
      assert.deepStrictEqual(
        mergedConfig.instrumentationOptions.postgreSql?.enabled,
        true,
        "Wrong postgreSql",
      );
      assert.deepStrictEqual(
        mergedConfig.instrumentationOptions.redis?.enabled,
        true,
        "Wrong redis",
      );
      assert.deepStrictEqual(
        mergedConfig.instrumentationOptions.redis4?.enabled,
        true,
        "Wrong redis4",
      );
    });

    it("programmatic options take precedence over defaults", () => {
      const options: MicrosoftOpenTelemetryOptions = {
        samplingRatio: 0.6,
        tracesPerSecond: 4.5,
        instrumentationOptions: {
          http: { enabled: false },
          azureSdk: { enabled: false },
          mongoDb: { enabled: false },
          mySql: { enabled: false },
          postgreSql: { enabled: false },
          redis: { enabled: false },
          redis4: { enabled: false },
        },
        azureMonitor: {
          azureMonitorExporterOptions: {
            connectionString: "testConnStringOther",
            storageDirectory: "teststorageDirectoryOther",
            disableOfflineStorage: false,
          },
        },
      };

      const config = new InternalConfig(options);
      assert.strictEqual(config.samplingRatio, 0.6);
      assert.strictEqual(config.tracesPerSecond, 4.5);
      assert.strictEqual(config.instrumentationOptions?.http?.enabled, false);
      assert.strictEqual(config.instrumentationOptions?.azureSdk?.enabled, false);
      assert.strictEqual(config.instrumentationOptions?.mongoDb?.enabled, false);
      assert.strictEqual(config.instrumentationOptions?.mySql?.enabled, false);
      assert.strictEqual(config.instrumentationOptions?.postgreSql?.enabled, false);
      assert.strictEqual(config.instrumentationOptions?.redis?.enabled, false);
      assert.strictEqual(config.instrumentationOptions?.redis4?.enabled, false);
      assert.strictEqual(
        config.azureMonitorExporterOptions?.connectionString,
        "testConnStringOther",
      );
      assert.strictEqual(
        config.azureMonitorExporterOptions?.storageDirectory,
        "teststorageDirectoryOther",
      );
      assert.strictEqual(config.azureMonitorExporterOptions?.disableOfflineStorage, false);
    });

    it("Default config", () => {
      const config = new InternalConfig();
      assert.deepStrictEqual(config.samplingRatio, 1, "Wrong samplingRatio");
      assert.deepStrictEqual(config.tracesPerSecond, 5, "Wrong tracesPerSecond");
      assert.deepStrictEqual(
        config.instrumentationOptions.azureSdk?.enabled,
        true,
        "Wrong azureSdk",
      );
      assert.deepStrictEqual(config.instrumentationOptions.mongoDb?.enabled, true, "Wrong mongoDb");
      assert.deepStrictEqual(config.instrumentationOptions.mySql?.enabled, true, "Wrong mySql");
      assert.deepStrictEqual(
        config.instrumentationOptions.postgreSql?.enabled,
        true,
        "Wrong postgreSql",
      );
      assert.deepStrictEqual(config.instrumentationOptions.redis?.enabled, true, "Wrong redis");
      assert.deepStrictEqual(config.instrumentationOptions.redis4?.enabled, true, "Wrong redis4");
      assert.deepStrictEqual(
        config.azureMonitorExporterOptions?.disableOfflineStorage,
        undefined,
        "Wrong disableOfflineStorage",
      );
      assert.deepStrictEqual(
        config.azureMonitorExporterOptions?.storageDirectory,
        undefined,
        "Wrong storageDirectory",
      );
    });

    it("microsoft.rate_limited without arg keeps default tracesPerSecond=5 in InternalConfig", () => {
      vi.stubEnv("OTEL_TRACES_SAMPLER", "microsoft.rate_limited");

      const config = new InternalConfig();

      assert.strictEqual(config.tracesPerSecond, 5, "Wrong tracesPerSecond");
      assert.strictEqual(config.samplingRatio, 1, "Wrong samplingRatio");
    });

    it("Partial configurations are supported", () => {
      const options: MicrosoftOpenTelemetryOptions = {
        samplingRatio: 0.7,
        instrumentationOptions: {
          http: { enabled: false },
          redis4: { enabled: false },
        },
        azureMonitor: {
          azureMonitorExporterOptions: {
            connectionString: "testConnectionString",
            storageDirectory: "teststorageDirectory",
          },
        },
      };

      const config = new InternalConfig(options);
      assert.deepStrictEqual(config.samplingRatio, 0.7, "Wrong samplingRatio");
      assert.deepStrictEqual(
        config.azureMonitorExporterOptions?.storageDirectory,
        "teststorageDirectory",
        "Wrong storageDirectory",
      );
      assert.deepStrictEqual(
        config.azureMonitorExporterOptions?.connectionString,
        "testConnectionString",
        "Wrong connectionString",
      );
      assert.deepStrictEqual(config.instrumentationOptions.http?.enabled, false, "Wrong http");
      assert.deepStrictEqual(config.instrumentationOptions.redis4?.enabled, false, "Wrong redis4");

      // Default values
      assert.deepStrictEqual(
        config.instrumentationOptions.azureSdk?.enabled,
        true,
        "Wrong azureSdk",
      );
      assert.deepStrictEqual(config.instrumentationOptions.mongoDb?.enabled, true, "Wrong mongoDb");
      assert.deepStrictEqual(config.instrumentationOptions.mySql?.enabled, true, "Wrong mySql");
      assert.deepStrictEqual(
        config.instrumentationOptions.postgreSql?.enabled,
        true,
        "Wrong postgreSql",
      );
      assert.deepStrictEqual(config.instrumentationOptions.redis?.enabled, true, "Wrong redis");
    });
  });

  describe("constructor", () => {
    let warnStub: MockInstance;
    beforeEach(() => {
      warnStub = vi.spyOn(console, "warn");
    });

    it("should initialize valid values", () => {
      const config = new InternalConfig();
      config.azureMonitorExporterOptions.connectionString =
        "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
      assert.equal(typeof config.azureMonitorExporterOptions?.connectionString, "string");
      assert.equal(typeof config.samplingRatio, "number");
    });

    it("should accept zero sampling ratio", () => {
      const config = new InternalConfig();
      config.samplingRatio = 0;
      assert.strictEqual(config.samplingRatio, 0);
    });

    it("should merge azure monitor connection string from options", () => {
      const config = new InternalConfig({
        azureMonitor: {
          azureMonitorExporterOptions: {
            connectionString: "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333",
          },
        },
      });
      assert.strictEqual(
        config.azureMonitorExporterOptions.connectionString,
        "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333",
      );
    });

    // TODO: these tests are incorrect on main
    // as they call `assert.ok(warnStub.calledOn)`
    // and since `calledOn` is a function, it is always truthy.
    // When changed to `assert.ok(warnStub.calledOnce) it fails on main
    it.todo("instrumentation key validation-invalid key passed", () => {
      new InternalConfig({
        azureMonitor: {
          azureMonitorExporterOptions: {
            connectionString: "InstrumentationKey=1aa11111bbbb1ccc8dddeeeeffff3333",
          },
        },
      });
      expect(warnStub).toHaveBeenCalled();
    });

    it.todo("instrumentation key validation-invalid key passed", () => {
      new InternalConfig({
        azureMonitor: {
          azureMonitorExporterOptions: {
            connectionString: "abc",
          },
        },
      });
      expect(warnStub).toHaveBeenCalled();
    });
  });
});

describe("OpenTelemetry Resource", () => {
  it("should allow custom resource to be configured", () => {
    const customAttributes: any = {};
    customAttributes[SemanticResourceAttributes.SERVICE_NAME] = "testServiceName";
    customAttributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID] = "testServiceInstanceId";
    customAttributes[SemanticResourceAttributes.CONTAINER_ID] = "testContainerId";
    const customResource = resourceFromAttributes(customAttributes);
    const config = new InternalConfig();
    config.resource = customResource;
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.SERVICE_NAME],
      "testServiceName",
    );
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID],
      "testServiceInstanceId",
    );
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.CONTAINER_ID],
      "testContainerId",
    );
  });

  it("Default values", () => {
    const config = new InternalConfig();
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.TELEMETRY_SDK_NAME],
      "opentelemetry",
    );
    assert.isTrue(
      String(config.resource.attributes[SemanticResourceAttributes.SERVICE_NAME]).startsWith(
        "unknown_service:",
      ),
      "Wrong SERVICE_NAME",
    );
    assert.isTrue(
      String(config.resource.attributes[SemanticResourceAttributes.TELEMETRY_SDK_VERSION]).length >
        0,
      "Wrong TELEMETRY_SDK_VERSION",
    );
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID],
      undefined,
    );
  });

  it("Azure App Service resource attributes", () => {
    const env = <{ [id: string]: string }>{};
    const originalEnv = process.env;
    env.WEBSITE_SITE_NAME = "test-site";
    env.REGION_NAME = "test-region";
    env.WEBSITE_SLOT_NAME = "test-slot";
    env.WEBSITE_HOSTNAME = "test-hostname";
    env.WEBSITE_INSTANCE_ID = "test-instance-id";
    env.WEBSITE_HOME_STAMPNAME = "test-home-stamp";
    env.WEBSITE_OWNER_NAME = "test-owner-name";
    process.env = env;
    const config = new InternalConfig();
    process.env = originalEnv;
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.TELEMETRY_SDK_NAME],
      "opentelemetry",
    );
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.SERVICE_NAME],
      "test-site",
    );
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID],
      "test-instance-id",
    );
    assert.strictEqual(
      config.resource.attributes[SemanticResourceAttributes.CLOUD_PROVIDER],
      "azure",
    );
    assert.strictEqual(
      config.resource.attributes[SemanticResourceAttributes.CLOUD_REGION],
      "test-region",
    );
    assert.strictEqual(config.resource.attributes["deployment.environment.name"], "test-slot");
    assert.strictEqual(
      config.resource.attributes[SemanticResourceAttributes.HOST_ID],
      "test-hostname",
    );
    assert.strictEqual(config.resource.attributes["azure.app.service.stamp"], "test-home-stamp");
  });

  it("Azure Functions resource attributes", () => {
    const env = <{ [id: string]: string }>{};
    const originalEnv = process.env;
    env.WEBSITE_SITE_NAME = "test-site";
    env.REGION_NAME = "test-region";
    env.WEBSITE_MEMORY_LIMIT_MB = "512";
    env.FUNCTIONS_EXTENSION_VERSION = "~3";
    process.env = env;
    const config = new InternalConfig();
    process.env = originalEnv;
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.TELEMETRY_SDK_NAME],
      "opentelemetry",
    );
    assert.strictEqual(
      config.resource.attributes[SemanticResourceAttributes.CLOUD_PROVIDER],
      "azure",
    );
    assert.strictEqual(
      config.resource.attributes[SemanticResourceAttributes.CLOUD_REGION],
      "test-region",
    );
    assert.strictEqual(
      config.resource.attributes[SemanticResourceAttributes.FAAS_MAX_MEMORY],
      "512",
    );
    assert.strictEqual(
      config.resource.attributes[SemanticResourceAttributes.SERVICE_NAME],
      "test-site",
    );
  });

  it("Azure AKS resource attributes", () => {
    const env = <{ [id: string]: string }>{};
    const originalEnv = process.env;
    env.CLUSTER_RESOURCE_ID =
      "/subscriptions/xxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxx/resourceGroups/test-rg/providers/Microsoft.ContainerService/managedClusters/test-cluster";
    process.env = env;
    const config = new InternalConfig();
    process.env = originalEnv;
    assert.strictEqual(
      config.resource.attributes[SemanticResourceAttributes.CLOUD_PROVIDER],
      "azure",
    );
    assert.strictEqual(
      config.resource.attributes[SemanticResourceAttributes.CLOUD_PLATFORM],
      "azure.aks",
    );
    assert.strictEqual(
      config.resource.attributes[SemanticResourceAttributes.K8S_CLUSTER_NAME],
      "test-cluster",
    );
  });

  it("Azure VM resource attributes", () => {
    vi.spyOn(azureVmDetector, "detect").mockResolvedValue(resourceFromAttributes(testAttributes));
    const config = new InternalConfig();
    assert.isDefined(config);

    // Wait for the async VM resource detector to finish (ensure detect is called)
    setTimeout(() => {
      for (let i = 0; i < Object.keys(config.resource.attributes).length; i++) {
        const key = Object.keys(config.resource.attributes)[i];
        assert.strictEqual(config.resource.attributes[key], testAttributes[key]);
      }
      assert.strictEqual(
        config.resource.attributes[SemanticResourceAttributes.CLOUD_PROVIDER],
        "azure",
      );
      assert.strictEqual(
        config.resource.attributes[SemanticResourceAttributes.CLOUD_REGION],
        "westus",
      );
      assert.strictEqual(
        config.resource.attributes[SemanticResourceAttributes.CLOUD_PLATFORM],
        CloudPlatformValues.AZURE_VM,
      );
    }, 1000);
  });

  it("OTEL_RESOURCE_ATTRIBUTES", () => {
    vi.stubEnv(
      "OTEL_RESOURCE_ATTRIBUTES",
      "service.name=testServiceName,service.instance.id=testServiceInstance,k8s.cluster.name=testClusterName,k8s.node.name=testNodeName",
    );

    const config = new InternalConfig();
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.SERVICE_NAME],
      "testServiceName",
    );
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID],
      "testServiceInstance",
    );
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.K8S_CLUSTER_NAME],
      "testClusterName",
    );
    assert.deepStrictEqual(
      config.resource.attributes[SemanticResourceAttributes.K8S_NODE_NAME],
      "testNodeName",
    );
  });
});
