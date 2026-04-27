// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability-hosting/src/caching/AgenticTokenCache.ts
 */

import { getA365Logger } from "../logging.js";
import type { TurnContextLike } from "./types.js";

/**
 * Minimal authorization shape required by AgenticTokenCache.
 *
 * Mirrors the `Authorization` interface from `@microsoft/agents-hosting`
 * so the cache can be used without a direct dependency on that package.
 */
export interface AuthorizationLike {
  exchangeToken(
    turnContext: TurnContextLike,
    authHandlerName: string,
    options: { scopes: string[] },
  ): Promise<{ token?: string } | undefined>;
}

interface CacheEntry {
  scopes: string[];
  token?: string;
  expiresOn?: number;
  acquiredOn?: number;
}

/**
 * Cache for agentic authentication tokens used by observability services.
 *
 * @example
 * ```typescript
 * // Use the default singleton:
 * import { AgenticTokenCacheInstance } from '@microsoft/opentelemetry';
 *
 * // Or create an instance with custom scopes:
 * const cache = new AgenticTokenCache({ authScopes: ['api://my-scope/.default'] });
 * ```
 */
export class AgenticTokenCache {
  private readonly _map = new Map<string, CacheEntry>();
  private readonly _defaultRefreshSkewMs = 60_000;
  private readonly _defaultMaxTokenAgeMs = 3_600_000;
  private readonly _maxCacheSize = 10_000;
  private readonly _maxExpSeconds = 86_400; // 24 hours
  private readonly _keyLocks = new Map<string, Promise<unknown>>();
  private readonly _authScopes: string[];

  constructor(options?: AgenticTokenCacheOptions) {
    const envScopes = process.env.A365_OBSERVABILITY_SCOPES_OVERRIDE?.trim();
    if (envScopes) {
      this._authScopes = envScopes.split(/\s+/).filter(Boolean);
    } else {
      this._authScopes = options?.authScopes ?? ["api://9b975845-388f-4429-889e-eab1ef63949c/.default"];
    }
  }

  public static makeKey(agentId: string, tenantId: string): string {
    return `${agentId}:${tenantId}`;
  }

  public getObservabilityToken(agentId: string, tenantId: string): string | null {
    const key = AgenticTokenCache.makeKey(agentId, tenantId);
    const entry = this._map.get(key);
    // Touch entry for LRU recency
    if (entry) {
      this._map.delete(key);
      this._map.set(key, entry);
    }
    if (!entry) {
      getA365Logger().error(`[AgenticTokenCache] No cache entry for ${key}`);
      return null;
    }
    if (!entry.token) {
      getA365Logger().error(`[AgenticTokenCache] No token cached for ${key}`);
      return null;
    }
    if (this.isExpired(entry)) {
      getA365Logger().error(`[AgenticTokenCache] Token expired for ${key}`);
      return null;
    }
    return entry.token;
  }

