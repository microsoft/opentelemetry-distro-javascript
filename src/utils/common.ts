// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import type { ResourceDetector } from "@opentelemetry/resources";
import {
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
  serviceInstanceIdDetector,
} from "@opentelemetry/resources";
import { diag } from "@opentelemetry/api";
import {
  azureAksDetector,
  azureAppServiceDetector,
  azureFunctionsDetector,
  azureVmDetector,
} from "@opentelemetry/resource-detector-azure";

export const isFunctionApp = (): boolean => {
  return process.env.FUNCTIONS_WORKER_RUNTIME ? true : false;
};

// This function is a slight modification of an upstream otel util function -
// mainly for prioritizing the resource detectors customer may specify over
// env var & not enabling process detector by default.
export function parseResourceDetectorsFromEnvVar(): Array<ResourceDetector> {
  const resourceDetectors = new Map<string, ResourceDetector>([
    ["env", envDetector],
    ["host", hostDetector],
    ["os", osDetector],
    ["process", processDetector],
    ["serviceinstance", serviceInstanceIdDetector],
    ["azure_aks", azureAksDetector],
    ["azure_app_service", azureAppServiceDetector],
    ["azure_functions", azureFunctionsDetector],
    ["azure_vm", azureVmDetector],
  ]);

  if (process.env.OTEL_NODE_RESOURCE_DETECTORS != null) {
    const resourceDetectorsFromEnv = process.env.OTEL_NODE_RESOURCE_DETECTORS?.split(",") ?? [
      "env",
      "host",
      "os",
    ];

    if (resourceDetectorsFromEnv.includes("all")) {
      return [...resourceDetectors.values()];
    }

    if (resourceDetectorsFromEnv.includes("none")) {
      return [];
    }

    return resourceDetectorsFromEnv.flatMap((detector) => {
      const resourceDetector = resourceDetectors.get(detector);
      if (!resourceDetector) {
        diag.error(
          `Invalid resource detector "${detector}" specified in the environment variable OTEL_NODE_RESOURCE_DETECTORS`,
        );
        return [];
      }
      return [resourceDetector];
    });
  } else {
    // leaving out the process and host detectors as they can add many resource attributes
    // with large values. Also not enabling service instance attributes by default
    // as this is still experimental.
    return [envDetector, osDetector];
  }
}
