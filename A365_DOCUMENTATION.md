# Agent 365 Observability — Microsoft OpenTelemetry for Node.js

Short guide for A365-specific APIs in this package.

Use the [main README](./README.md) for configuration and environment variables.
Use [Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/microsoft-opentelemetry?tabs=nodejs) for full product documentation.

## What Is Here

- Manual scopes: `InvokeAgentScope`, `ExecuteToolScope`, `InferenceScope`, `OutputScope`
- Baggage and trace-context helpers
- Hosting middleware helper: `configureA365Hosting`

## Manual Scopes

Use scopes when you want explicit spans for agent, tool, inference, or output work.

```typescript
import {
  ExecuteToolScope,
  InferenceOperationType,
  InferenceScope,
  InvokeAgentScope,
} from "@microsoft/opentelemetry";

const invokeScope = InvokeAgentScope.start(
  { conversationId: "conv-123", sessionId: "session-456" },
  {},
  { agentId: "agent-1", tenantId: "tenant-1" },
);

invokeScope.run(async () => {
  const toolScope = ExecuteToolScope.start(
    { conversationId: "conv-123" },
    { toolName: "Search", input: { query: "hello" } },
    { agentId: "agent-1", tenantId: "tenant-1" },
  );

  const inferenceScope = InferenceScope.start(
    { conversationId: "conv-123" },
    { operationName: InferenceOperationType.ChatCompletion },
    { agentId: "agent-1", tenantId: "tenant-1" },
  );

  toolScope.dispose();
  inferenceScope.dispose();
});

invokeScope.dispose();
```

## Baggage And Context

Use `BaggageBuilder` when you want tenant, agent, user, conversation, or session data to flow with the active context.

```typescript
import { BaggageBuilder, injectContextToHeaders } from "@microsoft/opentelemetry";

const baggageScope = new BaggageBuilder()
  .tenantId("tenant-1")
  .agentId("agent-1")
  .conversationId("conv-123")
  .sessionId("session-456")
  .build();

baggageScope.run(() => {
  const headers: Record<string, string> = {};
  injectContextToHeaders(headers);
});
```

## Hosting

Use `configureA365Hosting` to register the A365 middleware on an adapter.

```typescript
import { configureA365Hosting } from "@microsoft/opentelemetry";

configureA365Hosting(adapter, {
  enableBaggage: true,
  enableOutputLogging: false,
});
```

Set `enableOutputLogging: false` if response content should not be captured.

## Contextual Token Resolver

Use `contextualTokenResolver` instead of `tokenResolver` in agentic user scenarios where token generation depends on the specific user in the current interaction (per turn), not just the agent/app identity. Passing `agenticUserId` ensures the resolver can generate the correct token when user context matters. In S2S scenarios, `agenticUserId` will be `undefined`.

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";
import type { TokenResolverContext } from "@microsoft/opentelemetry";

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    enableObservabilityExporter: true,
    contextualTokenResolver: async (context: TokenResolverContext) => {
      const { agentId, agenticUserId } = context.identity;
      const { tenantId } = context;
      // Resolve a token using agent, tenant, and user identity.
      // Return null to skip the export for this agent/tenant group.
      return await getTokenForAgent(agentId, tenantId, agenticUserId);
    },
  },
});
```

When both `tokenResolver` and `contextualTokenResolver` are set, `contextualTokenResolver` takes precedence.

## Durable Delivery

Durable delivery is enabled by default for the A365 HTTP exporter when retryable A365 HTTP exports
must survive process restarts.

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    enableObservabilityExporter: true,
    tokenResolver: (agentId, tenantId, authScopes) => getToken(agentId, tenantId, authScopes),
    durableDelivery: {
      storageDirectory: process.env.A365_DURABLE_STORAGE_DIRECTORY,
      maxStorageBytes: 50 * 1024 * 1024,
      maxRecordAgeMilliseconds: 2 * 24 * 60 * 60 * 1000,
    },
  },
});
```

Durable delivery is enabled by default. Set `durableDelivery.enabled: false` to force legacy
network-only delivery. It applies only to the A365 HTTP exporter, so set
`enableObservabilityExporter: true` alongside `a365.enabled: true`.

### Durable Delivery Defaults

