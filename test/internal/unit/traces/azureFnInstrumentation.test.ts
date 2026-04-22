// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AzureFunctionsInstrumentation } from "@azure/functions-opentelemetry-instrumentation";
import { TraceHandler } from "../../../../src/azureMonitor/traces/index.js";
import { InternalConfig } from "../../../../src/shared/index.js";
import { MetricHandler } from "../../../../src/azureMonitor/metrics/index.js";
import { metrics, trace } from "@opentelemetry/api";
import { describe, it, beforeEach, afterEach, assert } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
} from "../../../../src/distro/distro.js";

describe("Library/AzureFunctionsInstrumentation", () => {
  let metricHandler: MetricHandler;
  let handler: TraceHandler;

  afterEach(async () => {
    if (metricHandler) {
      await metricHandler.shutdown();
    }
    if (handler) {
      await handler.shutdown();
    }
    metrics.disable();
    trace.disable();
    await shutdownMicrosoftOpenTelemetry();
  });

  beforeEach(() => {
    useMicrosoftOpenTelemetry({
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333;",
        },
      },
    });
  });

  it("AzureFunctionsInstrumentation is included by default", () => {
    const config = new InternalConfig({
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333;",
        },
      },
    });
    metricHandler = new MetricHandler(config);
    handler = new TraceHandler(config, metricHandler);
    const instrumentations = handler.getInstrumentations();
    const azureFnInstrumentation = instrumentations.find(
      (i) => i instanceof AzureFunctionsInstrumentation,
    );
    assert.isDefined(azureFnInstrumentation, "AzureFunctionsInstrumentation should be registered");
  });
});
