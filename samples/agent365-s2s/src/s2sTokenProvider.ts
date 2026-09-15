// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SampleConfig } from "./config.js";
import type { TokenExchangeClient, TokenExchangeResult } from "./tokenExchangeClient.js";

interface CacheEntry {
  token?: TokenExchangeResult;
  inFlight?: Promise<TokenExchangeResult>;
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFRESH_WINDOW_MILLISECONDS = 60_000;

function normalizeGuid(value: string, key: "agentId" | "tenantId"): string {
  const normalized = value.trim().toLowerCase();
  if (!GUID_PATTERN.test(normalized)) {
    throw new Error(`S2S token identity mismatch (${key}).`);
  }
  return normalized;
}

export class S2STokenProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly configuredAgentId: string;
  private readonly configuredTenantId: string;

  public constructor(
    config: SampleConfig,
    private readonly exchangeClient: TokenExchangeClient,
    private readonly now: () => number = Date.now,
  ) {
    this.configuredAgentId = normalizeGuid(config.agentId, "agentId");
    this.configuredTenantId = normalizeGuid(config.tenantId, "tenantId");
  }

  public async resolve(agentId: string, tenantId: string, _scopes?: string[]): Promise<string> {
    const normalizedAgentId = normalizeGuid(agentId, "agentId");
    const normalizedTenantId = normalizeGuid(tenantId, "tenantId");
    if (normalizedAgentId !== this.configuredAgentId) {
      throw new Error("S2S token identity mismatch (agentId).");
    }
    if (normalizedTenantId !== this.configuredTenantId) {
      throw new Error("S2S token identity mismatch (tenantId).");
    }

    const key = `${normalizedTenantId}:${normalizedAgentId}`;
    let entry = this.cache.get(key);
    if (!entry) {
      entry = {};
      this.cache.set(key, entry);
    }

    if (entry.token && entry.token.expiresOn.getTime() > this.now() + REFRESH_WINDOW_MILLISECONDS) {
      return entry.token.accessToken;
    }

    const inFlight = entry.inFlight ?? (entry.inFlight = this.exchangeClient.exchange());

    try {
      const token = await inFlight;
      entry.token = token;
      return token.accessToken;
    } finally {
      if (entry.inFlight === inFlight) {
        entry.inFlight = undefined;
      }
    }
  }
}
