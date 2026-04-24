// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ObservabilityHostingManager } from "./observabilityHostingManager.js";
import type { ObservabilityHostingOptions } from "./observabilityHostingManager.js";
import type { HostingAdapterLike } from "./types.js";

/**
 * Configure A365 hosting middleware in a single call.
 *
 * Defaults to enabling both baggage propagation and output logging.
 */
export function configureA365Hosting(
  adapter: HostingAdapterLike,
  options?: ObservabilityHostingOptions,
): ObservabilityHostingManager {
  const manager = new ObservabilityHostingManager();
  manager.configure(adapter, {
    enableBaggage: options?.enableBaggage ?? true,
    enableOutputLogging: options?.enableOutputLogging ?? true,
  });
  return manager;
}
