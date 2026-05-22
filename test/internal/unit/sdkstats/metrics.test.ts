// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, beforeEach, expect } from "vitest";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

import {
  REQUEST_SUCCESS_NAME,
  _resetAllForTest as _resetNetworkStatsForTest,
  recordSuccess,
} from "../../../../src/sdkstats/networkStats.js";
import {
  FEATURE_TYPE_FEATURE,
  FEATURE_TYPE_INSTRUMENTATION,
  SdkStatsMetrics,
} from "../../../../src/sdkstats/metrics.js";
import {
  _resetSdkStatsStateForTest,
  setSdkStatsFeature,
  setSdkStatsInstrumentation,
} from "../../../../src/sdkstats/state.js";
import {
  MICROSOFT_OPENTELEMETRY_VERSION,
  StatsbeatFeature,
  StatsbeatInstrumentation,
} from "../../../../src/types.js";
import { SdkStatsDistroFeature } from "../../../../src/sdkstats/state.js";

import { InMemoryMetricExporter, AggregationTemporality } from "@opentelemetry/sdk-metrics";

async function collectMetrics(
  meterProvider: MeterProvider,
  exporter: InMemoryMetricExporter,
): Promise<Record<string, Array<{ value: number; attributes: Record<string, unknown> }>>> {
  // Force a collection cycle
  await meterProvider.forceFlush();
  const result: Record<string, Array<{ value: number; attributes: Record<string, unknown> }>> = {};
  for (const resourceMetric of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetric.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        const list = (result[metric.descriptor.name] ||= []);
        for (const point of metric.dataPoints) {
          list.push({ value: point.value as number, attributes: point.attributes });
        }
      }
    }
  }
  return result;
}

describe("sdkstats/metrics", () => {
  beforeEach(() => {
    _resetSdkStatsStateForTest();
  });

  it("does not emit observations when the feature/instrumentation bits are 0", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const meterProvider = new MeterProvider({});
    new SdkStatsMetrics(meterProvider);

    const metrics = await collectMetrics(meterProvider, exporter);
    expect(Object.keys(metrics)).toHaveLength(0);
    await meterProvider.shutdown();
  });

  it("emits a Feature observation with the OR'd feature bitmask and common dims", async () => {
    setSdkStatsFeature(StatsbeatFeature.DISTRO);
    setSdkStatsFeature(SdkStatsDistroFeature.A365_EXPORT);
    setSdkStatsFeature(SdkStatsDistroFeature.OTLP_EXPORT);

    // Use a manual collection approach: hook a reader that captures
    // observations via a one-shot exporter.
    const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    });
    const meterProvider = new MeterProvider({ readers: [reader] });
    new SdkStatsMetrics(meterProvider);

    await meterProvider.forceFlush();

    const featureMetrics = exporter
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
      .filter((m) => m.descriptor.name === "Feature");

    expect(featureMetrics).toHaveLength(1);
    expect(featureMetrics[0].dataPoints).toHaveLength(1);
    const point = featureMetrics[0].dataPoints[0];
    expect(point.value).toBe(1);
    expect(point.attributes.type).toBe(FEATURE_TYPE_FEATURE);
    expect(point.attributes.language).toBe("node");
    expect(point.attributes.version).toBe(MICROSOFT_OPENTELEMETRY_VERSION);
    expect(typeof point.attributes.runtimeVersion).toBe("string");
    expect(typeof point.attributes.os).toBe("string");

    const expectedBits =
      StatsbeatFeature.DISTRO |
      SdkStatsDistroFeature.A365_EXPORT |
      SdkStatsDistroFeature.OTLP_EXPORT;
    // Bitmask is sent as a string per spec (customDimensions are string-typed).
    expect(point.attributes.feature).toBe(String(expectedBits));

    await meterProvider.shutdown();
  });

  it("emits a Feature.instrumentations observation tagged with type=1", async () => {
    setSdkStatsInstrumentation(StatsbeatInstrumentation.MONGODB);
    setSdkStatsInstrumentation(StatsbeatInstrumentation.REDIS);

    const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    });
    const meterProvider = new MeterProvider({ readers: [reader] });
    new SdkStatsMetrics(meterProvider);

    await meterProvider.forceFlush();

    const instrMetrics = exporter
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
      .filter((m) => m.descriptor.name === "Feature.instrumentations");

    expect(instrMetrics).toHaveLength(1);
    const point = instrMetrics[0].dataPoints[0];
    expect(point.attributes.type).toBe(FEATURE_TYPE_INSTRUMENTATION);
    expect(point.attributes.feature).toBe(
      String(StatsbeatInstrumentation.MONGODB | StatsbeatInstrumentation.REDIS),
    );

    await meterProvider.shutdown();
  });

  it("uses the supplied distro version when provided", async () => {
    setSdkStatsFeature(StatsbeatFeature.DISTRO);
    const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    });
    const meterProvider = new MeterProvider({ readers: [reader] });
    new SdkStatsMetrics(meterProvider, { distroVersion: "9.9.9-test" });

    await meterProvider.forceFlush();

    const featureMetric = exporter
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
      .find((m) => m.descriptor.name === "Feature");
    expect(featureMetric?.dataPoints[0]?.attributes.version).toBe("9.9.9-test");

    await meterProvider.shutdown();
  });

  describe("networkOnly mode", () => {
    it("skips Feature/Feature.instrumentations gauges but still registers network gauges", async () => {
      // Set bits that would normally trigger feature/instrumentation observations.
      setSdkStatsFeature(StatsbeatFeature.DISTRO);
      setSdkStatsInstrumentation(StatsbeatInstrumentation.MONGODB);
      // Drop a network counter so a request_success_count observation will fire.
      _resetNetworkStatsForTest();
      recordSuccess("a365", "contoso.example.com");

      const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
      const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      });
      const meterProvider = new MeterProvider({ readers: [reader] });
      new SdkStatsMetrics(meterProvider, { networkOnly: true });

      await meterProvider.forceFlush();

      const names = exporter
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
        .map((m) => m.descriptor.name);

      expect(names).not.toContain("Feature");
      expect(names).not.toContain("Feature.instrumentations");
      expect(names).toContain(REQUEST_SUCCESS_NAME);

      await meterProvider.shutdown();
      _resetNetworkStatsForTest();
    });
  });

  describe("network gauges (default mode)", () => {
    it("emits one observation per drained key, attaches endpoint + host, and clears after collection", async () => {
      _resetNetworkStatsForTest();
      recordSuccess("a365", "a365.example.com");
      recordSuccess("a365", "a365.example.com");

      const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
      const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      });
      const meterProvider = new MeterProvider({ readers: [reader] });
      new SdkStatsMetrics(meterProvider);

      await meterProvider.forceFlush();

      const byName = (name: string) =>
        exporter
          .getMetrics()
          .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
          .filter((m) => m.descriptor.name === name)
          .flatMap((m) => m.dataPoints);

      const success = byName(REQUEST_SUCCESS_NAME);
      expect(success).toHaveLength(1);
      expect(success[0].value).toBe(2);
      expect(success[0].attributes.endpoint).toBe("a365");
      expect(success[0].attributes.host).toBe("a365.example.com");
      expect(success[0].attributes.statusCode).toBeUndefined();

      // Common dimensions per spec.
      for (const dp of success) {
        expect(dp.attributes.rp).toBe("unknown");
        expect(dp.attributes.attach).toBe("Manual");
        expect(dp.attributes.cikey).toBe("N/A");
        expect(dp.attributes.language).toBe("node");
      }

      await meterProvider.shutdown();
      _resetNetworkStatsForTest();
    });
  });
});
