// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Represents the identity of an agent and its acting user.
 *
 * In agentic user scenarios, {@link agenticUserId} identifies the specific user
 * in the current interaction so the token resolver can generate a user-scoped token.
 * In S2S scenarios, {@link agenticUserId} will be undefined.
 */
export interface AgentIdentity {
  /** The agent identifier. */
  readonly agentId: string;

  /**
   * The agentic user identifier (AAD Object ID), or undefined in S2S scenarios.
   * Present when token generation depends on the specific user in the current interaction.
   */
  readonly agenticUserId?: string;
}
