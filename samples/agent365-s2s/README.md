# Agent365 service-to-service observability sample

This standalone Node.js 22 sample publishes a deterministic agent trace to the
Agent365 service-to-service observability endpoint. It uses app-only
authentication; no interactive user sign-in or pre-generated bearer token is
required.

## Prerequisites

- Node.js 22 or later.
- An Agent365 blueprint application with a client secret.
- An Agent365 agent application in the same Microsoft Entra tenant.
- The Agent365 agent application must have the
  `Agent365.Observability.OtelWrite` application permission with tenant admin
  consent.
- The blueprint and agent application must be configured for the Agent365
  federated managed identity (FMI) token-exchange flow.

Never commit `.env`. The included `.gitignore` excludes it.

## Configure and run

Build the root distro first so the sample's local `file:../..` dependency can
resolve its generated package exports:

```powershell
Set-Location ..\..
npm ci
npm run build
Set-Location samples\agent365-s2s
```

Then configure and run the sample:

```powershell
Copy-Item sample.env .env
npm ci
npm run build
npm start
```

Set every required value in `.env`:

| Variable                       | Description                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `A365_AUTHORITY`               | HTTPS Microsoft Entra authority root, for example `https://login.microsoftonline.com` |
| `A365_BLUEPRINT_CLIENT_ID`     | Blueprint application client ID                                                       |
| `A365_BLUEPRINT_CLIENT_SECRET` | Blueprint application client secret                                                   |
| `A365_TENANT_ID`               | Microsoft Entra tenant ID                                                             |
| `A365_AGENT_ID`                | Agent365 agent application client ID and FMI path                                     |
| `A365_CLUSTER_CATEGORY`        | Must be `prod`                                                                        |

The sample rejects missing values, malformed GUIDs, non-HTTPS
authorities, and authorities containing tenant paths, queries, or fragments.
Configuration errors name only the invalid setting and never echo its value.

## Authentication flow

The sample performs exactly two confidential-client requests:

1. The blueprint application requests
   `api://AzureADTokenExchange/.default`, using the configured `agentId` as
   `fmiPath`.
2. The returned blueprint token becomes the `clientAssertion` for the agent
   application, which requests
   `api://9b975845-388f-4429-889e-eab1ef63949c/.default`.

The final observability token is cached per normalized tenant/agent identity
and reused only while it expires more than 60 seconds in the future.
Concurrent refreshes share one request, and failed refreshes can be retried.

## Expected telemetry

Each run creates exactly six spans in one trace and demonstrates all five
concrete manual scope types:

1. `invoke_agent` for the complete synthetic request.
2. `apply_guardrail` allowing the synthetic input.
3. `Chat` inference selecting `lookup_weather`.
4. `execute_tool` with deterministic synthetic arguments and result.
5. `Chat` inference producing the final answer.
6. `output_messages` recording the response sent to the caller.

All five child spans are direct children of `invoke_agent`. The run starts at
the current time and uses fixed relative offsets and durations. Published
agent, caller, user, conversation, message, guardrail, and tool values are
explicitly synthetic; only the configured tenant and agent IDs identify the
destination.

The distro is configured with `enableObservabilityExporter: true`,
`useS2SEndpoint: true`, the exact observability scope, and `prod` routing. The
sample shuts down the SDK after the scenario so queued telemetry is flushed
without a fixed sleep.

## Safe diagnostics

The logger prints only preformatted messages and discards additional error
arguments. Tokens, client secrets, raw MSAL responses, exception messages,
nested errors, and stacks are never rendered. Authentication failures contain
only the failed stage and a sanitized MSAL error code.

The sample also reuses the repository's root Prettier and ESLint configuration:

```powershell
npm run format
npm run lint
```
