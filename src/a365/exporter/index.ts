// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { Agent365Exporter } from "./Agent365Exporter.js";
export type {
  Agent365ExporterOptions,
  TokenResolver,
  ContextualTokenResolver,
} from "./Agent365ExporterOptions.js";
export { ResolvedExporterOptions } from "./Agent365ExporterOptions.js";
export type { AgentIdentity } from "./AgentIdentity.js";
export type { TokenResolverContext } from "./TokenResolverContext.js";
export { ExporterEventNames } from "./ExporterEventNames.js";
export { truncateSpan, MAX_SPAN_SIZE_BYTES } from "./utils.js";
