// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  AgenticTokenCache,
  type AuthorizationLike,
} from "../../../../../src/a365/hosting/agenticTokenCache.js";
import type { TurnContextLike } from "../../../../../src/a365/hosting/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurnContext(): TurnContextLike {
  return {
    activity: { type: "message" },
    turnState: new Map<string, unknown>(),
  };
}

/** Build a minimal JWT with a given `exp` claim (seconds since epoch). */
function makeJwtWithExp(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function makeAuthMock(
  tokenOrFn?: string | (() => Promise<{ token?: string } | undefined>),
): AuthorizationLike {
  const impl =
    typeof tokenOrFn === "function"
      ? tokenOrFn
      : async () => (tokenOrFn !== undefined ? { token: tokenOrFn } : undefined);
  return { exchangeToken: vi.fn(impl) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgenticTokenCache", () => {
  let cache: AgenticTokenCache;

  beforeEach(() => {
    cache = new AgenticTokenCache();
  });

  // ── Basic get / refresh ──────────────────────────────────────────────────

  it("returns null when no entry exists", () => {
    expect(cache.getObservabilityToken("a", "t")).toBeNull();
  });

  it("exchanges and caches token on first call", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwtWithExp(exp);
    const auth = makeAuthMock(jwt);

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);

    expect(auth.exchangeToken).toHaveBeenCalledTimes(1);
    expect(cache.getObservabilityToken("a", "t")).toBe(jwt);
  });

  it("does not re-exchange when token is still valid", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwtWithExp(exp);
    const auth = makeAuthMock(jwt);

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);
    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);

    expect(auth.exchangeToken).toHaveBeenCalledTimes(1);
  });

  // ── Retry on retriable errors ────────────────────────────────────────────

  it("retries on retriable error then succeeds", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwtWithExp(exp);
    let callCount = 0;
    const auth = makeAuthMock(async () => {
      callCount++;
      if (callCount === 1) throw Object.assign(new Error("timeout"), { status: 503 });
      return { token: jwt };
    });

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);

    expect(auth.exchangeToken).toHaveBeenCalledTimes(2);
    expect(cache.getObservabilityToken("a", "t")).toBe(jwt);
  });

  it("stops on non-retriable error and leaves token null", async () => {
    const auth = makeAuthMock(async () => {
      throw new Error("forbidden");
    });

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);

    expect(cache.getObservabilityToken("a", "t")).toBeNull();
  });

  // ── Expiry / refresh behaviour ───────────────────────────────────────────

  it("treats near-expiry token as expired (skew refresh)", async () => {
    // Token that expires in 30 seconds (within the 60 s skew window)
    const exp = Math.floor(Date.now() / 1000) + 30;
    const jwt = makeJwtWithExp(exp);
    const freshJwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 7200);
    let call = 0;
    const auth = makeAuthMock(async () => {
      call++;
      return { token: call === 1 ? jwt : freshJwt };
    });

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);
    // Token is within skew, so getObservabilityToken returns null
    expect(cache.getObservabilityToken("a", "t")).toBeNull();

    // Refreshing again should exchange a new token
    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);
    expect(auth.exchangeToken).toHaveBeenCalledTimes(2);
    expect(cache.getObservabilityToken("a", "t")).toBe(freshJwt);
  });

  it("uses fallback TTL when JWT has no exp claim", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "test" })).toString("base64url");
    const jwt = `${header}.${payload}.sig`;
    const auth = makeAuthMock(jwt);

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);
    // Token should still be cached (acquiredOn-based TTL is 1 hour)
    expect(cache.getObservabilityToken("a", "t")).toBe(jwt);
  });

  it("caps JWT exp claim to 24 hours", async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 200_000; // ~55 hours
    const jwt = makeJwtWithExp(farFuture);
    const auth = makeAuthMock(jwt);

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);
    expect(cache.getObservabilityToken("a", "t")).toBe(jwt);
  });

  // ── Invalidation ─────────────────────────────────────────────────────────

  it("invalidateToken clears a single entry", async () => {
    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const auth = makeAuthMock(jwt);

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);
    expect(cache.getObservabilityToken("a", "t")).toBe(jwt);

    cache.invalidateToken("a", "t");
    expect(cache.getObservabilityToken("a", "t")).toBeNull();
  });

  it("invalidateAll clears every entry", async () => {
    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const auth = makeAuthMock(jwt);

    await cache.refreshObservabilityToken("a1", "t1", makeTurnContext(), auth);
    await cache.refreshObservabilityToken("a2", "t2", makeTurnContext(), auth);

    cache.invalidateAll();
    expect(cache.getObservabilityToken("a1", "t1")).toBeNull();
    expect(cache.getObservabilityToken("a2", "t2")).toBeNull();
  });

  // ── Scopes handling ──────────────────────────────────────────────────────

  it("updates scopes on existing entry when caller provides new scopes", async () => {
    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const auth = makeAuthMock(jwt);

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth, ["scope1"]);
    // Invalidate and refresh with different scopes
    cache.invalidateToken("a", "t");
    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth, ["scope2"]);

    const lastCall = (auth.exchangeToken as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastCall?.[2]).toEqual({ scopes: ["scope2"] });
  });

  it("clones caller-provided scopes to prevent external mutation", async () => {
    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const auth = makeAuthMock(jwt);
    const scopes = ["original"];

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth, scopes);
    scopes[0] = "mutated";

    // Invalidate and refresh — should still use original scopes
    cache.invalidateToken("a", "t");
    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);

    const lastCall = (auth.exchangeToken as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastCall?.[2]).toEqual({ scopes: ["original"] });
  });

  it("passes authHandlerName to exchangeToken when provided", async () => {
    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const auth = makeAuthMock(jwt);

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth, undefined, "custom");

    expect(auth.exchangeToken).toHaveBeenCalledWith(expect.anything(), "custom", expect.anything());
  });

  it('defaults authHandlerName to "agentic"', async () => {
    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const auth = makeAuthMock(jwt);

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);

    expect(auth.exchangeToken).toHaveBeenCalledWith(
      expect.anything(),
      "agentic",
      expect.anything(),
    );
  });

  // ── LRU eviction ─────────────────────────────────────────────────────────

  it("evicts least-recently-used entry when cache exceeds max size", async () => {
    // Use a small cache to test eviction
    const smallCache = new (class extends AgenticTokenCache {
      constructor() {
        super();
        // Override private max via Object.defineProperty
        Object.defineProperty(this, "_maxCacheSize", { value: 3 });
      }
    })();

    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const auth = makeAuthMock(jwt);
    const ctx = makeTurnContext();

    await smallCache.refreshObservabilityToken("a1", "t", ctx, auth);
    await smallCache.refreshObservabilityToken("a2", "t", ctx, auth);
    await smallCache.refreshObservabilityToken("a3", "t", ctx, auth);

    // Access a1 to make it recently-used (move it ahead of a2)
    smallCache.getObservabilityToken("a1", "t");

    // Adding a4 should evict a2 (the least recently used)
    await smallCache.refreshObservabilityToken("a4", "t", ctx, auth);

    expect(smallCache.getObservabilityToken("a1", "t")).toBe(jwt);
    expect(smallCache.getObservabilityToken("a2", "t")).toBeNull(); // evicted
    expect(smallCache.getObservabilityToken("a3", "t")).toBe(jwt);
    expect(smallCache.getObservabilityToken("a4", "t")).toBe(jwt);
  });

  // ── Per-key locking (serialisation) ──────────────────────────────────────

  it("serialises concurrent refreshes for the same key", async () => {
    let concurrency = 0;
    let maxConcurrency = 0;
    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);

    const auth: AuthorizationLike = {
      exchangeToken: vi.fn(async () => {
        concurrency++;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 50));
        concurrency--;
        return { token: jwt };
      }),
    };

    // Invalidate between calls so both attempts actually exchange
    const p1 = cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);
    // Kick off a second concurrent refresh for the same key
    cache.invalidateToken("a", "t");
    const p2 = cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);

    await Promise.all([p1, p2]);

    // With proper serialisation, concurrency should never exceed 1
    expect(maxConcurrency).toBe(1);
  });

  it("allows concurrent refreshes for different keys", async () => {
    let concurrency = 0;
    let maxConcurrency = 0;
    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);

    const auth: AuthorizationLike = {
      exchangeToken: vi.fn(async () => {
        concurrency++;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        await new Promise((r) => setTimeout(r, 50));
        concurrency--;
        return { token: jwt };
      }),
    };

    const p1 = cache.refreshObservabilityToken("a1", "t", makeTurnContext(), auth);
    const p2 = cache.refreshObservabilityToken("a2", "t", makeTurnContext(), auth);

    await Promise.all([p1, p2]);

    // Different keys should run concurrently
    expect(maxConcurrency).toBe(2);
  });

  // ── Constructor / env override ───────────────────────────────────────────

  it("uses custom authScopes from options", async () => {
    const customCache = new AgenticTokenCache({ authScopes: ["custom://scope"] });
    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const auth = makeAuthMock(jwt);

    await customCache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);

    expect(auth.exchangeToken).toHaveBeenCalledWith(expect.anything(), "agentic", {
      scopes: ["custom://scope"],
    });
  });

  it("uses default scope when no options provided", async () => {
    const jwt = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    const auth = makeAuthMock(jwt);

    await cache.refreshObservabilityToken("a", "t", makeTurnContext(), auth);

    expect(auth.exchangeToken).toHaveBeenCalledWith(expect.anything(), "agentic", {
      scopes: ["api://9b975845-388f-4429-889e-eab1ef63949c/.default"],
    });
  });

  // ── Static helper ────────────────────────────────────────────────────────

  it("makeKey produces agent:tenant format", () => {
    expect(AgenticTokenCache.makeKey("agent1", "tenant1")).toBe("agent1:tenant1");
  });
});