| Option                               | Default                   | Notes                                                                             |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------------------- |
| `enabled`                            | `true`                    | Durable delivery stays on unless you explicitly disable it                         |
| `storageDirectory`                   | auto                      | Uses the configured directory, or creates a secure platform-specific default root plus a stable per-application `app-<hash>` partition |
| `maxStorageBytes`                    | `50 * 1024 * 1024`        | Bounds pending, quarantined, active leased, and non-stale temporary records       |
| `maxRecordAgeMilliseconds`           | `2 * 24 * 60 * 60 * 1000` | Expired records are pruned before capacity eviction                               |
| `replayIntervalMilliseconds`         | `2 * 60 * 1000`           | Scheduled replay cadence                                                          |
| `maxReplayBatchSize`                 | `10`                      | Maximum records claimed per replay pass                                           |
| `leaseDurationMilliseconds`          | `2 * 60 * 1000`           | Reclaims stale replay leases                                                      |
| `shutdownTimeoutMilliseconds`        | `10_000`                  | Shared shutdown budget for accepted live exports and admitted durable handoff completion |
| `tokenResolutionTimeoutMilliseconds` | `30_000`                  | Timeout per replay token-resolution attempt                                       |

### Operational Notes

- Durable records are stored as plaintext JSON files. On POSIX, the SDK creates owner-only durable
  directories/files (`0700` / `0600`), rejects symlink roots, and requires the root to be owned by
  the current user. Default POSIX storage probes `TMPDIR`, `/var/tmp`, and `os.tmpdir()` and
  atomically creates one `a365-otel-durable-<uid>` leaf under each candidate; it does not create a
  multi-directory SDK-owned tree under a shared temp directory. Windows defaults use the per-user
  `Microsoft/A365/otel-durable` location under the selected candidate and also reject a symlinked
  final root. On Windows, use a protected storage directory or persistent volume with owner-only
  ACLs.
- Every explicit or default durable root is partitioned again under a stable `app-<hash>` child
  derived from the process identity, so applications that share a base directory do not replay one
  another's telemetry.
- Durable delivery is enabled by default when the A365 HTTP exporter is active. Set
  `durableDelivery.enabled: false` to force legacy network-only delivery.
- If durable storage initialization fails, the exporter logs the error and continues in network-only
  mode. Successful and non-retryable live sends still complete, but retryable responses that cannot
  be persisted are reported as failures.
- Delivery is at-least-once. A retryable request can be replayed after a crash, timeout, or
  shutdown race, so downstream consumers must tolerate duplicates.
- HTTP 401, 408, 429, and 5xx responses plus transport failures are retryable. Live delivery
  persists them, and replay releases the claim while honoring the shared transmission gate.
- Replay and `forceFlush()` resolve a fresh token for each send attempt and use the exporter's
  current cluster/domain routing; durable files do not store bearer tokens or authoritative route
  metadata.
- If token resolution returns no token, throws, or times out, live delivery attempts to persist the
  record for replay and replay releases the claim without extending the shared transmission backoff.
- Storage is bounded by both age and capacity. The SDK sweeps stale temporary files, prunes expired
  records, then evicts the oldest remaining pending or quarantined record until the new record fits
  within `maxStorageBytes`; active temporary and leased files count against that bound and are not
  evicted.
- Live delivery and replay share one `Retry-After` / exponential-backoff transmission gate. A
  retryable response pauses both immediate sends and replay probes until the gate reopens. The
  effective delay is capped at one hour.
- If records must survive container restarts, rescheduling, or host restarts, point
  `storageDirectory` at a protected persistent volume. Default temp directories and container
  filesystems are convenient for process restarts, but ephemeral storage can be lost when a
  container is replaced and still counts against container ephemeral-storage limits.

## Shutdown

Call `shutdownMicrosoftOpenTelemetry()` during graceful shutdown to flush pending telemetry and release resources:

```typescript
import { shutdownMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

process.on("SIGTERM", async () => {
  await shutdownMicrosoftOpenTelemetry();
  process.exit(0);
});
```

Exporter shutdown waits up to `durableDelivery.shutdownTimeoutMilliseconds` for already accepted
live exports to settle (10 seconds by default). With durable delivery enabled, shutdown also stops
replay scheduling immediately, aborts in-flight durable HTTP, and uses the same deadline for
already admitted durable handoff completion. Retryable aborted payloads stay on disk for replay on
the next process or startup pass; shutdown does not drain the existing spool. If you use
`Agent365Exporter` directly, you may call `forceFlush()` before shutdown for one bounded replay
pass. The distro shutdown path does not call `exporter.forceFlush()`. With
`durableDelivery.enabled: false`—or when durable storage never initialized and the exporter stayed
network-only—shutdown still drains accepted live exports within the same deadline but does not
replay or persist anything.
