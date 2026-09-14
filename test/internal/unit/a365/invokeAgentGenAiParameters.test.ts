// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert, describe, it } from "vitest";
import { OpenTelemetryConstants } from "../../../../src/index.js";
import type {
  GenAiRequestParameters as RootGenAiRequestParameters,
  GenAiResponseParameters as RootGenAiResponseParameters,
  InvokeAgentScopeDetails as RootInvokeAgentScopeDetails,
} from "../../../../src/index.js";
import type {
  GenAiRequestParameters,
  GenAiResponseParameters,
  InvokeAgentScopeDetails,
  ServiceEndpoint,
} from "../../../../src/a365/index.js";

type Expect<T extends true> = T;
type Equal<Left, Right> =
  (<Candidate>() => Candidate extends Left ? 1 : 2) extends <Candidate>() => Candidate extends Right
    ? 1
    : 2
    ? true
    : false;
type IsOptional<T, K extends keyof T> = Omit<T, K> extends T ? true : false;

type _RootRequestParametersExportMatchesA365 = Expect<
  Equal<RootGenAiRequestParameters, GenAiRequestParameters>
>;
type _RootResponseParametersExportMatchesA365 = Expect<
  Equal<RootGenAiResponseParameters, GenAiResponseParameters>
>;
type _RequestModelIsOptionalString = Expect<
  Equal<GenAiRequestParameters["model"], string | undefined>
>;
type _RequestSeedIsOptionalNumber = Expect<
  Equal<GenAiRequestParameters["seed"], number | undefined>
>;
type _RequestChoiceCountIsOptionalNumber = Expect<
  Equal<GenAiRequestParameters["choiceCount"], number | undefined>
>;
type _RequestFrequencyPenaltyIsOptionalNumber = Expect<
  Equal<GenAiRequestParameters["frequencyPenalty"], number | undefined>
>;
type _RequestMaxTokensIsOptionalNumber = Expect<
  Equal<GenAiRequestParameters["maxTokens"], number | undefined>
>;
type _RequestPresencePenaltyIsOptionalNumber = Expect<
  Equal<GenAiRequestParameters["presencePenalty"], number | undefined>
>;
type _RequestStopSequencesIsOptionalStringArray = Expect<
  Equal<GenAiRequestParameters["stopSequences"], string[] | undefined>
>;
type _RequestTemperatureIsOptionalNumber = Expect<
  Equal<GenAiRequestParameters["temperature"], number | undefined>
>;
type _RequestTopPIsOptionalNumber = Expect<
  Equal<GenAiRequestParameters["topP"], number | undefined>
>;
type _RequestDataSourceIdIsOptionalString = Expect<
  Equal<GenAiRequestParameters["dataSourceId"], string | undefined>
>;
type _RequestOutputTypeIsOptionalString = Expect<
  Equal<GenAiRequestParameters["outputType"], string | undefined>
>;
type _RequestSystemInstructionsIsOptionalString = Expect<
  Equal<GenAiRequestParameters["systemInstructions"], string | undefined>
>;
type _ResponseFinishReasonsIsOptionalStringArray = Expect<
  Equal<GenAiResponseParameters["finishReasons"], string[] | undefined>
>;
type _ResponseInputTokensIsOptionalNumber = Expect<
  Equal<GenAiResponseParameters["inputTokens"], number | undefined>
>;
type _ResponseOutputTokensIsOptionalNumber = Expect<
  Equal<GenAiResponseParameters["outputTokens"], number | undefined>
>;
type _ResponseCacheCreationInputTokensIsOptionalNumber = Expect<
  Equal<GenAiResponseParameters["cacheCreationInputTokens"], number | undefined>
>;
type _ResponseCacheReadInputTokensIsOptionalNumber = Expect<
  Equal<GenAiResponseParameters["cacheReadInputTokens"], number | undefined>
>;
type _InvokeAgentScopeDetailsEndpointIsPreserved = Expect<
  Equal<InvokeAgentScopeDetails["endpoint"], ServiceEndpoint | undefined>
