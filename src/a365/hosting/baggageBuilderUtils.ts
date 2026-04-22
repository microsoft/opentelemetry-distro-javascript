// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Utilities to populate BaggageBuilder from a TurnContext.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability-hosting/src/utils/BaggageBuilderUtils.ts
 */

import { BaggageBuilder } from "../middleware/BaggageBuilder.js";
import type { TurnContextLike } from "./types.js";
import {
  getCallerBaggagePairs,
  getTargetAgentBaggagePairs,
  getTenantIdPair,
  getChannelBaggagePairs,
  getConversationIdAndItemLinkPairs,
} from "./turnContextUtils.js";

/**
 * Utilities to populate BaggageBuilder from a TurnContext.
 */
export class BaggageBuilderUtils {
  /**
   * Populate all supported baggage pairs from the provided TurnContext.
   */
  static fromTurnContext(builder: BaggageBuilder, turnContext: TurnContextLike): BaggageBuilder {
    if (!turnContext) {
      throw new Error("turnContext is required");
    }
    this.setCallerBaggage(builder, turnContext);
    this.setTargetAgentBaggage(builder, turnContext);
    this.setTenantIdBaggage(builder, turnContext);
    this.setChannelBaggage(builder, turnContext);
    this.setConversationIdBaggage(builder, turnContext);
    return builder;
  }

  static setCallerBaggage(builder: BaggageBuilder, turnContext: TurnContextLike): BaggageBuilder {
    builder.setPairs(getCallerBaggagePairs(turnContext));
    return builder;
  }

  static setTargetAgentBaggage(
    builder: BaggageBuilder,
    turnContext: TurnContextLike,
  ): BaggageBuilder {
    builder.setPairs(getTargetAgentBaggagePairs(turnContext));
    return builder;
  }

  static setTenantIdBaggage(builder: BaggageBuilder, turnContext: TurnContextLike): BaggageBuilder {
    builder.setPairs(getTenantIdPair(turnContext));
    return builder;
  }

  static setChannelBaggage(builder: BaggageBuilder, turnContext: TurnContextLike): BaggageBuilder {
    builder.setPairs(getChannelBaggagePairs(turnContext));
    return builder;
  }

  static setConversationIdBaggage(
    builder: BaggageBuilder,
    turnContext: TurnContextLike,
  ): BaggageBuilder {
    builder.setPairs(getConversationIdAndItemLinkPairs(turnContext));
    return builder;
  }
}
