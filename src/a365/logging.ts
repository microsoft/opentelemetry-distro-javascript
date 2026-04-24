// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Logger } from "../shared/logging/index.js";

/** Logger contract for A365 internals. */
export interface ILogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LOG_LEVEL_NONE = 0;
const LOG_LEVEL_INFO = 1;
const LOG_LEVEL_WARN = 2;
const LOG_LEVEL_ERROR = 3;

const LOG_LEVELS: Record<string, number> = {
  none: LOG_LEVEL_NONE,
  info: LOG_LEVEL_INFO,
  warn: LOG_LEVEL_WARN,
  error: LOG_LEVEL_ERROR,
};

const DEFAULT_LOG_LEVEL = "none";

let globalLogger: ILogger | undefined;
let configuredLogLevel: string = process.env.A365_OBSERVABILITY_LOG_LEVEL ?? DEFAULT_LOG_LEVEL;

function parseLogLevels(level: string): Set<number> {
  const levels = new Set<number>();
  const entries = level.toLowerCase().trim().split("|");

  for (const entry of entries) {
    const normalized = entry.trim();
    const value = LOG_LEVELS[normalized];
    if (value !== undefined) {
      levels.add(value);
    }
  }

  if (levels.size === 0) {
    levels.add(LOG_LEVEL_NONE);
  }

  return levels;
}

function defaultLogger(): ILogger {
  const logger = Logger.getInstance();
  return {
    info: (message: string, ...args: unknown[]) => logger.info(message, ...args),
    warn: (message: string, ...args: unknown[]) => logger.warn(message, ...args),
    error: (message: string, ...args: unknown[]) => logger.error(message, ...args),
  };
}

/** Configure the global A365 logger and optional log level filter. */
export function configureA365Logger(options?: { logger?: ILogger; logLevel?: string }): void {
  if (options && "logger" in options) {
    globalLogger = options.logger;
  }

  if (options?.logLevel !== undefined) {
    configuredLogLevel = options.logLevel;
  }
}

/** Returns an A365 logger wrapper that applies the configured log level filter. */
export function getA365Logger(): ILogger {
  const logger = globalLogger ?? defaultLogger();
  const enabledLevels = parseLogLevels(configuredLogLevel);

  return {
    info: (message: string, ...args: unknown[]) => {
      if (enabledLevels.has(LOG_LEVEL_INFO)) {
        logger.info(message, ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      if (enabledLevels.has(LOG_LEVEL_WARN)) {
        logger.warn(message, ...args);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      if (enabledLevels.has(LOG_LEVEL_ERROR)) {
        logger.error(message, ...args);
      }
    },
  };
}

/** @internal Reset A365 logging globals (used by tests). */
export function _resetA365LoggerForTest(): void {
  globalLogger = undefined;
  configuredLogLevel = process.env.A365_OBSERVABILITY_LOG_LEVEL ?? DEFAULT_LOG_LEVEL;
}
