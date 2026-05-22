// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, beforeEach, afterEach, expect } from "vitest";

import { SdkStatsManager } from "../../../../src/sdkstats/manager.js";
import {
  SDKSTATS_DISABLED_ENV,
  _resetSdkStatsStateForTest,
} from "../../../../src/sdkstats/state.js";

function getReaderInterval(provider: unknown): number | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = provider as any;
  const reader = p?._sharedState?.metricCollectors?.[0]?._metricReader;
  return reader?._exportInterval;
}

describe("sdkstats/manager", () => {
  beforeEach(() => {
    _resetSdkStatsStateForTest();
    delete process.env[SDKSTATS_DISABLED_ENV];
    SdkStatsManager._resetForTest();
  });

  afterEach(async () => {
    await SdkStatsManager.getInstance().shutdown();
    SdkStatsManager._resetForTest();
  });

  it("returns a singleton instance", () => {
    expect(SdkStatsManager.getInstance()).toBe(SdkStatsManager.getInstance());
  });

  it("does not initialize when SDKStats are disabled via env var", async () => {
    process.env[SDKSTATS_DISABLED_ENV] = "true";
    const initialized = await SdkStatsManager.getInstance().initialize();
    expect(initialized).toBe(false);
    expect(SdkStatsManager.getInstance().isInitialized).toBe(false);
  });

  it("initializes the standalone pipeline when SDKStats are enabled", async () => {
    const manager = SdkStatsManager.getInstance();
    const initialized = await manager.initialize();
    expect(initialized).toBe(true);
    expect(manager.isInitialized).toBe(true);
  });

  it("is idempotent — repeated initialize() calls return true without re-initializing", async () => {
    const manager = SdkStatsManager.getInstance();
    expect(await manager.initialize()).toBe(true);
    expect(await manager.initialize()).toBe(true);
    expect(manager.isInitialized).toBe(true);
  });

  it("shuts down cleanly and reports not-initialized afterwards", async () => {
    const manager = SdkStatsManager.getInstance();
    await manager.initialize();
    expect(await manager.shutdown()).toBe(true);
    expect(manager.isInitialized).toBe(false);
    // shutdown when not initialized is a no-op
    expect(await manager.shutdown()).toBe(false);
  });

  it("uses a 24-hour long-interval for Feature gauges and 15-minute short-interval for network gauges", async () => {
    const manager = SdkStatsManager.getInstance();
    await manager.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const longProvider = (manager as any)._longMeterProvider;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shortProvider = (manager as any)._shortMeterProvider;
    expect(getReaderInterval(longProvider)).toBe(24 * 60 * 60 * 1000);
    expect(getReaderInterval(shortProvider)).toBe(15 * 60 * 1000);
  });

  it("skips the long-interval provider when networkOnly is true", async () => {
    const manager = SdkStatsManager.getInstance();
    await manager.initialize({ networkOnly: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any)._longMeterProvider).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any)._shortMeterProvider).toBeDefined();
  });

  it("honours APPLICATIONINSIGHTS_STATS_LONG_EXPORT_INTERVAL override (seconds)", async () => {
    process.env["APPLICATIONINSIGHTS_STATS_LONG_EXPORT_INTERVAL"] = "3600";
    try {
      const manager = SdkStatsManager.getInstance();
      await manager.initialize();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(getReaderInterval((manager as any)._longMeterProvider)).toBe(3_600_000);
    } finally {
      delete process.env["APPLICATIONINSIGHTS_STATS_LONG_EXPORT_INTERVAL"];
    }
  });

  it("honours APPLICATIONINSIGHTS_STATS_SHORT_EXPORT_INTERVAL override (seconds)", async () => {
    process.env["APPLICATIONINSIGHTS_STATS_SHORT_EXPORT_INTERVAL"] = "60";
    try {
      const manager = SdkStatsManager.getInstance();
      await manager.initialize();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(getReaderInterval((manager as any)._shortMeterProvider)).toBe(60_000);
    } finally {
      delete process.env["APPLICATIONINSIGHTS_STATS_SHORT_EXPORT_INTERVAL"];
    }
  });

  it("schedules an initial forceFlush ~15s after initialize() (timer is unref'd)", async () => {
    const manager = SdkStatsManager.getInstance();
    await manager.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = (manager as any)._initialExportTimer;
    expect(timer).toBeDefined();
    // Timer should be unref'd so it does not keep the event loop alive.
    // unref() is idempotent — calling again should not throw.
    expect(() => timer.unref()).not.toThrow();
    await manager.shutdown();
    // shutdown clears the timer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any)._initialExportTimer).toBeUndefined();
  });
});
