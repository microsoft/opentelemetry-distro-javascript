import { diag } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// TokenResolver type
// ---------------------------------------------------------------------------

/**
 * Async function that returns a Bearer token string for a given agent and
 * tenant, or null to skip exporting spans for that combination.
 */
export type TokenResolver = (
  agentId: string,
  tenantId: string,
) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Default scope
// ---------------------------------------------------------------------------

/**
 * Default OAuth2 scope for the A365 Observability Service (production app ID).
 */
const A365_DEFAULT_SCOPE = '9b975845-388f-4429-889e-eab1ef63949c/.default';

// ---------------------------------------------------------------------------
// Azure Identity resolver
// ---------------------------------------------------------------------------

/**
 * Create a TokenResolver backed by `@azure/identity` DefaultAzureCredential.
 *
 * Requires `@azure/identity` to be installed as a dependency of your
 * application. The package is loaded dynamically at call time.
 *
 * @param credential - Optional pre-built credential instance. If omitted,
 *   a new DefaultAzureCredential is created on first use.
 * @param scope - OAuth2 scope string. Defaults to the A365 production app.
 * @returns A TokenResolver function.
 *
 * Example:
 * ```typescript
 * import { createAzureIdentityResolver } from '@a365/otel-exporter';
 *
 * const resolver = createAzureIdentityResolver();
 * const exporter = new A365SpanExporter({ tokenResolver: resolver });
 * ```
 */
export function createAzureIdentityResolver(
  credential?: unknown,
  scope?: string,
): TokenResolver {
  const targetScope = scope ?? A365_DEFAULT_SCOPE;
  let resolvedCredential: AzureCredentialLike | null =
    credential as AzureCredentialLike | null;

  return async (_agentId: string, _tenantId: string): Promise<string | null> => {
    try {
      if (!resolvedCredential) {
        resolvedCredential = await loadDefaultAzureCredential();
      }

      const tokenResponse = await resolvedCredential.getToken(targetScope);
      if (!tokenResponse || !tokenResponse.token) {
        diag.warn(
          'A365 AzureIdentityResolver: getToken returned null/empty token',
        );
        return null;
      }
      return tokenResponse.token;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      diag.error(`A365 AzureIdentityResolver: failed to acquire token: ${message}`);
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// MSAL Confidential Client resolver
// ---------------------------------------------------------------------------

/**
 * Configuration for the MSAL confidential client token resolver.
 */
export interface MsalResolverConfig {
  /** Application (client) ID of the calling service. */
  clientId: string;

  /** Client secret for the application. */
  clientSecret: string;

  /**
   * Azure AD tenant ID to authenticate against.
   * This is the tenant of the *calling service*, not the customer tenant.
   */
  tenantId: string;

  /**
   * Authority URL. Defaults to "https://login.microsoftonline.com/{tenantId}".
   */
  authority?: string;

  /**
   * OAuth2 scope string. Defaults to the A365 production app scope.
   */
  scope?: string;
}

/**
 * Create a TokenResolver backed by `@azure/msal-node` ConfidentialClientApplication.
 *
 * Requires `@azure/msal-node` to be installed as a dependency of your
 * application. The package is loaded dynamically at call time.
 *
 * @param config - MSAL confidential client configuration.
 * @returns A TokenResolver function.
 *
 * Example:
 * ```typescript
 * import { createMsalResolver } from '@a365/otel-exporter';
 *
 * const resolver = createMsalResolver({
 *   clientId: '<your-app-id>',
 *   clientSecret: '<your-secret>',
 *   tenantId: '<your-tenant-id>',
 * });
 * const exporter = new A365SpanExporter({ tokenResolver: resolver });
 * ```
 */
export function createMsalResolver(config: MsalResolverConfig): TokenResolver {
  const targetScope = config.scope ?? A365_DEFAULT_SCOPE;
  const authority =
    config.authority ??
    `https://login.microsoftonline.com/${config.tenantId}`;

  let msalClient: MsalClientLike | null = null;

  return async (_agentId: string, _tenantId: string): Promise<string | null> => {
    try {
      if (!msalClient) {
        msalClient = await loadMsalClient(config.clientId, config.clientSecret, authority);
      }

      const result = await msalClient.acquireTokenByClientCredential({
        scopes: [targetScope],
      });

      if (!result || !result.accessToken) {
        diag.warn('A365 MsalResolver: acquireTokenByClientCredential returned null/empty token');
        return null;
      }

      return result.accessToken;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      diag.error(`A365 MsalResolver: failed to acquire token: ${message}`);
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Internal: dynamic module loading helpers
// ---------------------------------------------------------------------------

/**
 * Minimal shape of an Azure credential that has a getToken method.
 * We avoid a hard dependency on @azure/identity.
 */
interface AzureCredentialLike {
  getToken(
    scope: string,
  ): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

/**
 * Minimal shape of an MSAL ConfidentialClientApplication.
 * We avoid a hard dependency on @azure/msal-node.
 */
interface MsalClientLike {
  acquireTokenByClientCredential(request: {
    scopes: string[];
  }): Promise<{ accessToken: string } | null>;
}

async function loadDefaultAzureCredential(): Promise<AzureCredentialLike> {
  try {
    // Dynamic import so @azure/identity is not a hard dependency
    const identityModule = await import('@azure/identity');
    return new identityModule.DefaultAzureCredential();
  } catch {
    throw new Error(
      'Failed to load @azure/identity. Install it as a dependency: npm install @azure/identity',
    );
  }
}

async function loadMsalClient(
  clientId: string,
  clientSecret: string,
  authority: string,
): Promise<MsalClientLike> {
  try {
    // Dynamic import so @azure/msal-node is not a hard dependency
    const msalModule = await import('@azure/msal-node');
    const app = new msalModule.ConfidentialClientApplication({
      auth: {
        clientId,
        clientSecret,
        authority,
      },
    });
    return app;
  } catch {
    throw new Error(
      'Failed to load @azure/msal-node. Install it as a dependency: npm install @azure/msal-node',
    );
  }
}
