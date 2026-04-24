// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { BaggageBuilderUtils } from "./baggageBuilderUtils.js";
export { ScopeUtils } from "./scopeUtils.js";
export {
  getCallerBaggagePairs,
  getTargetAgentBaggagePairs,
  getTenantIdPair,
  getChannelBaggagePairs,
  getConversationIdAndItemLinkPairs,
  resolveEmbodiedAgentIds,
} from "./turnContextUtils.js";
export { BaggageMiddleware } from "./baggageMiddleware.js";
export {
  OutputLoggingMiddleware,
  A365_PARENT_SPAN_KEY,
  A365_AUTH_TOKEN_KEY,
} from "./outputLoggingMiddleware.js";
export { ObservabilityHostingManager } from "./observabilityHostingManager.js";
export type { ObservabilityHostingOptions } from "./observabilityHostingManager.js";
export { configureA365Hosting } from "./configureA365Hosting.js";
export type {
  HostingAdapterLike,
  TurnContextLike,
  ActivityLike,
  MiddlewareLike,
  SendActivitiesHandler,
} from "./types.js";
