// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AgentIdentity } from "./AgentIdentity.js";

/**
 * Provides contextual information to the contextual token resolver delegate.
 *
 * {@link identity} provides first-class access to agent identity fields (agent ID,
 * agentic user ID). {@link tenantId} and {@link identity} together identify the
 * cache key.
 */
export interface TokenResolverContext {
  /**
   * The agent identity associated with this token resolution request.
   * Contains the agent ID and agentic user ID (AAD Object ID) as first-class properties.
   */
  readonly identity: AgentIdentity;

  /** The tenant identifier (part of the cache key). */
  readonly tenantId: string;
}
