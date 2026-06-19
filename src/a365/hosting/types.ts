// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Minimal interfaces for hosting-layer observability middleware.
 *
 * These types mirror the shapes from `@microsoft/agents-hosting` and
 * `@microsoft/agents-activity` so the hosting utilities can be used
 * without taking a dependency on those packages directly. Consumers
 * using agents-hosting can pass their TurnContext/Middleware instances
 * directly since they satisfy these interfaces structurally.
 */

/** Minimal activity shape required by hosting observability utilities. */
export interface ActivityLike {
  /** The activity type (e.g. `message`, `event`). */
  type?: string;
  /** The activity name (used for event activities). */
  name?: string;
  /** The text content of the activity. */
  text?: string;
  /** Identifier of the channel the activity arrived on. */
  channelId?: string;
  /** Identifier of the channel sub-channel, when applicable. */
  channelIdSubChannel?: string | unknown;
  /** Channel-specific payload data. */
  channelData?: unknown;
  /** Service URL used to send replies back to the channel. */
  serviceUrl?: string;
  /** The sender of the activity. */
  from?: {
    /** AAD Object ID of the sender. */
    aadObjectId?: string;
    /** Display name of the sender. */
    name?: string;
    /** Role of the sender (e.g. `user`, `bot`). */
    role?: string;
    /** Tenant identifier of the sender. */
    tenantId?: string;
    /** Agentic user identifier of the sender. */
    agenticUserId?: string;
    /** Agentic application blueprint identifier of the sender. */
    agenticAppBlueprintId?: string;
    /** Agentic application identifier of the sender. */
    agenticAppId?: string;
  };
  /** The recipient of the activity. */
  recipient?: {
    /** AAD Object ID of the recipient. */
    aadObjectId?: string;
    /** Display name of the recipient. */
    name?: string;
    /** Role of the recipient (e.g. `user`, `bot`). */
    role?: string;
  };
  /** The conversation the activity belongs to. */
  conversation?: {
    /** Identifier of the conversation. */
    id?: string;
  };
  /** Returns whether this activity represents an agentic request. */
  isAgenticRequest?: () => boolean;
  /** Returns the agentic instance identifier, if any. */
  getAgenticInstanceId?: () => string | undefined;
  /** Returns the agentic tenant identifier. */
  getAgenticTenantId?: () => string;
  /** Returns the agentic user identifier. */
  getAgenticUser?: () => string;
}

/** Minimal turn context shape required by hosting observability utilities. */
export interface TurnContextLike {
  /** The activity being processed for this turn. */
  activity: ActivityLike;
  /** Per-turn state shared between middleware. */
  turnState: Map<string, unknown>;
  /** Registers a handler invoked before activities are sent. */
  onSendActivities?(handler: SendActivitiesHandler): void;
}

/**
 * Handler for intercepting outgoing activities.
 *
 * @param ctx The current turn context.
 * @param activities The activities about to be sent.
 * @param sendNext Invokes the next handler in the chain and returns its results.
 * @returns The results of sending the activities.
 */
export type SendActivitiesHandler = (
  ctx: TurnContextLike,
  activities: ActivityLike[],
  sendNext: () => Promise<unknown[]>,
) => Promise<unknown[]>;

/** Middleware interface compatible with agents-hosting adapters. */
export interface MiddlewareLike {
  /**
   * Processes a turn and invokes the next middleware.
   *
   * @param context The current turn context.
   * @param next Invokes the next middleware in the pipeline.
   */
  onTurn(context: TurnContextLike, next: () => Promise<void>): Promise<void>;
}

/** Minimal adapter contract for registering hosting middleware. */
export interface HostingAdapterLike {
  /**
   * Registers one or more middleware with the adapter.
   *
   * @param middlewares The middleware to register.
   */
  use(...middlewares: Array<MiddlewareLike>): void;
}
