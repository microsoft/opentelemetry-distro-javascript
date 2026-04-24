// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Manager for configuring hosting-layer observability middleware.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability-hosting/src/middleware/ObservabilityHostingManager.ts
 */

import { Logger } from "../../shared/logging/index.js";
import { BaggageMiddleware } from "./baggageMiddleware.js";
import { OutputLoggingMiddleware } from "./outputLoggingMiddleware.js";
import type { HostingAdapterLike } from "./types.js";

/**
 * Configuration options for the hosting observability layer.
 */
export interface ObservabilityHostingOptions {
  /** Enable baggage propagation middleware. Defaults to false. */
  enableBaggage?: boolean;

  /** Enable output logging middleware for tracing outgoing messages. Defaults to false. */
  enableOutputLogging?: boolean;
}

/**
 * Manager for configuring hosting-layer observability middleware.
 *
 * @example
 * ```typescript
 * const manager = new ObservabilityHostingManager();
 * manager.configure(adapter, { enableOutputLogging: true });
 * ```
 */
export class ObservabilityHostingManager {
  private _configured = false;

  /**
   * Registers observability middleware on the adapter.
   * Subsequent calls are ignored.
   */
  configure(adapter: HostingAdapterLike, options: ObservabilityHostingOptions): void {
    if (this._configured) {
      Logger.getInstance().warn(
        "[ObservabilityHostingManager] Already configured. Subsequent configure() calls are ignored.",
      );
      return;
    }

    const enableBaggage = options.enableBaggage === true;
    const enableOutputLogging = options.enableOutputLogging === true;

    if (enableBaggage) {
      adapter.use(new BaggageMiddleware());
      Logger.getInstance().info("[ObservabilityHostingManager] BaggageMiddleware registered.");
    }
    if (enableOutputLogging) {
      adapter.use(new OutputLoggingMiddleware());
      Logger.getInstance().info(
        "[ObservabilityHostingManager] OutputLoggingMiddleware registered.",
      );
    }

    Logger.getInstance().info(
      `[ObservabilityHostingManager] Configured. Baggage: ${enableBaggage}, OutputLogging: ${enableOutputLogging}.`,
    );
    this._configured = true;
  }
}
