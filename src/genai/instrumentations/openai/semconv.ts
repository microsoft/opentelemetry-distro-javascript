// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-openai
// Adapted: uses local semconv constants instead of A365 imports

// Span kind classifiers (map OpenAI span data types to GenAI operation kinds)
export const GEN_AI_SPAN_KIND_AGENT = "agent" as const;
export const GEN_AI_SPAN_KIND_TOOL = "tool" as const;
export const GEN_AI_SPAN_KIND_CHAIN = "chain" as const;
export const GEN_AI_SPAN_KIND_CHAT = "chat" as const;

// OpenAI-specific span attribute keys (not in OTel semconv)
export const GEN_AI_REQUEST_CONTENT_KEY = "gen_ai.request.content" as const;
export const GEN_AI_RESPONSE_CONTENT_KEY = "gen_ai.response.content" as const;
export const GEN_AI_EXECUTION_PAYLOAD_KEY = "gen_ai.execution.payload" as const;
export const GEN_AI_GRAPH_NODE_ID = "graph_node_id" as const;
export const GEN_AI_GRAPH_NODE_PARENT_ID = "graph_node_parent_id" as const;
