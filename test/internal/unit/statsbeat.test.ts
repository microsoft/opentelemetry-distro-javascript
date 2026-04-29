// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { getInstance } from "../../../src/utils/statsbeat.js";
import { AZURE_MONITOR_STATSBEAT_FEATURES, StatsbeatFeature } from "../../../src/types.js";

describe("StatsbeatConfiguration — a365 and otlp feature flags", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env[AZURE_MONITOR_STATSBEAT_FEATURES];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should set A365 feature bit (512) when a365 is enabled", () => {
    const sb = getInstance();
    sb.setStatsbeatFeatures({}, { a365: true });

    const output = JSON.parse(String(process.env[AZURE_MONITOR_STATSBEAT_FEATURES]));
    const features = Number(output.feature);
    expect(features & StatsbeatFeature.A365).toBeTruthy();
  });

  it("should not set A365 feature bit when a365 is not enabled", () => {
    const sb = getInstance();
    sb.setStatsbeatFeatures({}, { a365: false });

    const output = JSON.parse(String(process.env[AZURE_MONITOR_STATSBEAT_FEATURES]));
    const features = Number(output.feature);
    expect(features & StatsbeatFeature.A365).toBeFalsy();
  });

  it("should set OTLP feature bit (1024) when otlp is enabled", () => {
    const sb = getInstance();
    sb.setStatsbeatFeatures({}, { otlp: true });

    const output = JSON.parse(String(process.env[AZURE_MONITOR_STATSBEAT_FEATURES]));
    const features = Number(output.feature);
    expect(features & StatsbeatFeature.OTLP).toBeTruthy();
  });

  it("should not set OTLP feature bit when otlp is not enabled", () => {
    const sb = getInstance();
    sb.setStatsbeatFeatures({}, { otlp: false });

    const output = JSON.parse(String(process.env[AZURE_MONITOR_STATSBEAT_FEATURES]));
    const features = Number(output.feature);
    expect(features & StatsbeatFeature.OTLP).toBeFalsy();
  });

  it("should set both A365 and OTLP feature bits simultaneously", () => {
    const sb = getInstance();
    sb.setStatsbeatFeatures({}, { a365: true, otlp: true });

    const output = JSON.parse(String(process.env[AZURE_MONITOR_STATSBEAT_FEATURES]));
    const features = Number(output.feature);
    expect(features & StatsbeatFeature.A365).toBeTruthy();
    expect(features & StatsbeatFeature.OTLP).toBeTruthy();
  });

  it("should preserve existing feature bits when adding a365/otlp", () => {
    // Seed the env var with an existing feature bitmap
    process.env[AZURE_MONITOR_STATSBEAT_FEATURES] = String(
      StatsbeatFeature.AAD_HANDLING | StatsbeatFeature.DISK_RETRY,
    );

    const sb = getInstance();
    sb.setStatsbeatFeatures({}, { a365: true, otlp: true });

    const output = JSON.parse(String(process.env[AZURE_MONITOR_STATSBEAT_FEATURES]));
    const features = Number(output.feature);
    expect(features & StatsbeatFeature.AAD_HANDLING).toBeTruthy();
    expect(features & StatsbeatFeature.DISK_RETRY).toBeTruthy();
    expect(features & StatsbeatFeature.A365).toBeTruthy();
    expect(features & StatsbeatFeature.OTLP).toBeTruthy();
  });
});
