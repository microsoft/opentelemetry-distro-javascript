// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, expectTypeOf, it } from "vitest";

import * as a365 from "../../../../src/a365/index.js";
import * as rootExports from "../../../../src/index.js";
import type { ToolCallDetails } from "../../../../src/a365/index.js";

describe("execute tool JSON models", () => {
  it("exports execute tool model values from the A365 and root barrels", () => {
    expect(a365.ExecuteToolCallArguments).toBeDefined();
    expect(a365.ExecuteToolCallResult).toBeDefined();
    expect(a365.ToolCallAction).toBeDefined();
    expect(a365.ToolCallOutcomeStatus).toBeDefined();
    expect(a365.ToolPolicyDecision).toBeDefined();

    expect(rootExports.ExecuteToolCallArguments).toBe(a365.ExecuteToolCallArguments);
    expect(rootExports.ExecuteToolCallResult).toBe(a365.ExecuteToolCallResult);
    expect(rootExports.ToolCallAction).toBe(a365.ToolCallAction);
    expect(rootExports.ToolCallOutcomeStatus).toBe(a365.ToolCallOutcomeStatus);
    expect(rootExports.ToolPolicyDecision).toBe(a365.ToolPolicyDecision);
  });

  it("defaults schema_version when execute tool call arguments are constructed with no input", () => {
    const argumentsModel = new a365.ExecuteToolCallArguments();

    expect(argumentsModel).toEqual({ schema_version: "1.0" });
  });

  it("defaults schema_version when execute tool call results are constructed with no input", () => {
    const resultModel = new a365.ExecuteToolCallResult();

    expect(resultModel).toEqual({ schema_version: "1.0" });
  });

  it("defaults schema_version on execute tool call arguments and preserves explicit values", () => {
    const defaultArgs = new a365.ExecuteToolCallArguments({
      action: a365.ToolCallAction.READ,
      resources: [
        {
          id: "drive-item-1",
          uri: "https://contoso.example/items/1",
          name: "Quarterly plan",
          type: "document",
          provider: "sharepoint",
          identifiers: [{ type: "driveItem", value: "1", provider_code: "sp" }],
          container: {
            id: "folder-1",
            uri: "https://contoso.example/folders/1",
            type: "folder",
            label_id: "container-label",
          },
          custom_resource_field: true,
        },
      ],
      parameters: { query: "plan" },
      top_level_extra: "kept",
    });

    expect(defaultArgs).toMatchObject({
      schema_version: "1.0",
      action: "read",
      resources: [
        {
          identifiers: [{ type: "driveItem", value: "1", provider_code: "sp" }],
          container: { label_id: "container-label" },
          custom_resource_field: true,
        },
      ],
      top_level_extra: "kept",
    });

    const explicitArgs = new a365.ExecuteToolCallArguments({ schema_version: "2.0" });
    expect(explicitArgs.schema_version).toBe("2.0");
  });

  it("allows execute tool call argument models in ToolCallDetails.arguments", () => {
    const argumentsModel = new a365.ExecuteToolCallArguments({
      action: a365.ToolCallAction.READ,
      parameters: { query: "plan" },
    });
    const existingObjectArguments: ToolCallDetails = {
      toolName: "search",
      arguments: { query: "plan" },
    };
    const existingStringArguments: ToolCallDetails = {
      toolName: "search",
      arguments: '{"query":"plan"}',
    };
    const details: ToolCallDetails = {
      toolName: "search",
      arguments: argumentsModel,
    };

    expect(existingObjectArguments.arguments).toEqual({ query: "plan" });
    expect(existingStringArguments.arguments).toBe('{"query":"plan"}');
    expect(details.arguments).toBe(argumentsModel);
    expectTypeOf(details.arguments).toMatchTypeOf<Record<string, unknown> | string | undefined>();
  });

  it("defaults schema_version on execute tool call results and preserves exact wire fields", () => {
    const defaultResult = new a365.ExecuteToolCallResult({
      outcome: {
        status: a365.ToolCallOutcomeStatus.SUCCESS,
        code: "200",
        provider_code: "graph-ok",
        message: "Completed",
      },
      resources: [
        {
          id: "doc-1",
          uri: "https://contoso.example/items/1",
          name: "Quarterly plan",
          type: "document",
          provider: "sharepoint",
          identifiers: [{ type: "driveItem", value: "1", provider_code: "sp" }],
          container: {
            id: "folder-1",
            uri: "https://contoso.example/folders/1",
            type: "folder",
          },
          outcome: {
            status: a365.ToolCallOutcomeStatus.FAILURE,
            provider_code: "partial-failure",
            message: "1 record skipped",
          },
          sensitivity: { label_id: "secret", sensitivity_extra: "kept" },
          policy: {
            decision: a365.ToolPolicyDecision.ALLOW,
            id: "policy-1",
            name: "AllowPolicy",
          },
          security: { xpia_detected: true },
          data: { skipped: 1 },
          resource_extra: "kept",
        },
      ],
      data: { documents: 1 },
      pagination: { has_more: true, next_cursor: "cursor-2", total_count: 10 },
      result_extra: "kept",
    });

    expect(defaultResult).toMatchObject({
      schema_version: "1.0",
      outcome: {
        status: "success",
        provider_code: "graph-ok",
      },
      resources: [
        {
          outcome: { status: "failure", provider_code: "partial-failure" },
          sensitivity: { label_id: "secret", sensitivity_extra: "kept" },
          policy: { decision: "allow" },
          security: { xpia_detected: true },
          resource_extra: "kept",
        },
      ],
      pagination: { has_more: true, next_cursor: "cursor-2", total_count: 10 },
      result_extra: "kept",
    });

    const explicitResult = new a365.ExecuteToolCallResult({ schema_version: "2.1" });
    expect(explicitResult.schema_version).toBe("2.1");
  });
});
