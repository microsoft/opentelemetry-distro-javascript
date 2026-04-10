// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isOtlpEnabled, createOtlpComponents } from "../../../../src/otlp/handler.js";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";

describe("OTLP Handler", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isOtlpEnabled", () => {
    it("should return false when OTEL_EXPORTER_OTLP_ENDPOINT is not set", () => {
      delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
      expect(isOtlpEnabled()).toBe(false);
    });

    it("should return true when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:4318";
      expect(isOtlpEnabled()).toBe(true);
    });

    it("should return false when OTEL_EXPORTER_OTLP_ENDPOINT is empty", () => {
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "";
      expect(isOtlpEnabled()).toBe(false);
    });

    it("should return true when only OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set", () => {
      delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
      process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = "http://localhost:4318/v1/traces";
      expect(isOtlpEnabled()).toBe(true);
    });

    it("should return true when only OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set", () => {
      delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
      process.env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"] = "http://localhost:4318/v1/metrics";
      expect(isOtlpEnabled()).toBe(true);
    });

    it("should return true when only OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is set", () => {
      delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
      process.env["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"] = "http://localhost:4318/v1/logs";
      expect(isOtlpEnabled()).toBe(true);
    });
  });

  describe("createOtlpComponents", () => {
    it("should create all three components (span processor, metric reader, log record processor)", () => {
      const components = createOtlpComponents();
      expect(components.spanProcessor).toBeInstanceOf(BatchSpanProcessor);
      expect(components.metricReader).toBeInstanceOf(PeriodicExportingMetricReader);
      expect(components.logRecordProcessor).toBeInstanceOf(BatchLogRecordProcessor);
    });

    it("should create all three component types when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://my-collector:4318";
      const components = createOtlpComponents();
      expect(components.spanProcessor).toBeInstanceOf(BatchSpanProcessor);
      expect(components.metricReader).toBeInstanceOf(PeriodicExportingMetricReader);
      expect(components.logRecordProcessor).toBeInstanceOf(BatchLogRecordProcessor);
    });
  });
});
