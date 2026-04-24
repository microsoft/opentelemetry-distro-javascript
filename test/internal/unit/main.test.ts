// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Context, TracerProvider } from "@opentelemetry/api";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { MicrosoftOpenTelemetryOptions } from "../../../src/index.js";
import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
  _getSdkInstance,
} from "../../../src/distro/distro.js";
import type { MeterProvider, ViewOptions } from "@opentelemetry/sdk-metrics";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import type { StatsbeatEnvironmentConfig } from "../../../src/types.js";
import {
  AZURE_MONITOR_STATSBEAT_FEATURES,
  APPLICATIONINSIGHTS_SDKSTATS_DISABLED,
  StatsbeatFeature,
  StatsbeatInstrumentation,
  StatsbeatInstrumentationMap,
} from "../../../src/types.js";
import { getOsPrefix } from "../../../src/azureMonitor/utils/common.js";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import { getInstance } from "../../../src/azureMonitor/utils/statsbeat.js";
import type { Instrumentation, InstrumentationConfig } from "@opentelemetry/instrumentation";
import { describe, it, beforeEach, afterEach, expect, assert, vi, afterAll } from "vitest";

const testInstrumentation: Instrumentation = {
  instrumentationName: "@opentelemetry/instrumentation-fs",
  instrumentationVersion: "1.0",
  disable: function (): void {
    throw new Error("Function not implemented.");
  },
  enable: function (): void {
    throw new Error("Function not implemented.");
  },
  setTracerProvider: function (_tracerProvider: TracerProvider): void {
    throw new Error("Function not implemented.");
  },
  setMeterProvider: function (_meterProvider: MeterProvider): void {
    throw new Error("Function not implemented.");
  },
  setConfig: function (_config: InstrumentationConfig): void {
    throw new Error("Function not implemented.");
  },
  getConfig: function (): InstrumentationConfig {
    throw new Error("Function not implemented.");
  },
};

const GLOBAL_OPENTELEMETRY_API_KEY = Symbol.for("opentelemetry.js.api.1");

