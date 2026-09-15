// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ConfidentialClientApplication,
  type AuthenticationResult,
  type ClientCredentialRequest,
  type Configuration,
} from "@azure/msal-node";

import type { SampleConfig } from "./config.js";

export const TOKEN_EXCHANGE_SCOPE = "api://AzureADTokenExchange/.default";
export const OBSERVABILITY_SCOPES = [
  "api://9b975845-388f-4429-889e-eab1ef63949c/.default",
] as const;

export interface TokenExchangeResult {
  accessToken: string;
  expiresOn: Date;
}

export interface TokenExchangeClient {
  exchange(): Promise<TokenExchangeResult>;
}

type MsalCredentialResult = Pick<AuthenticationResult, "accessToken" | "expiresOn">;

export interface ConfidentialClientLike {
  acquireTokenByClientCredential(
    request: ClientCredentialRequest,
  ): Promise<MsalCredentialResult | null>;
}

export type ConfidentialClientFactory = (configuration: Configuration) => ConfidentialClientLike;

const defaultFactory: ConfidentialClientFactory = (configuration) =>
  new ConfidentialClientApplication(configuration);

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "errorCode" in error) {
    const errorCode = (error as { errorCode?: unknown }).errorCode;
    if (typeof errorCode === "string" && /^[a-z0-9_.-]{1,64}$/i.test(errorCode)) {
      return errorCode;
    }
  }
  return "unknown_error";
}

function stageError(stage: "Blueprint" | "Agent", errorCode: string): Error {
  return new Error(`${stage} token exchange failed (${errorCode}).`);
}

export class MsalTokenExchangeClient implements TokenExchangeClient {
  public constructor(
    private readonly config: SampleConfig,
    private readonly createClient: ConfidentialClientFactory = defaultFactory,
  ) {}

  public async exchange(): Promise<TokenExchangeResult> {
    const authority = `${this.config.authority.origin}/${this.config.tenantId}`;
    let blueprintResult: MsalCredentialResult | null;
    try {
      const blueprintClient = this.createClient({
        auth: {
          authority,
          clientId: this.config.blueprintClientId,
          clientSecret: this.config.blueprintClientSecret,
        },
      });
      blueprintResult = await blueprintClient.acquireTokenByClientCredential({
        scopes: [TOKEN_EXCHANGE_SCOPE],
        fmiPath: this.config.agentId,
      });
    } catch (error) {
      throw stageError("Blueprint", safeErrorCode(error));
    }
    if (!blueprintResult?.accessToken) {
      throw stageError("Blueprint", "empty_result");
    }

    let agentResult: MsalCredentialResult | null;
    try {
      const agentClient = this.createClient({
        auth: {
          authority,
          clientId: this.config.agentId,
          clientAssertion: blueprintResult.accessToken,
        },
      });
      agentResult = await agentClient.acquireTokenByClientCredential({
        scopes: [...OBSERVABILITY_SCOPES],
      });
    } catch (error) {
      throw stageError("Agent", safeErrorCode(error));
    }
    if (
      !agentResult?.accessToken ||
      !(agentResult.expiresOn instanceof Date) ||
      !Number.isFinite(agentResult.expiresOn.getTime())
    ) {
      throw stageError("Agent", "empty_result");
    }

    return {
      accessToken: agentResult.accessToken,
      expiresOn: agentResult.expiresOn,
    };
  }
}
