// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ILogger } from "@microsoft/opentelemetry";

export const safeConsoleLogger: ILogger = {
  info(message: string): void {
    console.info(message);
  },
  warn(message: string): void {
    console.warn(message);
  },
  error(message: string): void {
    console.error(message);
  },
};
