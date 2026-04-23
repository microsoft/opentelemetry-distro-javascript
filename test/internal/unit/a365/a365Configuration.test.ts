// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";
import {
  A365Configuration,
  A365_ENV_VARS,
} from "../../../../src/a365/configuration/A365Configuration.js";

describe("A365Configuration", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("defaults", () => {
    it("should have correct default values with no options", () => {
      const config = new A365Configuration();
      assert.strictEqual(config.enabled, false);
      assert.strictEqual(config.clusterCategory, "prod");
      assert.strictEqual(config.domainOverride, undefined);
      assert.deepStrictEqual(config.authScopes, ["https://api.powerplatform.com/.default"]);
      assert.strictEqual(config.tokenResolver, undefined);
    });

    it("should have correct default baggage options", () => {
      const config = new A365Configuration();
      assert.strictEqual(config.baggage.propagationEnabled, true);
      assert.strictEqual(config.baggage.enrichSpans, true);
    });

    it("should have correct default hosting options", () => {
      const config = new A365Configuration();
      assert.strictEqual(config.hosting.enabled, false);
    });
  });

  describe("programmatic options", () => {
    it("should apply enabled flag", () => {
      const config = new A365Configuration({ enabled: true });
      assert.strictEqual(config.enabled, true);
    });

    it("should apply cluster category", () => {
      const config = new A365Configuration({ clusterCategory: "gov" });
      assert.strictEqual(config.clusterCategory, "gov");
    });

    it("should apply domain override", () => {
      const config = new A365Configuration({ domainOverride: "custom.example.com" });
      assert.strictEqual(config.domainOverride, "custom.example.com");
    });

    it("should apply auth scopes", () => {
      const scopes = ["scope1", "scope2"];
      const config = new A365Configuration({ authScopes: scopes });
      assert.deepStrictEqual(config.authScopes, scopes);
    });

    it("should apply token resolver", () => {
      const resolver = (_agentId: string, _tenantId: string) => "token";
      const config = new A365Configuration({ tokenResolver: resolver });
      assert.strictEqual(config.tokenResolver, resolver);
    });

    it("should apply baggage options", () => {
      const config = new A365Configuration({
        baggage: { propagationEnabled: false, enrichSpans: false },
      });
      assert.strictEqual(config.baggage.propagationEnabled, false);
      assert.strictEqual(config.baggage.enrichSpans, false);
    });

    it("should apply hosting options", () => {
      const config = new A365Configuration({ hosting: { enabled: true } });
      assert.strictEqual(config.hosting.enabled, true);
    });
  });

  describe("environment variable overrides", () => {
    it("should override enabled from env", () => {
      process.env[A365_ENV_VARS.EXPORTER_ENABLED] = "true";
      const config = new A365Configuration({ enabled: false });
      assert.strictEqual(config.enabled, true);
    });

    it("should override enabled=false from env", () => {
      process.env[A365_ENV_VARS.EXPORTER_ENABLED] = "false";
      const config = new A365Configuration({ enabled: true });
      assert.strictEqual(config.enabled, false);
    });

    it("should override auth scopes from env (space-separated)", () => {
      process.env[A365_ENV_VARS.AUTH_SCOPES] = "scope1 scope2 scope3";
      const config = new A365Configuration();
      assert.deepStrictEqual(config.authScopes, ["scope1", "scope2", "scope3"]);
    });

    it("should override domain from env", () => {
      process.env[A365_ENV_VARS.DOMAIN] = "env.example.com";
      const config = new A365Configuration({ domainOverride: "programmatic.example.com" });
      assert.strictEqual(config.domainOverride, "env.example.com");
    });

    it("should override cluster category from env", () => {
      process.env[A365_ENV_VARS.CLUSTER_CATEGORY] = "preprod";
      const config = new A365Configuration({ clusterCategory: "prod" });
      assert.strictEqual(config.clusterCategory, "preprod");
    });

    it("should ignore empty env vars", () => {
      process.env[A365_ENV_VARS.DOMAIN] = "";
      const config = new A365Configuration({ domainOverride: "keep.this.com" });
      assert.strictEqual(config.domainOverride, "keep.this.com");
    });

    it("should warn on invalid cluster category and keep default", () => {
      process.env[A365_ENV_VARS.CLUSTER_CATEGORY] = "staging";
      const config = new A365Configuration();
      assert.strictEqual(config.clusterCategory, "prod");
    });

    it("should ignore unrecognized boolean env var values", () => {
      process.env[A365_ENV_VARS.EXPORTER_ENABLED] = "maybe";
      const config = new A365Configuration();
      // Unrecognized value is ignored, default stands
      assert.strictEqual(config.enabled, false);
    });
  });

  describe("precedence", () => {
    it("env vars take precedence over programmatic options", () => {
      process.env[A365_ENV_VARS.CLUSTER_CATEGORY] = "preprod";

      const config = new A365Configuration({
        clusterCategory: "prod",
      });

      assert.strictEqual(config.clusterCategory, "preprod");
    });

    it("programmatic options take precedence over defaults", () => {
      const config = new A365Configuration({
        enabled: true,
      });

      assert.strictEqual(config.enabled, true);
    });
  });

  describe("validation warnings", () => {
    it("should warn when options are set but A365 is disabled", () => {
      // This shouldn't throw, just warn
      const config = new A365Configuration({
        enabled: false,
        tokenResolver: () => "token",
        domainOverride: "example.com",
      });
      assert.strictEqual(config.enabled, false);
    });

    it("should not warn when A365 is enabled with options", () => {
      // Should not throw or warn
      const config = new A365Configuration({
        enabled: true,
        tokenResolver: () => "token",
      });
      assert.strictEqual(config.enabled, true);
    });

    it("should not warn when no options are set and A365 is disabled", () => {
      const config = new A365Configuration();
      assert.strictEqual(config.enabled, false);
    });
  });

  describe("env var constants", () => {
    it("should have correct env var names", () => {
      assert.strictEqual(A365_ENV_VARS.EXPORTER_ENABLED, "ENABLE_A365_OBSERVABILITY_EXPORTER");
      assert.strictEqual(A365_ENV_VARS.AUTH_SCOPES, "A365_OBSERVABILITY_SCOPES_OVERRIDE");
      assert.strictEqual(A365_ENV_VARS.DOMAIN, "A365_OBSERVABILITY_DOMAIN_OVERRIDE");
      assert.strictEqual(A365_ENV_VARS.CLUSTER_CATEGORY, "CLUSTER_CATEGORY");
    });
  });
});
