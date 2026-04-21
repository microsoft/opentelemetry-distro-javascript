// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Re-export from the main types file for backward compatibility.
export type {
  MicrosoftOpenTelemetryOptions,
  InstrumentationOptions,
  BrowserSdkLoaderOptions,
} from "../types.js";
export type { A365Options } from "../a365/index.js";
export { MICROSOFT_OPENTELEMETRY_VERSION } from "../types.js";
