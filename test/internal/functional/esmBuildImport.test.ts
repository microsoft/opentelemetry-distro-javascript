// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
});
