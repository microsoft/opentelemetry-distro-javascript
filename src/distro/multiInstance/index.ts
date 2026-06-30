// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { createMicrosoftOpenTelemetryInstance } from "./instance.js";
export {
  withInstance as runWithMicrosoftOpenTelemetryInstance,
  getCurrentInstanceId as _getCurrentInstanceId,
} from "./instanceRegistry.js";
