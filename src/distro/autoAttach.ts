// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// TODO: Enable auto-attach warning once the distro supports auto-instrumentation scenarios
// (App Service, AKS, etc.). The logic below detects when Azure Monitor automatic
// instrumentation may already be active and warns about double instrumentation.

import { AZURE_MONITOR_AUTO_ATTACH } from "../types.js";
import { isFunctionApp } from "../utils/common.js";
import { Logger } from "../shared/logging/index.js";

/**
 * Check if auto-attach (autoinstrumentation) is enabled and warn about double instrumentation.
 * @internal
 */
export function sendAttachWarning(): void {
  if (process.env[AZURE_MONITOR_AUTO_ATTACH] === "true" && !isFunctionApp()) {
    // TODO: When AKS attach is public, update this message with disablement instructions for AKS
    const message =
      "Distro detected that automatic instrumentation may have occurred. Only use autoinstrumentation if you " +
      "are not using manual instrumentation of OpenTelemetry in your code, such as with " +
      "@azure/monitor-opentelemetry or @azure/monitor-opentelemetry-exporter. For App Service resources, disable " +
      "autoinstrumentation in the Application Insights experience on your App Service resource or by setting " +
      "the ApplicationInsightsAgent_EXTENSION_VERSION app setting to 'disabled'.";
    // Surface in the log stream
    console.warn(message);
    // Also log via diagnostic logging
    Logger.getInstance().warn(message);
  }
}
