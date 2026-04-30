// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, beforeEach, expect } from "vitest";

import {
  APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL,
  SDKSTATS_DISABLED_ENV,
  SdkStatsDistroFeature,
  _resetSdkStatsStateForTest,
  getSdkStatsFeatureFlags,
  getSdkStatsInstrumentationFlags,
  getSdkStatsShutdown,
  isSdkStatsEnabled,
  setSdkStatsFeature,
  setSdkStatsInstrumentation,
  setSdkStatsShutdown,
} from "../../../../src/sdkstats/state.js";
import { StatsbeatFeature, StatsbeatInstrumentation } from "../../../../src/types.js";

describe("sdkstats/state", () => {
  beforeEach(() => {
    _resetSdkStatsStateForTest();
    delete process.env[SDKSTATS_DISABLED_ENV];
    delete process.env[APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL];
  });

  describe("isSdkStatsEnabled", () => {
    it("returns true when no env var is set", () => {
      expect(isSdkStatsEnabled()).toBe(true);
    });

    for (const truthy of ["true", "TRUE", "1", "yes", "on", "  on  "]) {
      it(`returns false when ${SDKSTATS_DISABLED_ENV}='${truthy}'`, () => {
        process.env[SDKSTATS_DISABLED_ENV] = truthy;
        expect(isSdkStatsEnabled()).toBe(false);
      });
    }

    it("also honours the legacy APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL env var", () => {
      process.env[APPLICATIONINSIGHTS_STATSBEAT_DISABLED_ALL] = "true";
      expect(isSdkStatsEnabled()).toBe(false);
    });

    it("ignores unrecognized values (treats as enabled)", () => {
      process.env[SDKSTATS_DISABLED_ENV] = "maybe";
      expect(isSdkStatsEnabled()).toBe(true);
    });
  });

  describe("feature bitmask", () => {
    it("starts at 0", () => {
      expect(getSdkStatsFeatureFlags()).toBe(0);
    });

    it("ORs in shared StatsbeatFeature values", () => {
      setSdkStatsFeature(StatsbeatFeature.DISTRO);
      expect(getSdkStatsFeatureFlags()).toBe(StatsbeatFeature.DISTRO);
      setSdkStatsFeature(StatsbeatFeature.LIVE_METRICS);
      expect(getSdkStatsFeatureFlags()).toBe(
        StatsbeatFeature.DISTRO | StatsbeatFeature.LIVE_METRICS,
      );
    });

    it("ORs in distro-specific values without colliding with StatsbeatFeature", () => {
      setSdkStatsFeature(StatsbeatFeature.DISTRO);
      setSdkStatsFeature(SdkStatsDistroFeature.A365_EXPORT);
      setSdkStatsFeature(SdkStatsDistroFeature.OTLP_EXPORT);
      const expected =
        StatsbeatFeature.DISTRO |
        SdkStatsDistroFeature.A365_EXPORT |
        SdkStatsDistroFeature.OTLP_EXPORT;
      expect(getSdkStatsFeatureFlags()).toBe(expected);
    });

    it("setting the same flag twice is idempotent", () => {
      setSdkStatsFeature(SdkStatsDistroFeature.A365_EXPORT);
      setSdkStatsFeature(SdkStatsDistroFeature.A365_EXPORT);
      expect(getSdkStatsFeatureFlags()).toBe(SdkStatsDistroFeature.A365_EXPORT);
    });
  });

  describe("instrumentation bitmask", () => {
    it("starts at 0 and ORs in values", () => {
      expect(getSdkStatsInstrumentationFlags()).toBe(0);
      setSdkStatsInstrumentation(StatsbeatInstrumentation.MONGODB);
      setSdkStatsInstrumentation(StatsbeatInstrumentation.REDIS);
      expect(getSdkStatsInstrumentationFlags()).toBe(
        StatsbeatInstrumentation.MONGODB | StatsbeatInstrumentation.REDIS,
      );
    });
  });

  describe("shutdown flag", () => {
    it("starts false and toggles", () => {
      expect(getSdkStatsShutdown()).toBe(false);
      setSdkStatsShutdown(true);
      expect(getSdkStatsShutdown()).toBe(true);
      setSdkStatsShutdown(false);
      expect(getSdkStatsShutdown()).toBe(false);
    });

    it("defaults the parameter to true", () => {
      setSdkStatsShutdown();
      expect(getSdkStatsShutdown()).toBe(true);
    });
  });

  describe("_resetSdkStatsStateForTest", () => {
    it("clears all bitmasks and the shutdown flag", () => {
      setSdkStatsFeature(SdkStatsDistroFeature.A365_EXPORT);
      setSdkStatsInstrumentation(StatsbeatInstrumentation.MONGODB);
      setSdkStatsShutdown(true);
      _resetSdkStatsStateForTest();
      expect(getSdkStatsFeatureFlags()).toBe(0);
      expect(getSdkStatsInstrumentationFlags()).toBe(0);
      expect(getSdkStatsShutdown()).toBe(false);
    });
  });
});
