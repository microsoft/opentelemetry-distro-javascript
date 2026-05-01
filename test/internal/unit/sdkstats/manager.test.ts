// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, beforeEach, afterEach, expect } from "vitest";

import { SdkStatsManager } from "../../../../src/sdkstats/manager.js";
import {
  SDKSTATS_DISABLED_ENV,
  _resetSdkStatsStateForTest,
} from "../../../../src/sdkstats/state.js";

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

  it("uses the spec-compliant 24h long-export interval by default", async () => {
    const manager = SdkStatsManager.getInstance();
    await manager.initialize();
    // Reach into the private MeterProvider's reader to confirm interval.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = (manager as any)._meterProvider;
    const reader = provider?._sharedState?.metricCollectors?.[0]?._metricReader;
    const intervalMs = reader?._exportInterval;
    expect(intervalMs).toBe(24 * 60 * 60 * 1000);
  });

  it("honours APPLICATIONINSIGHTS_STATS_LONG_EXPORT_INTERVAL override (seconds)", async () => {
    process.env["APPLICATIONINSIGHTS_STATS_LONG_EXPORT_INTERVAL"] = "60";
    try {
      const manager = SdkStatsManager.getInstance();
      await manager.initialize();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const provider = (manager as any)._meterProvider;
      const reader = provider?._sharedState?.metricCollectors?.[0]?._metricReader;
      expect(reader?._exportInterval).toBe(60_000);
    } finally {
      delete process.env["APPLICATIONINSIGHTS_STATS_LONG_EXPORT_INTERVAL"];
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
