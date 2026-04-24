// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";

import { configureA365Hosting } from "../../../../../src/a365/hosting/configureA365Hosting.js";
import { ObservabilityHostingManager } from "../../../../../src/a365/hosting/observabilityHostingManager.js";
import { BaggageMiddleware } from "../../../../../src/a365/hosting/baggageMiddleware.js";
import { OutputLoggingMiddleware } from "../../../../../src/a365/hosting/outputLoggingMiddleware.js";
import type { MiddlewareLike } from "../../../../../src/a365/hosting/types.js";

describe("configureA365Hosting", () => {
  it("should register both middleware by default", () => {
    const registered: MiddlewareLike[] = [];
    const adapter = { use: (...mws: MiddlewareLike[]) => registered.push(...mws) };

    const manager = configureA365Hosting(adapter);

    expect(manager).toBeInstanceOf(ObservabilityHostingManager);
    expect(registered.length).toBe(2);
    expect(registered[0]).toBeInstanceOf(BaggageMiddleware);
    expect(registered[1]).toBeInstanceOf(OutputLoggingMiddleware);
  });

  it("should respect explicit options", () => {
    const registered: MiddlewareLike[] = [];
    const adapter = { use: (...mws: MiddlewareLike[]) => registered.push(...mws) };

    configureA365Hosting(adapter, { enableBaggage: false, enableOutputLogging: true });

    expect(registered.length).toBe(1);
    expect(registered[0]).toBeInstanceOf(OutputLoggingMiddleware);
  });

  it("should allow disabling both middleware", () => {
    const registered: MiddlewareLike[] = [];
    const adapter = { use: (...mws: MiddlewareLike[]) => registered.push(...mws) };

    configureA365Hosting(adapter, { enableBaggage: false, enableOutputLogging: false });

    expect(registered.length).toBe(0);
  });
});