>;
type _InvokeAgentScopeDetailsHasOptionalRequestParameters = Expect<
  IsOptional<InvokeAgentScopeDetails, "requestParameters">
>;
type _InvokeAgentScopeDetailsHasOptionalResponseParameters = Expect<
  IsOptional<InvokeAgentScopeDetails, "responseParameters">
>;

describe("InvokeAgent GenAI parameter contracts", () => {
  it("accepts request and response parameters on invoke agent scope details", () => {
    const requestParameters: RootGenAiRequestParameters = {
      model: "gpt-4.1",
      seed: 42,
      choiceCount: 2,
      frequencyPenalty: 0.25,
      maxTokens: 512,
      presencePenalty: -0.5,
      stopSequences: ["DONE", "STOP"],
      temperature: 0.2,
      topP: 0.8,
      dataSourceId: "sharepoint",
      outputType: "json",
      systemInstructions: "Answer with JSON only.",
    };
    const responseParameters: RootGenAiResponseParameters = {
      finishReasons: ["stop"],
      inputTokens: 120,
      outputTokens: 48,
      cacheCreationInputTokens: 12,
      cacheReadInputTokens: 3,
    };
    const scopeDetails: RootInvokeAgentScopeDetails = {
      endpoint: { host: "agents.contoso.com", port: 443, protocol: "https" },
      requestParameters,
      responseParameters,
    };

    assert.deepStrictEqual(scopeDetails.requestParameters, requestParameters);
    assert.deepStrictEqual(scopeDetails.responseParameters, responseParameters);
    assert.strictEqual(scopeDetails.endpoint?.host, "agents.contoso.com");
  });

  it("defines invoke-agent GenAI semantic-convention constants", () => {
    assert.strictEqual(OpenTelemetryConstants.GEN_AI_DATA_SOURCE_ID_KEY, "gen_ai.data_source.id");
    assert.strictEqual(OpenTelemetryConstants.GEN_AI_OUTPUT_TYPE_KEY, "gen_ai.output.type");
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_REQUEST_CHOICE_COUNT_KEY,
      "gen_ai.request.choice.count",
    );
    assert.strictEqual(OpenTelemetryConstants.GEN_AI_REQUEST_SEED_KEY, "gen_ai.request.seed");
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_REQUEST_FREQUENCY_PENALTY_KEY,
      "gen_ai.request.frequency_penalty",
    );
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_REQUEST_PRESENCE_PENALTY_KEY,
      "gen_ai.request.presence_penalty",
    );
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_REQUEST_STOP_SEQUENCES_KEY,
      "gen_ai.request.stop_sequences",
    );
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS_KEY,
      "gen_ai.usage.cache_creation.input_tokens",
    );
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS_KEY,
      "gen_ai.usage.cache_read.input_tokens",
    );
    assert.strictEqual(OpenTelemetryConstants.GEN_AI_REQUEST_MODEL_KEY, "gen_ai.request.model");
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_REQUEST_MAX_TOKENS_KEY,
      "gen_ai.request.max_tokens",
    );
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_REQUEST_TEMPERATURE_KEY,
      "gen_ai.request.temperature",
    );
    assert.strictEqual(OpenTelemetryConstants.GEN_AI_REQUEST_TOP_P_KEY, "gen_ai.request.top_p");
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_SYSTEM_INSTRUCTIONS_KEY,
      "gen_ai.system_instructions",
    );
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_RESPONSE_FINISH_REASONS_KEY,
      "gen_ai.response.finish_reasons",
    );
    assert.strictEqual(OpenTelemetryConstants.GEN_AI_PROVIDER_NAME_KEY, "gen_ai.provider.name");
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_USAGE_INPUT_TOKENS_KEY,
      "gen_ai.usage.input_tokens",
    );
    assert.strictEqual(
      OpenTelemetryConstants.GEN_AI_USAGE_OUTPUT_TOKENS_KEY,
      "gen_ai.usage.output_tokens",
    );
  });
});