describe("Main functions", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let savedOTelGlobal: unknown;

  beforeEach(() => {
    originalEnv = process.env;
    // Preserve whatever the global OTel API object looks like before each test
    savedOTelGlobal = (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY];
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    // Restore the global OTel API object to avoid cross-test contamination
    if (savedOTelGlobal === undefined) {
      delete (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY];
    } else {
      (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY] = savedOTelGlobal;
    }
  });

  afterAll(() => {
    trace.disable();
    metrics.disable();
    logs.disable();
  });

  it("useMicrosoftOpenTelemetry", () => {
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    assert.isDefined(metrics.getMeterProvider());
    assert.isDefined(trace.getTracerProvider());
    assert.isDefined(logs.getLoggerProvider());
  });

  it("useMicrosoftOpenTelemetry should clear stale global API version before initializing", () => {
    (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY] = {
      version: "1.6.0",
    };
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    // After useMicrosoftOpenTelemetry, real (non-noop) providers should be registered
    const tracerProvider = trace.getTracerProvider();
    const tracer = tracerProvider.getTracer("test");
    // A noop tracer would return a span whose spanContext has an invalid (all-zero) traceId
    const span = tracer.startSpan("test-span");
    const { traceId } = span.spanContext();
    span.end();
    // A valid traceId is a 32-char hex string that is NOT all zeros
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(traceId).not.toBe("00000000000000000000000000000000");
  });

  it("useMicrosoftOpenTelemetry should handle stale global with a newer/future API version", () => {
    // Even if the stale version is higher than the current one, the mismatch still
    // causes registerGlobal() to fail. Our fix should handle any version mismatch.
    (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY] = {
      version: "2.99.0",
    };
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const tracer = trace.getTracerProvider().getTracer("test");
    const span = tracer.startSpan("test-future-version");
    const { traceId } = span.spanContext();
    span.end();
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(traceId).not.toBe("00000000000000000000000000000000");
  });

  it("useMicrosoftOpenTelemetry should work when no stale global exists", () => {
    // Regression: deleting a non-existent global key should not throw or break anything.
    delete (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY];
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const tracer = trace.getTracerProvider().getTracer("test");
    const span = tracer.startSpan("test-clean-state");
    const { traceId } = span.spanContext();
    span.end();
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(traceId).not.toBe("00000000000000000000000000000000");
  });

  it("useMicrosoftOpenTelemetry should work on repeated calls with stale globals", () => {
    // Simulate calling useMicrosoftOpenTelemetry twice — both should succeed even if
    // a stale global is re-injected between calls (e.g. another extension reloads).
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };

    // First call with stale global
    (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY] = {
      version: "1.6.0",
    };
    useMicrosoftOpenTelemetry(config);
    let tracer = trace.getTracerProvider().getTracer("test");
    let span = tracer.startSpan("test-first-call");
    let { traceId } = span.spanContext();
    span.end();
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(traceId).not.toBe("00000000000000000000000000000000");

    // Second call — re-inject stale global as if another extension re-registered
    (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY] = {
      version: "1.4.0",
    };
    useMicrosoftOpenTelemetry(config);
    tracer = trace.getTracerProvider().getTracer("test");
    span = tracer.startSpan("test-second-call");
    ({ traceId } = span.spanContext());
    span.end();
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(traceId).not.toBe("00000000000000000000000000000000");
  });

  it("should shutdown azureMonitor - sync", () => {
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    shutdownMicrosoftOpenTelemetry();
    const meterProvider = metrics.getMeterProvider() as MeterProvider;
    assert.strictEqual(meterProvider["_shutdown"], true);
  });

  it("should shutdown azureMonitor - async", async () => {
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    await shutdownMicrosoftOpenTelemetry();
    const meterProvider = metrics.getMeterProvider() as MeterProvider;
    assert.strictEqual(meterProvider["_shutdown"], true);
  });

  it("should add custom spanProcessors", () => {
    const processor: SpanProcessor = {
      forceFlush: () => {
        return Promise.resolve();
      },
      onStart: (_span: Span) => {
        /* no-op */
      },
      onEnd: (_span: ReadableSpan) => {
        /* no-op */
      },
      shutdown: () => {
        return Promise.resolve();
      },
    };
    const config: MicrosoftOpenTelemetryOptions = {
      spanProcessors: [processor],
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    // Verify the custom processor was added to the SDK configuration
    // by checking it's in the tracer provider's span processors
    const internalSdk = _getSdkInstance();
    const tracerProvider = (internalSdk as any)["_tracerProvider"];
    const activeSpanProcessor = tracerProvider["_activeSpanProcessor"];
    // The active span processor should be a MultiSpanProcessor containing our custom processor
    const spanProcessors = activeSpanProcessor["_spanProcessors"] || [activeSpanProcessor];
    const hasCustomProcessor = spanProcessors.some((sp: SpanProcessor) => sp === processor);
    expect(hasCustomProcessor).toBe(true);
  });

  it("should add custom logProcessors", () => {
    const processor: LogRecordProcessor = {
      forceFlush: () => {
        return Promise.resolve();
      },
      onEmit(_logRecord: SdkLogRecord, _context?: Context) {
        /* no-op */
      },
      shutdown: () => {
        return Promise.resolve();
      },
    };
    const spyonEmit = vi.spyOn(processor, "onEmit");
    const config: MicrosoftOpenTelemetryOptions = {
      logRecordProcessors: [processor],
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    logs.getLogger("testLogger").emit({ body: "testLog" });
    expect(spyonEmit).toHaveBeenCalled();
  });

  it("should add custom metric views", () => {
    const customView: ViewOptions = { meterName: "custom-meter" };
    const config: MicrosoftOpenTelemetryOptions = {
      views: [customView],
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);

    const meterConfig = (_getSdkInstance() as any)?._meterProviderConfig;
    expect(meterConfig).toBeDefined();
    expect(meterConfig?.views).toContain(customView);
  });

  it("should set statsbeat features", () => {
    const config: MicrosoftOpenTelemetryOptions = {
      instrumentationOptions: {
        azureSdk: {
          enabled: true,
        },
        mongoDb: {
          enabled: true,
        },
        mySql: {
          enabled: true,
        },
        postgreSql: {
          enabled: true,
        },
        redis: {
          enabled: true,
        },
      },
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
          disableOfflineStorage: true,
        },
        enableLiveMetrics: true,
      },
    };
    useMicrosoftOpenTelemetry(config);
    const output = JSON.parse(String(process.env["AZURE_MONITOR_STATSBEAT_FEATURES"]));
    const features = Number(output["feature"]);
    const instrumentations = Number(output["instrumentation"]);
    assert.notOk(features & StatsbeatFeature.AAD_HANDLING, "AAD_HANDLING is set");
    assert.notOk(features & StatsbeatFeature.DISK_RETRY, "DISK_RETRY is set");
    assert.notOk(features & StatsbeatFeature.BROWSER_SDK_LOADER, "BROWSER_SDK_LOADER is set");
    assert.ok(features & StatsbeatFeature.DISTRO, "DISTRO is not set");
    assert.strictEqual(features, 8);
    assert.ok(
      instrumentations & StatsbeatInstrumentation.AZURE_CORE_TRACING,
      "AZURE_CORE_TRACING not set",
    );
    assert.notOk(features & StatsbeatFeature.SHIM, "SHIM is set");
    assert.notOk(
      features & StatsbeatFeature.AKS_RESOURCE_DETECTOR_POPULATION,
      "AKS_RESOURCE_DETECTOR_POPULATION should not be set",
    );
    assert.ok(instrumentations & StatsbeatInstrumentation.MONGODB, "MONGODB not set");
    assert.ok(instrumentations & StatsbeatInstrumentation.MYSQL, "MYSQL not set");
    assert.ok(instrumentations & StatsbeatInstrumentation.POSTGRES, "POSTGRES not set");
    assert.ok(instrumentations & StatsbeatInstrumentation.REDIS, "REDIS not set");
    assert.strictEqual(instrumentations, 31);
  });

  it("should set shim feature in statsbeat if env var is populated", () => {
    getInstance()["initializedByShim"] = true;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const output = JSON.parse(String(process.env["AZURE_MONITOR_STATSBEAT_FEATURES"]));
    const features = Number(output["feature"]);
    assert.ok(features & StatsbeatFeature.SHIM, `SHIM is not set ${features}`);
  });

  it("should set AKS_RESOURCE_DETECTOR_POPULATION feature when AKS resource attributes are populated", () => {
    const env = <{ [id: string]: string }>{};
    env.CLUSTER_RESOURCE_ID =
      "/subscriptions/xxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxx/resourceGroups/test-rg/providers/Microsoft.ContainerService/managedClusters/test-cluster";
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const output = JSON.parse(String(process.env["AZURE_MONITOR_STATSBEAT_FEATURES"]));
    const features = Number(output["feature"]);
    assert.ok(
      features & StatsbeatFeature.AKS_RESOURCE_DETECTOR_POPULATION,
      `AKS_RESOURCE_DETECTOR_POPULATION is not set ${features}`,
    );
  });

  it("should not set AKS_RESOURCE_DETECTOR_POPULATION feature when not running in AKS", () => {
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const output = JSON.parse(String(process.env["AZURE_MONITOR_STATSBEAT_FEATURES"]));
    const features = Number(output["feature"]);
    assert.notOk(
      features & StatsbeatFeature.AKS_RESOURCE_DETECTOR_POPULATION,
      "AKS_RESOURCE_DETECTOR_POPULATION should not be set",
    );
  });

  it("should use statsbeat features if already available", () => {
    const env = <{ [id: string]: string }>{};
    let current = 0;
    current |= StatsbeatFeature.AAD_HANDLING;
    current |= StatsbeatFeature.DISK_RETRY;
    current |= StatsbeatFeature.LIVE_METRICS;
    env.AZURE_MONITOR_STATSBEAT_FEATURES = current.toString();
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const output = JSON.parse(String(process.env["AZURE_MONITOR_STATSBEAT_FEATURES"]));
    const numberOutput = Number(output["feature"]);
    assert.ok(numberOutput & StatsbeatFeature.AAD_HANDLING, "AAD_HANDLING not set");
    assert.ok(numberOutput & StatsbeatFeature.DISK_RETRY, "DISK_RETRY not set");
    assert.ok(numberOutput & StatsbeatFeature.DISTRO, "DISTRO not set");
    assert.notOk(numberOutput & StatsbeatFeature.BROWSER_SDK_LOADER, "BROWSER_SDK_LOADER is set");
    assert.ok(numberOutput & StatsbeatFeature.LIVE_METRICS, "LIVE_METRICS is not set");
  });

  it("should capture the app service SDK prefix correctly", () => {
    const os = getOsPrefix();
    const env = <{ [id: string]: string }>{};
    env.WEBSITE_SITE_NAME = "test-azure-app-service";
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    assert.strictEqual(process.env["AZURE_MONITOR_PREFIX"], `a${os}m_`);
  });

  it("should capture the azure function SDK prefix correctly", () => {
    const os = getOsPrefix();
    const env = <{ [id: string]: string }>{};
    env.FUNCTIONS_WORKER_RUNTIME = "test-azure-functions";
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    assert.strictEqual(process.env["AZURE_MONITOR_PREFIX"], `f${os}m_`);
  });

  it("should capture the AKS SDK prefix correctly", () => {
    const os = getOsPrefix();
    const env = <{ [id: string]: string }>{};
    env.AKS_ARM_NAMESPACE_ID = "test-AKS";
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    assert.strictEqual(process.env["AZURE_MONITOR_PREFIX"], `k${os}m_`);
  });

  it("should capture the AKS SDK prefix correctly", () => {
    const os = getOsPrefix();
    const env = <{ [id: string]: string }>{};
    env.KUBERNETES_SERVICE_HOST = "test-AKS";
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    assert.strictEqual(process.env["AZURE_MONITOR_PREFIX"], `k${os}m_`);
  });

  it("should prioritize resource detectors in env var OTEL_NODE_RESOURCE_DETECTORS", () => {
    const expectedResourceAttributeNamespaces = new Set(["os", "service", "telemetry"]);
    const env = <{ [id: string]: string }>{};
    env.OTEL_NODE_RESOURCE_DETECTORS = "os";
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);

    // Access resource from the SDK's tracer provider instead of from a span
    // This avoids issues with OTel global state in test environments
    const internalSdk = _getSdkInstance();
    const tracerProvider = (internalSdk as any)["_tracerProvider"];
    const resource =
      tracerProvider?.["resource"]?.["attributes"] || tracerProvider?.["_resource"]?.["attributes"];
    assert.isDefined(resource, "Resource should be defined on tracer provider");
    Object.keys(resource).forEach((attr) => {
      const parts = attr.split(".");
      assert.isTrue(expectedResourceAttributeNamespaces.has(parts[0]));
    });
  });

  it("should skip unknown resource detectors", () => {
    const expectedResourceAttributeNamespaces = new Set(["host", "service", "telemetry"]);
    const env = <{ [id: string]: string }>{};
    env.OTEL_NODE_RESOURCE_DETECTORS = "blah,host";
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);

    // Access resource from the SDK's tracer provider instead of from a span
    // This avoids issues with OTel global state in test environments
    const internalSdk = _getSdkInstance();
    const tracerProvider = (internalSdk as any)["_tracerProvider"];
    const resource =
      tracerProvider?.["resource"]?.["attributes"] || tracerProvider?.["_resource"]?.["attributes"];
    assert.isDefined(resource, "Resource should be defined on tracer provider");
    Object.keys(resource).forEach((attr) => {
      const parts = attr.split(".");
      assert.isTrue(expectedResourceAttributeNamespaces.has(parts[0]));
    });
  });

  it("should not use process resource detector if OTEL_NODE_RESOURCE_DETECTORS not specified", () => {
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);

    // Access resource from the SDK's tracer provider instead of from a span
    // This avoids issues with OTel global state in test environments
    const internalSdk = _getSdkInstance();
    const tracerProvider = (internalSdk as any)["_tracerProvider"];
    const resource =
      tracerProvider?.["resource"]?.["attributes"] || tracerProvider?.["_resource"]?.["attributes"];
    assert.isDefined(resource, "Resource should be defined on tracer provider");
    Object.keys(resource || {}).forEach((attr) => {
      assert.isTrue(!attr.includes("process"));
    });
  });

  it("should update statsbeat env var based on reading instrumentations array", () => {
    const config: MicrosoftOpenTelemetryOptions = {
      instrumentationOptions: {
        azureSdk: { enabled: false },
        http: { enabled: false },
        mongoDb: { enabled: false },
        mySql: { enabled: false },
        postgreSql: { enabled: false },
        redis: { enabled: false },
        redis4: { enabled: false },
        bunyan: { enabled: false },
        winston: { enabled: false },
      },
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const emptyStatsbeatConfig: string = JSON.stringify({ instrumentation: 0, feature: 0 });

    const statsbeatOptions: StatsbeatEnvironmentConfig = JSON.parse(
      process.env[AZURE_MONITOR_STATSBEAT_FEATURES] || emptyStatsbeatConfig,
    );
    const instrumentations = [testInstrumentation];
    let updatedStatsbeat = { instrumentation: 0, feature: 0 };

    // Dynamic statsbeat update logic
    for (let i = 0; i < instrumentations.length; i++) {
      updatedStatsbeat = {
        instrumentation: (statsbeatOptions.instrumentation |=
          StatsbeatInstrumentationMap.get(instrumentations[i].instrumentationName) || 0),
        feature: statsbeatOptions.feature,
      };
    }
    assert.strictEqual(updatedStatsbeat.instrumentation, StatsbeatInstrumentation.FS);
  });

  it("should detect MULTI_IKEY feature when AZURE_MONITOR_STATSBEAT_FEATURES has MULTI_IKEY enabled", () => {
    const env = <{ [id: string]: string }>{};
    env[AZURE_MONITOR_STATSBEAT_FEATURES] = String(StatsbeatFeature.MULTI_IKEY);
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const output = JSON.parse(String(process.env["AZURE_MONITOR_STATSBEAT_FEATURES"])) as {
      feature?: number;
    };
    const features = Number(output["feature"] || 0);
    assert.ok(features & StatsbeatFeature.MULTI_IKEY, "MULTI_IKEY not detected");
    void shutdownMicrosoftOpenTelemetry();
  });

  it("should not detect MULTI_IKEY feature when AZURE_MONITOR_STATSBEAT_FEATURES has MULTI_IKEY disabled", () => {
    const env = <{ [id: string]: string }>{};
    env[AZURE_MONITOR_STATSBEAT_FEATURES] = String(StatsbeatFeature.DISTRO);
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const output = JSON.parse(String(process.env["AZURE_MONITOR_STATSBEAT_FEATURES"])) as {
      feature?: number;
    };
    const features = Number(output["feature"] || 0);
    assert.ok(
      !(features & StatsbeatFeature.MULTI_IKEY),
      "MULTI_IKEY detected when it should not be",
    );
    void shutdownMicrosoftOpenTelemetry();
  });

  it("should detect CUSTOMER_SDKSTATS feature when APPLICATIONINSIGHTS_SDKSTATS_DISABLED is 'true'", () => {
    const env = <{ [id: string]: string }>{};
    env[APPLICATIONINSIGHTS_SDKSTATS_DISABLED] = "true";
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const output = JSON.parse(String(process.env["AZURE_MONITOR_STATSBEAT_FEATURES"])) as {
      feature?: number;
    };
    const features = Number(output["feature"] || 0);
    assert.ok(
      features & StatsbeatFeature.CUSTOMER_SDKSTATS,
      "CUSTOMER_SDKSTATS feature should be detected when customer explicitly disables SDK stats",
    );
    assert.ok(features & StatsbeatFeature.DISTRO, "DISTRO feature should also be set");
    void shutdownMicrosoftOpenTelemetry();
  });

  it("should not detect CUSTOMER_SDKSTATS feature when APPLICATIONINSIGHTS_SDKSTATS_DISABLED is not 'true'", () => {
    const env = <{ [id: string]: string }>{};
    env[APPLICATIONINSIGHTS_SDKSTATS_DISABLED] = "false";
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const output = JSON.parse(String(process.env["AZURE_MONITOR_STATSBEAT_FEATURES"])) as {
      feature?: number;
    };
    const features = Number(output["feature"] || 0);
    assert.ok(
      !(features & StatsbeatFeature.CUSTOMER_SDKSTATS),
      "CUSTOMER_SDKSTATS feature should not be detected when env var is not 'true'",
    );
    assert.ok(features & StatsbeatFeature.DISTRO, "DISTRO feature should still be set");
    void shutdownMicrosoftOpenTelemetry();
  });

  it("should not detect CUSTOMER_SDKSTATS feature when APPLICATIONINSIGHTS_SDKSTATS_DISABLED is not set", () => {
    const env = <{ [id: string]: string }>{};
    delete env[APPLICATIONINSIGHTS_SDKSTATS_DISABLED];
    process.env = env;
    const config: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };
    useMicrosoftOpenTelemetry(config);
    const output = JSON.parse(String(process.env["AZURE_MONITOR_STATSBEAT_FEATURES"])) as {
      feature?: number;
    };
    const features = Number(output["feature"] || 0);
    assert.ok(
      !(features & StatsbeatFeature.CUSTOMER_SDKSTATS),
      "CUSTOMER_SDKSTATS feature should not be detected when env var is undefined",
    );
    assert.ok(features & StatsbeatFeature.DISTRO, "DISTRO feature should still be set");
    void shutdownMicrosoftOpenTelemetry();
  });

  it("should create both AzureMonitor and OTLP metric exporters when OTLP environment variables are set", () => {
    // Create OTLP metric exporter and reader
    const otlpExporter = new OTLPMetricExporter({
      url: "http://localhost:4318/v1/metrics",
    });
    const otlpMetricReader = new PeriodicExportingMetricReader({
      exporter: otlpExporter,
      exportIntervalMillis: 60000,
    });

    const config: MicrosoftOpenTelemetryOptions = {
      metricReaders: [otlpMetricReader],
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        },
      },
    };

    // Initialize the SDK
    useMicrosoftOpenTelemetry(config);

    // Get the internal SDK instance
    const internalSdk = _getSdkInstance();
    assert.isDefined(internalSdk, "Internal SDK should be available");

    // Access the meter provider from the SDK
    const meterProvider = internalSdk["_meterProvider"];
    assert.isDefined(meterProvider, "MeterProvider should be available from SDK");

    // Extract metric readers from the meter provider's internal structure
    const sharedState = meterProvider["_sharedState"];
    let metricReaders = null;
    let foundProperty = null;

    if (sharedState && sharedState.metricCollectors) {
      // Extract metric readers from metricCollectors

      metricReaders = sharedState.metricCollectors.map((collector: any) => collector._metricReader);
      foundProperty = "_sharedState.metricCollectors[].._metricReader";
    }

    assert.ok(
      metricReaders,
      `MetricReaders should be available from MeterProvider via property: ${foundProperty}`,
    );
    assert.isTrue(Array.isArray(metricReaders), "MetricReaders should be an array");

    // Should have exactly 2 metric readers: Azure Monitor + OTLP
    assert.strictEqual(
      metricReaders.length,
      2,
      "Should have both Azure Monitor and OTLP metric readers",
    );

    // Check that we have both types of metric readers
    let hasAzureMonitorReader = false;
    let hasOTLPReader = false;

    for (const reader of metricReaders) {
      const readerConstructor = reader.constructor.name;

      if (readerConstructor === "PeriodicExportingMetricReader") {
        // Check if this is the OTLP reader by examining the exporter
        const exporter = reader["_exporter"];
        if (exporter && exporter.constructor.name === "OTLPMetricExporter") {
          hasOTLPReader = true;
          // Verify the OTLP exporter has the correct URL configuration
          const delegate = exporter["_delegate"];
          if (delegate) {
            const transportParams = delegate._transport._transport._parameters;
            assert.strictEqual(
              transportParams.url,
              "http://localhost:4318/v1/metrics",
              "OTLP exporter should have correct URL",
            );
          }
        } else {
          // This should be the Azure Monitor reader
          hasAzureMonitorReader = true;
        }
      }
    }

    assert.isTrue(hasAzureMonitorReader, "Should have Azure Monitor metric reader");
    assert.isTrue(hasOTLPReader, "Should have OTLP metric reader");

    void shutdownMicrosoftOpenTelemetry();
  });

  it("useMicrosoftOpenTelemetry with azureMonitor.enabled=false should skip Azure Monitor handlers", async () => {
    const { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } =
      await import("../../../src/index.js");
    const processor: SpanProcessor = {
      forceFlush: () => Promise.resolve(),
      onStart: () => {
        /* no-op */
      },
      onEnd: () => {
        /* no-op */
      },
      shutdown: () => Promise.resolve(),
    };

    useMicrosoftOpenTelemetry({
      azureMonitor: { enabled: false },
      spanProcessors: [processor],
    });

    // Providers should still be registered (the SDK still starts)
    const internalSdk = _getSdkInstance();
    assert.isDefined(internalSdk);

    // The tracer provider should contain the user-provided processor
    // but NOT Azure Monitor span processors (AzureMonitorSpanProcessor / BatchSpanProcessor)
    const tracerProvider = (internalSdk as any)["_tracerProvider"];
    const registeredProcessors = tracerProvider?.["_registeredSpanProcessors"] || [];
    const processorNames = registeredProcessors.map((p: SpanProcessor) => p.constructor.name);
    // User-provided processor (Object) should be present but no Azure Monitor ones
    expect(processorNames).not.toContain("AzureMonitorSpanProcessor");
    expect(processorNames).not.toContain("AzureMonitorExporterProcessor");

    // Metric readers should not contain Azure Monitor readers
    const meterProvider = (internalSdk as any)["_meterProvider"];
    const metricReaders = meterProvider?.["_sharedState"]?.metricCollectors || [];
    assert.strictEqual(
      metricReaders.length,
      0,
      "Should have no metric readers when Azure Monitor is disabled and no custom readers provided",
    );

    await shutdownMicrosoftOpenTelemetry();
  });

  it("should initialize providers without Azure Monitor when only OTLP is configured", () => {
    const env = <{ [id: string]: string }>{};
    env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env = env;

    // Call without azureMonitor options — only OTLP backend
    useMicrosoftOpenTelemetry();

    // Global providers should be registered (not noop)
    const tracer = trace.getTracerProvider().getTracer("test-otlp-only");
    const span = tracer.startSpan("otlp-only-span");
    const { traceId } = span.spanContext();
    span.end();
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(traceId).not.toBe("00000000000000000000000000000000");

    // SDK should be initialized
    const internalSdk = _getSdkInstance();
    assert.isDefined(internalSdk, "Internal SDK should be available");

    // Meter provider should not have Azure Monitor readers
    const meterProvider = internalSdk!["_meterProvider"];
    assert.isDefined(meterProvider, "MeterProvider should be available");
    const sharedState = meterProvider["_sharedState"];
    if (sharedState?.metricCollectors) {
      const readers = sharedState.metricCollectors.map((collector: any) => collector._metricReader);
      for (const reader of readers) {
        const exporter = reader["_exporter"];
        if (exporter) {
          // None of the exporters should be AzureMonitorMetricExporter
          expect(exporter.constructor.name).not.toContain("AzureMonitor");
        }
      }
    }

    // Azure Monitor statsbeat env var should not have any Azure Monitor-specific features
    const statsbeatRaw = process.env["AZURE_MONITOR_STATSBEAT_FEATURES"];
    if (statsbeatRaw) {
      const statsbeat = JSON.parse(statsbeatRaw);
      // DISTRO feature should NOT be set when Azure Monitor is not configured
      expect(statsbeat.feature & 8).toBe(0); // 8 = StatsbeatFeature.DISTRO
    }

    void shutdownMicrosoftOpenTelemetry();
  });

  it("console exporters auto-enabled when no built-in exporters are active", async () => {
    const { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } =
      await import("../../../src/index.js");
    useMicrosoftOpenTelemetry({ azureMonitor: { enabled: false } });

    const internalSdk = _getSdkInstance();
    const meterProvider = (internalSdk as any)["_meterProvider"];
    const metricReaders = meterProvider?.["_sharedState"]?.metricCollectors || [];
    assert.isAbove(metricReaders.length, 0, "Console metric reader should be auto-enabled");

    await shutdownMicrosoftOpenTelemetry();
  });

  it("enableConsoleExporters=false suppresses console exporters", async () => {
    const { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } =
      await import("../../../src/index.js");
    useMicrosoftOpenTelemetry({
      azureMonitor: { enabled: false },
      enableConsoleExporters: false,
    });

    const internalSdk = _getSdkInstance();
    const meterProvider = (internalSdk as any)["_meterProvider"];
    const metricReaders = meterProvider?.["_sharedState"]?.metricCollectors || [];
    assert.strictEqual(metricReaders.length, 0, "No metric readers when console is suppressed");

    await shutdownMicrosoftOpenTelemetry();
  });

  it("enableConsoleExporters=true alongside Azure Monitor", async () => {
    const { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } =
      await import("../../../src/index.js");
    useMicrosoftOpenTelemetry({
      enableConsoleExporters: true,
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString:
            "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://localhost",
        },
      },
    });

    const internalSdk = _getSdkInstance();
    const meterProvider = (internalSdk as any)["_meterProvider"];
    const metricReaders = meterProvider?.["_sharedState"]?.metricCollectors || [];
    // Should have both Azure Monitor metric reader and console metric reader
    assert.isAbove(metricReaders.length, 1, "Should have Azure Monitor + Console metric readers");

    await shutdownMicrosoftOpenTelemetry();
  });

  it("preserves BatchSpanProcessor defaults when A365 exporter tuning is omitted", async () => {
    useMicrosoftOpenTelemetry({
      azureMonitor: { enabled: false },
      enableConsoleExporters: false,
      a365: {
        enabled: true,
        tokenResolver: () => "token",
      },
    });

    const internalSdk = _getSdkInstance();
    assert.isDefined(internalSdk);

    const tracerProvider = (internalSdk as any)["_tracerProvider"];
    const activeSpanProcessor = tracerProvider?.["_activeSpanProcessor"];
    const registeredProcessors = activeSpanProcessor?.["_spanProcessors"] || [];

    const batchProcessor = registeredProcessors.find(
      (processor: any) =>
        processor.constructor?.name === "BatchSpanProcessor" &&
        processor["_exporter"]?.constructor?.name === "Agent365Exporter",
    );

    assert.isDefined(batchProcessor, "Expected an Agent365 BatchSpanProcessor");
    assert.strictEqual(batchProcessor["_exportTimeoutMillis"], 30000);

    await shutdownMicrosoftOpenTelemetry();
  });
});
