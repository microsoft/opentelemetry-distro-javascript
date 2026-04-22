// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";

import { ObservabilityHostingManager } from "../../../../../src/a365/hosting/observabilityHostingManager.js";
import { BaggageMiddleware } from "../../../../../src/a365/hosting/baggageMiddleware.js";
import { OutputLoggingMiddleware } from "../../../../../src/a365/hosting/outputLoggingMiddleware.js";
import type { MiddlewareLike } from "../../../../../src/a365/hosting/types.js";

describe("ObservabilityHostingManager", () => {
  it("should not register any middleware by default", () => {
    const manager = new ObservabilityHostingManager();
    const registered: MiddlewareLike[] = [];
    const adapter = { use: (...mws: MiddlewareLike[]) => registered.push(...mws) };

    manager.configure(adapter, {});

    expect(registered.length).toBe(0);
  });

  it("should register BaggageMiddleware when enableBaggage is true", () => {
    const manager = new ObservabilityHostingManager();
    const registered: MiddlewareLike[] = [];
    const adapter = { use: (...mws: MiddlewareLike[]) => registered.push(...mws) };

    manager.configure(adapter, { enableBaggage: true });

    expect(registered.length).toBe(1);
    expect(registered[0]).toBeInstanceOf(BaggageMiddleware);
  });

  it("should register OutputLoggingMiddleware when enableOutputLogging is true", () => {
    const manager = new ObservabilityHostingManager();
    const registered: MiddlewareLike[] = [];
    const adapter = { use: (...mws: MiddlewareLike[]) => registered.push(...mws) };

    manager.configure(adapter, { enableOutputLogging: true });

    expect(registered.length).toBe(1);
    expect(registered[0]).toBeInstanceOf(OutputLoggingMiddleware);
  });

  it("should register both middleware when both flags are true", () => {
    const manager = new ObservabilityHostingManager();
    const registered: MiddlewareLike[] = [];
    const adapter = { use: (...mws: MiddlewareLike[]) => registered.push(...mws) };

    manager.configure(adapter, { enableBaggage: true, enableOutputLogging: true });

    expect(registered.length).toBe(2);
    expect(registered[0]).toBeInstanceOf(BaggageMiddleware);
    expect(registered[1]).toBeInstanceOf(OutputLoggingMiddleware);
  });

  it("should ignore subsequent configure() calls", () => {
    const manager = new ObservabilityHostingManager();
    const registered: MiddlewareLike[] = [];
    const adapter = { use: (...mws: MiddlewareLike[]) => registered.push(...mws) };

    manager.configure(adapter, { enableBaggage: true });
    expect(registered.length).toBe(1);

    // Second call should be a no-op
    manager.configure(adapter, { enableBaggage: true, enableOutputLogging: true });
    expect(registered.length).toBe(1);
  });
});
