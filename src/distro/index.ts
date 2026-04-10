// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export type {
  MicrosoftOpenTelemetryOptions,
  InstrumentationOptions,
  BrowserSdkLoaderOptions,
  A365Options,
} from "./types.js";
export { MICROSOFT_OPENTELEMETRY_VERSION } from "./types.js";

export { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } from "./distro.js";
