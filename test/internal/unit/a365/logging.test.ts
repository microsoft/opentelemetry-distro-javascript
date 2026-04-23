// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";
import {
  configureA365Logger,
  getA365Logger,
  _resetA365LoggerForTest,
} from "../../../../src/a365/logging.js";

describe("A365 logging", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetA365LoggerForTest();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetA365LoggerForTest();
    vi.restoreAllMocks();
  });

  it("filters logs by configured level", () => {
    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    configureA365Logger({ logger: customLogger, logLevel: "warn|error" });
    const logger = getA365Logger();

    logger.info("info-message");
    logger.warn("warn-message");
    logger.error("error-message");

    assert.strictEqual(customLogger.info.mock.calls.length, 0);
    assert.strictEqual(customLogger.warn.mock.calls.length, 1);
    assert.strictEqual(customLogger.error.mock.calls.length, 1);
  });

  it("supports replacing logger via configureA365Logger", () => {
    const loggerA = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const loggerB = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    configureA365Logger({ logger: loggerA, logLevel: "info" });
    getA365Logger().info("first");
    assert.strictEqual(loggerA.info.mock.calls.length, 1);

    configureA365Logger({ logger: loggerB });
    getA365Logger().info("second");

    assert.strictEqual(loggerA.info.mock.calls.length, 1);
    assert.strictEqual(loggerB.info.mock.calls.length, 1);
  });

  it("allows clearing a previously configured custom logger", () => {
    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    configureA365Logger({ logger: customLogger, logLevel: "info" });
    getA365Logger().info("first");
    assert.strictEqual(customLogger.info.mock.calls.length, 1);

    configureA365Logger({ logger: undefined });
    getA365Logger().info("second");

    assert.strictEqual(customLogger.info.mock.calls.length, 1);
  });

  it("uses A365_OBSERVABILITY_LOG_LEVEL by default", () => {
    process.env.A365_OBSERVABILITY_LOG_LEVEL = "error";
    _resetA365LoggerForTest();

    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    configureA365Logger({ logger: customLogger });
    const logger = getA365Logger();

    logger.info("info-message");
    logger.warn("warn-message");
    logger.error("error-message");

    assert.strictEqual(customLogger.info.mock.calls.length, 0);
    assert.strictEqual(customLogger.warn.mock.calls.length, 0);
    assert.strictEqual(customLogger.error.mock.calls.length, 1);
  });
});
