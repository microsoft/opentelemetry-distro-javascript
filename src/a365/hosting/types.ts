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
  type?: string;
  name?: string;
  text?: string;
  channelId?: string;
  channelIdSubChannel?: string | unknown;
  serviceUrl?: string;
  from?: {
    aadObjectId?: string;
    name?: string;
    role?: string;
    tenantId?: string;
    agenticUserId?: string;
    agenticAppBlueprintId?: string;
    agenticAppId?: string;
  };
  recipient?: {
    aadObjectId?: string;
    name?: string;
    role?: string;
  };
  conversation?: {
    id?: string;
  };
  isAgenticRequest?: () => boolean;
  getAgenticInstanceId?: () => string;
  getAgenticTenantId?: () => string;
  getAgenticUser?: () => string;
}

/** Minimal turn context shape required by hosting observability utilities. */
export interface TurnContextLike {
  activity: ActivityLike;
  turnState: Map<string, unknown>;
  onSendActivities?(handler: SendActivitiesHandler): void;
}

/** Handler for intercepting outgoing activities. */
export type SendActivitiesHandler = (
  ctx: TurnContextLike,
  activities: ActivityLike[],
  sendNext: () => Promise<unknown[]>,
) => Promise<unknown[]>;

/** Middleware interface compatible with agents-hosting adapters. */
export interface MiddlewareLike {
  onTurn(context: TurnContextLike, next: () => Promise<void>): Promise<void>;
}

/** Minimal adapter contract for registering hosting middleware. */
export interface HostingAdapterLike {
  use(...middlewares: Array<MiddlewareLike>): void;
}