  public async refreshObservabilityToken(
    agentId: string,
    tenantId: string,
    turnContext: TurnContextLike,
    authorization: AuthorizationLike,
    scopes?: string[],
    authHandlerName: string = "agentic",
  ): Promise<void> {
    const key = AgenticTokenCache.makeKey(agentId, tenantId);
    if (!authorization) {
      throw new Error("[AgenticTokenCache] Authorization not set");
    }
    if (!turnContext) {
      throw new Error("[AgenticTokenCache] TurnContext not set");
    }
    return this.withKeyLock<void>(key, async () => {
      let entry = this._map.get(key);
      if (!entry) {
        const effectiveScopes = scopes && scopes.length > 0 ? [...scopes] : [...this._authScopes];
        if (!Array.isArray(effectiveScopes) || effectiveScopes.length === 0) {
          getA365Logger().error("[AgenticTokenCache] No valid scopes");
          return;
        }
        entry = { scopes: effectiveScopes };
        if (this._map.size >= this._maxCacheSize) {
          // Evict least-recently-used (first key in Map insertion order)
          const lruKey = this._map.keys().next().value;
          if (lruKey !== undefined) {
            this._map.delete(lruKey);
          }
        }
        this._map.set(key, entry);
      } else {
        // Touch for LRU recency
        this._map.delete(key);
        this._map.set(key, entry);
        // Update scopes if caller provided new ones
        if (scopes && scopes.length > 0) {
          entry.scopes = [...scopes];
        }
      }
      if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) {
        getA365Logger().error("[AgenticTokenCache] Entry has invalid scopes");
        return;
      }

      if (entry.token && !this.isExpired(entry)) {
        return;
      }

      const maxRetries = 2;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        getA365Logger().info(
          `[AgenticTokenCache] Exchanging token attempt ${attempt + 1}/${maxRetries + 1}`,
        );
        try {
          const tokenResponse = await authorization.exchangeToken(turnContext, authHandlerName, {
            scopes: entry.scopes,
          });
          if (!tokenResponse?.token) {
            getA365Logger().error("[AgenticTokenCache] Undefined token returned");
            entry.token = undefined;
            entry.expiresOn = undefined;
            break;
          }
          entry.token = tokenResponse.token;
          entry.acquiredOn = Date.now();
          const oboExp = this.decodeExp(entry.token);
          if (oboExp) {
            entry.expiresOn = oboExp * 1000;
          } else {
            getA365Logger().warn("[AgenticTokenCache] No exp claim, fallback TTL");
          }
          getA365Logger().info("[AgenticTokenCache] Token cached");
          return;
        } catch (e) {
          const retriable = this.isRetriableError(e);
          if (retriable && attempt < maxRetries) {
            getA365Logger().warn(
              `[AgenticTokenCache] Retriable failure attempt ${attempt + 1}`,
              e instanceof Error ? e.message : String(e),
            );
            await this.sleep(200 * (attempt + 1));
            continue;
          }
          getA365Logger().error(
            "[AgenticTokenCache] Non-retriable failure",
            e instanceof Error ? e.message : String(e),
          );
          entry.token = undefined;
          entry.expiresOn = undefined;
          break;
        }
      }
    });
  }

  public invalidateToken(agentId: string, tenantId: string): void {
    const entry = this._map.get(AgenticTokenCache.makeKey(agentId, tenantId));
    if (entry) {
      entry.token = undefined;
      entry.expiresOn = undefined;
    }
  }

  public invalidateAll(): void {
    this._map.clear();
  }

  private decodeExp(jwt: string): number | undefined {
    try {
      if (!jwt) return undefined;
      const parts = jwt.split(".");
      if (parts.length < 2) return undefined;
      const payloadSegment = parts[1];
      const padded = payloadSegment + "=".repeat((4 - (payloadSegment.length % 4)) % 4);
      const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {
        exp?: unknown;
      };
      if (typeof json.exp !== "number") return undefined;
      const maxExp = Math.floor(Date.now() / 1000) + this._maxExpSeconds;
      return Math.min(json.exp, maxExp);
    } catch {
      return undefined;
    }
  }

  private isExpired(entry: CacheEntry): boolean {
    const now = Date.now();
    if (entry.expiresOn) {
      return now >= entry.expiresOn - this._defaultRefreshSkewMs;
    }
    if (entry.acquiredOn) {
      return now >= entry.acquiredOn + this._defaultMaxTokenAgeMs;
    }
    return true;
  }

  private isRetriableError(err: unknown): boolean {
    const e = err as { code?: string; status?: number; message?: string } | undefined;
    if (!e) return false;
    const msg = (e.message || "").toLowerCase();
    if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("network"))
      return true;
    if (typeof e.status === "number") {
      if (e.status === 408 || e.status === 429) return true;
      if (e.status >= 500 && e.status < 600) return true;
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Chain onto any existing promise for this key so that concurrent
    // callers are serialised rather than racing after the same await.
    const previous = this._keyLocks.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        /* swallow */
      })
      .then(fn);
    this._keyLocks.set(key, next);
    // Clean up the lock when the chain settles and hasn't been extended.
    next.finally(() => {
      if (this._keyLocks.get(key) === next) {
        this._keyLocks.delete(key);
      }
    });
    return next;
  }
}

/**
 * Options for constructing an AgenticTokenCache instance.
 */
export interface AgenticTokenCacheOptions {
  /** OAuth scopes for token exchange. Defaults to the A365 observability scope. */
  authScopes?: string[];
}

/**
 * Default singleton instance of AgenticTokenCache using the default configuration.
 */
export const AgenticTokenCacheInstance = new AgenticTokenCache();
