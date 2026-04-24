// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Middleware that propagates OpenTelemetry baggage context derived from TurnContext.
 * Async replies (ContinueConversation events) are passed through without baggage setup.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability-hosting/src/middleware/BaggageMiddleware.ts
 */

import { BaggageBuilder } from "../middleware/BaggageBuilder.js";
import type { TurnContextLike, MiddlewareLike } from "./types.js";
import {
  getCallerBaggagePairs,
  getTargetAgentBaggagePairs,
  getTenantIdPair,
  getChannelBaggagePairs,
  getConversationIdAndItemLinkPairs,
} from "./turnContextUtils.js";
import { ensureAgenticActivityHelpers } from "./activityCompat.js";

/**
 * Middleware that propagates OpenTelemetry baggage context derived from TurnContext.
 * Async replies (ContinueConversation) are passed through without baggage setup.
 */
export class BaggageMiddleware implements MiddlewareLike {
  async onTurn(context: TurnContextLike, next: () => Promise<void>): Promise<void> {
    ensureAgenticActivityHelpers(context.activity);

    const isAsyncReply =
      context.activity?.type === "event" && context.activity?.name === "ContinueConversation";

    if (isAsyncReply) {
      await next();
      return;
    }

    const baggageScope = new BaggageBuilder()
      .setPairs(getCallerBaggagePairs(context))
      .setPairs(getTargetAgentBaggagePairs(context))
      .setPairs(getTenantIdPair(context))
      .setPairs(getChannelBaggagePairs(context))
      .setPairs(getConversationIdAndItemLinkPairs(context))
      .build();

    await baggageScope.run(async () => {
      await next();
    });
  }
}
