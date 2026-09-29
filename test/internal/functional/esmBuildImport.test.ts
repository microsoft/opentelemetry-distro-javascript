// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("ESM build import regression", () => {
  it("imports dist/esm/distro/instrumentations.js", async () => {
    const modulePath = resolve(process.cwd(), "dist/esm/distro/instrumentations.js");

    // This test targets built output; skip locally if build artifacts are absent.
    if (!existsSync(modulePath)) {
      return;
    }

    await expect(import(modulePath)).resolves.toBeDefined();
  });

  it("recognizes typed execute tool models across ESM and CommonJS builds", async () => {
    const esmModelsPath = resolve(process.cwd(), "dist/esm/a365/tool-call-models.js");
    const esmMessageUtilsPath = resolve(process.cwd(), "dist/esm/a365/message-utils.js");
    const cjsModelsPath = resolve(process.cwd(), "dist/commonjs/a365/tool-call-models.js");
    const cjsMessageUtilsPath = resolve(process.cwd(), "dist/commonjs/a365/message-utils.js");

    if (
      !existsSync(esmModelsPath) ||
      !existsSync(esmMessageUtilsPath) ||
      !existsSync(cjsModelsPath) ||
      !existsSync(cjsMessageUtilsPath)
    ) {
      return;
    }

    const require = createRequire(import.meta.url);
    const esmModels = await import(pathToFileURL(esmModelsPath).href);
    const esmMessageUtils = await import(pathToFileURL(esmMessageUtilsPath).href);
    const cjsModels = require(cjsModelsPath);
    const cjsMessageUtils = require(cjsMessageUtilsPath);
    const expected = {
      schema_version: "1.0",
      action: "read",
      metadata: { action: "write" },
    };

    expect(
      JSON.parse(
        esmMessageUtils.serializeToolPayload(
          new cjsModels.ExecuteToolCallArguments({
            action: cjsModels.ToolCallAction.READ,
            extension_data: { action: "write" },
          }),
        ),
      ),
    ).toEqual(expected);
    expect(
      JSON.parse(
        cjsMessageUtils.serializeToolPayload(
          new esmModels.ExecuteToolCallArguments({
            action: esmModels.ToolCallAction.READ,
            extension_data: { action: "write" },
          }),
        ),
      ),
    ).toEqual(expected);
  });
});
