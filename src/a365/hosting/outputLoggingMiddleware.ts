// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Middleware that creates OutputScope spans for outgoing messages.
 *
 * Adapted from microsoft/Agent365-nodejs agents-a365-observability-hosting/src/middleware/OutputLoggingMiddleware.ts
 */

import { OutputScope } from "../scopes/index.js";
import { ScopeUtils } from "./scopeUtils.js";
import { ensureAgenticActivityHelpers } from "./activityCompat.js";
import { Logger } from "../../shared/logging/index.js";
import type {
  AgentDetails,
  UserDetails,
  Request,
  SpanDetails,
  ParentSpanRef,
} from "../contracts.js";
import type {
  TurnContextLike,
  MiddlewareLike,
  SendActivitiesHandler,
  ActivityLike,
} from "./types.js";

/**
 * TurnState key for the parent span reference.
 * Set this in `turnState` to link OutputScope spans as children of an InvokeAgentScope.
 */
export const A365_PARENT_SPAN_KEY = "A365ParentSpanId";

/**
 * TurnState key for the auth token.
 * Set this in `turnState` so middleware can resolve the agent blueprint ID
 * from token claims (used for embodied/agentic requests).
 */
export const A365_AUTH_TOKEN_KEY = "A365AuthToken";

/**
 * Middleware that creates {@link OutputScope} spans for outgoing messages.
 * Links to a parent span when {@link A365_PARENT_SPAN_KEY} is set in turnState.
 *
 * **Privacy note:** Outgoing message content is captured verbatim
 * as span attributes and exported to the configured telemetry backend.
 */
export class OutputLoggingMiddleware implements MiddlewareLike {
  async onTurn(context: TurnContextLike, next: () => Promise<void>): Promise<void> {
    ensureAgenticActivityHelpers(context.activity);

    const authToken = (context.turnState.get(A365_AUTH_TOKEN_KEY) as string) ?? "";
    const agentDetails = ScopeUtils.deriveAgentDetails(context, authToken);

    if (!agentDetails || !agentDetails.tenantId) {
      await next();
      return;
    }

    const userDetails = ScopeUtils.deriveCallerDetails(context);
    const conversationId = ScopeUtils.deriveConversationId(context);
    const channel = ScopeUtils.deriveChannelObject(context);

    const request: Request = {
      conversationId,
      channel,
    };

    if (context.onSendActivities) {
      context.onSendActivities(
        this._createSendHandler(context, agentDetails, userDetails, request),
      );
    }

    await next();
  }

  private _createSendHandler(
    turnContext: TurnContextLike,
    agentDetails: AgentDetails,
    userDetails?: UserDetails,
    request?: Request,
  ): SendActivitiesHandler {
    return async (
      _ctx: TurnContextLike,
      activities: ActivityLike[],
      sendNext: () => Promise<unknown[]>,
    ) => {
      const messages = activities.filter((a) => a.type === "message" && a.text).map((a) => a.text!);

      if (messages.length === 0) {
        return await sendNext();
      }

      const parentSpanRef = turnContext.turnState.get(A365_PARENT_SPAN_KEY) as
        | ParentSpanRef
        | undefined;
      if (!parentSpanRef) {
        Logger.getInstance().warn(
          `[OutputLoggingMiddleware] No parent span ref in turnState under '${A365_PARENT_SPAN_KEY}'. OutputScope will not be linked to a parent.`,
        );
      }

      const spanDetails: SpanDetails | undefined = parentSpanRef
        ? { parentContext: parentSpanRef }
        : undefined;

      const outputScope = OutputScope.start(
        request ?? {},
        { messages },
        agentDetails,
        userDetails,
        spanDetails,
      );
      try {
        return await sendNext();
      } catch (error) {
        outputScope.recordError(
          error instanceof Error
            ? error
            : new Error(typeof error === "string" ? error : JSON.stringify(error)),
        );
        throw error;
      } finally {
        outputScope.dispose();
      }
    };
  }
}
