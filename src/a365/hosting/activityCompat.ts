// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ActivityLike } from "./types.js";

type ActivityCompatLike = ActivityLike & {
  recipient?: ActivityLike["recipient"] & {
    tenantId?: string;
    agenticAppId?: string;
  };
  conversation?: ActivityLike["conversation"] & {
    tenantId?: string;
  };
};

/**
 * Ensures agentic helper methods exist on plain activity objects.
 *
 * Agent365 hosting utilities read identity via Activity helper methods.
 * CloudAdapter can provide plain JSON activity objects without those methods.
 */
export function ensureAgenticActivityHelpers(activity: ActivityLike | undefined): void {
  const a = activity as ActivityCompatLike | undefined;
  if (!a) {
    return;
  }

  if (typeof a.isAgenticRequest !== "function") {
    a.isAgenticRequest = () => a.recipient?.role === "agenticUser";
  }

  if (typeof a.getAgenticTenantId !== "function") {
    a.getAgenticTenantId = () => a.recipient?.tenantId ?? a.conversation?.tenantId ?? "";
  }

  if (typeof a.getAgenticInstanceId !== "function") {
    a.getAgenticInstanceId = () =>
      a.isAgenticRequest?.() ? (a.recipient?.agenticAppId ?? "") : "";
  }
}
