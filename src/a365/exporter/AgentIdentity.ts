// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Represents the identity of an agent and its acting user.
 *
 * In the AI teammate scenario, {@link agenticUserId} is 1:1 with {@link agentId}.
 * In the S2S scenario, {@link agenticUserId} will be undefined.
 */
export interface AgentIdentity {
  /** The agent identifier. */
  readonly agentId: string;

  /**
   * The agentic user identifier (AAD Object ID), or undefined in S2S scenarios.
   * In the AI teammate scenario, this value is 1:1 with {@link agentId}.
   */
  readonly agenticUserId?: string;
}
