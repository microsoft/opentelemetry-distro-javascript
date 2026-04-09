// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { A365Configuration, A365_ENV_VARS } from "./configuration/index.js";
export type {
  A365Options,
  ClusterCategory,
  A365BaggageOptions,
  A365HostingOptions,
} from "./configuration/index.js";

export { Agent365Exporter } from "./exporter/index.js";
export type { Agent365ExporterOptions, TokenResolver } from "./exporter/index.js";
export { ResolvedExporterOptions } from "./exporter/index.js";
