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
  ExecuteToolCallArguments,
  ExecuteToolCallResult,
  ExecuteToolScope,
  InferenceOperationType,
  InferenceScope,
  InvokeAgentScope,
  ToolCallAction,
  ToolCallOutcomeStatus,
  ToolPolicyDecision,
} from "@microsoft/opentelemetry";

const invokeScope = InvokeAgentScope.start(
  { conversationId: "conv-123", sessionId: "session-456" },
  {
    requestParameters: {
      model: "gpt-4o",
      outputType: "json",
      systemInstructions: [{ type: "text", content: "You are a helpful assistant." }],
    },
  },
  { agentId: "agent-1", tenantId: "tenant-1", providerName: "openai" },
);

invokeScope.run(async () => {
  const toolArguments = new ExecuteToolCallArguments({
    action: ToolCallAction.READ,
    resources: [
      {
        id: "drive-item-1",
        uri: "https://contoso.example/items/1",
        name: "Quarterly plan",
        type: "document",
        provider: "sharepoint",
        identifiers: [{ type: "driveItem", value: "1" }],
        container: {
          id: "folder-1",
          uri: "https://contoso.example/folders/1",
          type: "folder",
        },
        extension_data: { custom_resource_field: "kept" },
      },
    ],
    parameters: { query: "hello", includeArchived: false },
    extension_data: { custom_argument_field: "kept" },
  });

  const toolScope = ExecuteToolScope.start(
    { conversationId: "conv-123", sessionId: "session-456" },
    {
      toolName: "Search",
      arguments: toolArguments,
      toolCallId: "tool-call-123",
      toolType: "function",
    },
    { agentId: "agent-1", tenantId: "tenant-1" },
  );

  const inferenceScope = InferenceScope.start(
    { conversationId: "conv-123", sessionId: "session-456" },
    { operationName: InferenceOperationType.ChatCompletion },
    { agentId: "agent-1", tenantId: "tenant-1" },
  );

  toolScope.recordResponse(
    new ExecuteToolCallResult({
      outcome: {
        status: ToolCallOutcomeStatus.SUCCESS,
        code: "200",
        message: "Completed",
      },
      resources: [
        {
          id: "drive-item-1",
          name: "Quarterly plan",
          type: "document",
          outcome: {
            status: ToolCallOutcomeStatus.SUCCESS,
            code: "200",
          },
          policy: {
            decision: ToolPolicyDecision.ALLOW,
            id: "policy-1",
            name: "AllowDocumentRead",
          },
          data: { snippetCount: 3 },
          extension_data: { custom_result_field: "kept" },
        },
      ],
      pagination: { has_more: false, total_count: 1 },
      extension_data: { custom_result_field: "kept" },
    }),
  );

  toolScope.dispose();
  inferenceScope.dispose();
});

invokeScope.recordResponseParameters({
  finishReasons: ["stop"],
  inputTokens: 120,
  outputTokens: 42,
  cacheWriteInputTokens: 10,
  cacheReadInputTokens: 8,
});
invokeScope.dispose();
```

`ExecuteToolScope` serializes arguments to `gen_ai.tool.call.arguments` and results to
`gen_ai.tool.call.result` as JSON span attributes, so they may contain sensitive data.
Use `extension_data` for provider-specific fields on any typed ExecuteTool model. Explicitly
provided extension data, including `{}`, is emitted under the model's `metadata` JSON property;
absent or null extension data is omitted. Metadata keys remain
isolated from declared schema fields, so an `extension_data.action` or
`extension_data.schema_version` value cannot replace the typed `action` or `schema_version`.
Typed payloads that contain invalid enum tokens, non-finite numbers, unsupported values, or
reference cycles are replaced with
`{"serialization_error":"Failed to serialize execute tool payload."}`.

### Tool endpoints and transfers

Supply `endpoint.url` on `ToolCallDetails` to record the complete URL as `url.full`,
including its path, query, and fragment. Existing `endpoint.host` and non-default
`endpoint.port` still populate `server.address` and `server.port`. Host-only endpoints
do not synthesize `url.full`. URLs may contain sensitive data; sanitize them before recording.

Use explicit `transferDetails` for handoffs; ordinary tool calls emit no transfer attributes.

```typescript
import { ExecuteToolScope, TransferMode, TransferTargetType } from "@microsoft/opentelemetry";
import type { ToolCallDetails } from "@microsoft/opentelemetry";

const details: ToolCallDetails = {
  toolName: "handoff",
  endpoint: {
    host: "agents.example.com",
    url: "https://agents.example.com/support",
  },
  transferDetails: {
    mode: TransferMode.PASS_CONTROL,
    targetType: TransferTargetType.AGENT,
    targetAgentDetails: { agentId: "support-agent", agentName: "Support" },
  },
};
const scope = ExecuteToolScope.start(
  { conversationId: "conv-123" },
  details,
  { agentId: "source-agent", tenantId: "tenant-1" },
);
scope.dispose();
```

`TransferMode` supports `RETURN_TO_CALLER` (`return_to_caller`) and `PASS_CONTROL`
(`pass_control`). `TransferTargetType` supports `AGENT`, `HUMAN`, and `WORKFLOW`;
omitting `targetType` defaults to `agent`. Target identity is optional for agent transfers
and forbidden for human/workflow transfers. Invalid enum values or incompatible target
details throw before a span is created.

Transfers emit `microsoft.a365.transfer.mode` and `microsoft.a365.transfer.target.type`.
Provided agent ID, name, blueprint ID, platform ID, and version are recorded under
`microsoft.a365.transfer.target.agent.*` (`id`, `name`, `blueprint.id`, `platform.id`,
`version`). Other target identity fields are not emitted, and the source agent and tenant
attributes remain unchanged.

### Request and response attributes

`InvokeAgentScope`, `InferenceScope`, and `ExecuteToolScope` accept `request.sessionId`.
When you provide it, those scopes write `microsoft.session.id` directly on the created
span instead of relying on later baggage enrichment. `OutputScope` does not currently
propagate `request.sessionId` directly.

`InferenceScope` accepts `InferenceOperationType` enum values or the canonical strings
`chat`, `text_completion`, and `generate_content` in `details.operationName`. Both
`gen_ai.operation.name` and the span name use the canonical operation; for example,
`InferenceOperationType.TEXT_COMPLETION` with model `gpt-4` produces `text_completion gpt-4`.

`InvokeAgentScope.start()` captures request parameters immediately, while `recordResponseParameters()`
captures response and usage values after the agent completes.

| Input field                                | Emitted attribute key                                      |
| ------------------------------------------ | ---------------------------------------------------------- |
| `requestParameters.model`                  | `gen_ai.request.model`                                     |
| `requestParameters.seed`                   | `gen_ai.request.seed`                                      |
| `requestParameters.choiceCount`            | `gen_ai.request.choice.count`                              |
| `requestParameters.frequencyPenalty`       | `gen_ai.request.frequency_penalty`                         |
| `requestParameters.maxTokens`              | `gen_ai.request.max_tokens`                                |
| `requestParameters.presencePenalty`        | `gen_ai.request.presence_penalty`                          |
| `requestParameters.stopSequences`          | `gen_ai.request.stop_sequences`                            |
| `requestParameters.temperature`            | `gen_ai.request.temperature`                               |
| `requestParameters.topP`                   | `gen_ai.request.top_p`                                     |
| `requestParameters.dataSourceId`           | `gen_ai.data_source.id`                                    |
| `requestParameters.outputType`             | `gen_ai.output.type`                                       |
| `requestParameters.systemInstructions`     | `gen_ai.system_instructions` (JSON-serialized parts array) |
| `responseParameters.finishReasons`         | `gen_ai.response.finish_reasons`                           |
| `responseParameters.inputTokens`           | `gen_ai.usage.input_tokens`                                |
| `responseParameters.outputTokens`          | `gen_ai.usage.output_tokens`                               |
| `responseParameters.cacheWriteInputTokens` | `gen_ai.usage.cache_write.input_tokens`                    |
| `responseParameters.cacheReadInputTokens`  | `gen_ai.usage.cache_read.input_tokens`                     |
| `agentDetails.providerName`                | `gen_ai.provider.name`                                     |
System instructions may contain sensitive content. Only capture them when you
intend to store prompt text and have reviewed downstream access controls.
intend to store prompt text and have reviewed downstream access controls.

## Baggage And Context

Use `BaggageBuilder` when you want tenant, agent, user, conversation, or session data to flow with the active context.

```typescript
import { BaggageBuilder, injectContextToHeaders } from "@microsoft/opentelemetry";

const baggageScope = new BaggageBuilder()
  .tenantId("tenant-1")
  .agentId("agent-1")
  .conversationId("conv-123")
  .sessionId("session-456")
  .customAttribute("deployment.ring", "firstrelease")
  .customAttributes({
    "feature.name": "grounded-chat",
    "customer.segment": "internal",
  })
  .build();

baggageScope.run(() => {
  const headers: Record<string, string> = {};
  injectContextToHeaders(headers);
});
```

- Baggage may cross process and service boundaries when you inject/extract context. Treat it like
  inbound and outbound metadata: `_internal.custom_keys` registration metadata can arrive through
  inbound baggage headers, applications must reject or sanitize untrusted baggage headers at the
  edge, and you must never put secrets, access tokens, or PII in baggage keys or values.
- `customAttribute()` and `customAttributes()` trim keys and values before storing them. Blank
  keys/values are dropped, keys containing commas are rejected, and the reserved
  `_internal.custom_keys` metadata key cannot be set directly.
- Custom baggage enrichment is opt-in. Only keys registered through `customAttribute()` or
  `customAttributes()` are copied from baggage onto spans; plain `setPairs()` entries stay in
  baggage only.
- Automatic baggage-to-span enrichment only runs for recognized GenAI spans whose
  `gen_ai.operation.name` is `invoke_agent`, `execute_tool`, `output_messages`,
  `apply_guardrail`, `chat`, `text_completion`, `generate_content`, `Chat`, `TextCompletion`, or
  `GenerateContent`.
- For the built-in LangChain and OpenAI Agents instrumentations, enrichment also recognizes
  their exact instrumentation scope names when the final GenAI operation is not available at
  span start. Configured custom tracer names, scope prefixes, and unrelated child scopes are not
  matched.
- Invoke-agent-only baggage keys stay invoke-agent-only even when registered through
  `_internal.custom_keys`; unknown or non-`invoke_agent` GenAI spans never receive those caller
  agent attributes.
- Explicit span attributes win over baggage. If a span already has a value for a registered custom
  key, the span value is preserved.

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

Durable delivery is requested by default for the A365 HTTP exporter. **On Unix, including Linux
and macOS, it requires an explicitly configured, existing, absolute storage root.** Missing or
invalid configuration logs an error and disables only offline buffering/replay; online export continues.

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

Durable delivery is requested by default. Set `durableDelivery.enabled: false` to force legacy
network-only delivery. It applies only to the A365 HTTP exporter, so set
`enableObservabilityExporter: true` alongside `a365.enabled: true`.

### Durable Delivery Defaults

| Option                               | Default                   | Notes                                                                                                                                  |
| ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                            | `true`                    | Requests offline buffering/replay; `false` bypasses storage initialization entirely |
| `storageDirectory`                   | unset                     | Unix: required existing absolute customer-provisioned root. Windows: existing platform defaults. Stable `app-<hash>` cache partition |
| `maxStorageBytes`                    | `50 * 1024 * 1024`        | Bounds pending, quarantined, active leased, and non-stale temporary records within the current `app-<hash>` partition only             |
| `maxRecordAgeMilliseconds`           | `2 * 24 * 60 * 60 * 1000` | Expired records are pruned before capacity eviction, within the current `app-<hash>` partition only                                    |
| `replayIntervalMilliseconds`         | `2 * 60 * 1000`           | Scheduled replay cadence                                                                                                               |
| `maxReplayBatchSize`                 | `10`                      | Maximum attempted records per replay pass; backed-off records do not consume this limit. At most 10 times this many records are claimed   |
| `leaseDurationMilliseconds`          | `2 * 60 * 1000`           | Reclaims stale replay leases                                                                                                           |
| `shutdownTimeoutMilliseconds`        | `10_000`                  | Shared shutdown budget for accepted live exports and admitted durable handoff completion                                               |
| `tokenResolutionTimeoutMilliseconds` | `30_000`                  | Timeout per replay token-resolution attempt                                                                                            |

### Operational Notes

- Durable records are plaintext JSON. On Unix the configured root is a customer-trusted security
  boundary. The SDK checks configuration and directory existence, not confidentiality: it does not
  inspect or rewrite ownership, permissions, ACLs, symlinks, or ancestors. Customers protect these
  paths throughout the application's lifetime. Configuring `/tmp` explicitly is still unsafe.
- Unix never selects `TMPDIR`, `/var/tmp`, `/tmp`, or the current directory implicitly and never
  creates the configured root. It creates only the normal `app-<hash>` cache beneath a valid root.
  Existing file/directory creation modes (`0600`/`0700`, filtered by umask) are retained without
  chmod/chown or permission repair. Customers must use a compatible service umask; the SDK does not
  override it. Existing customer root/cache permissions are unchanged.
- Windows retains its existing `LOCALAPPDATA`, `TEMP`, and `os.tmpdir()` candidate behavior,
  `Microsoft/A365/otel-durable` layout, final-root symlink rejection, and ACL helper. Inherited ACLs
  are removed and full control granted to the current identity and Administrators as before this
  issue. ACL initialization failures are logged and disable only offline buffering/replay.
- Every explicit or default durable root is partitioned again under a stable `app-<hash>` child
  derived from the process identity, so applications that share a base directory do not replay one
  another's telemetry. All retention, capacity, and pruning behavior described below operates only
  within the current process's own `app-<hash>` partition; the store never enumerates or reads
  sibling partitions. If the process identity changes (for example, after a binary path or
  executable upgrade), the previous partition becomes orphaned and is not age-pruned, capacity-
  pruned, or otherwise cleaned up automatically. Operators who need to reclaim that space should
  remove stale `app-<hash>` directories under the durable root out-of-band.
- Durable delivery is requested by default when the A365 HTTP exporter is active. Set
  `durableDelivery.enabled: false` to force legacy network-only delivery.
- If durable storage initialization fails, the exporter logs the error and continues in network-only
  mode. Successful online sends still succeed; failed network sends that cannot be persisted are
  reported as failures. Initialization is shared by startup, export, flush, and shutdown paths;
  missing/invalid configuration does not start replay or trigger a hidden storage fallback.
- Delivery is at-least-once. A retryable request can be replayed after a crash, timeout, or
  shutdown race, so downstream consumers must tolerate duplicates.
- HTTP 401, 408, 429, and 5xx responses plus transport failures are retryable. Live delivery
  persists them, and replay releases the claim while honoring that tenant's transmission gate.
- Replay and `forceFlush()` resolve a fresh token for each send attempt and use the exporter's
  current cluster/domain routing; durable files do not store bearer tokens or authoritative route
  metadata.
- If token resolution returns no token, throws, or times out, live delivery attempts to persist the
  record for replay and replay releases the claim without extending tenant transmission backoff.
- Storage is bounded by both age and capacity, scoped to the current process's own `app-<hash>`
  partition (see above). The SDK sweeps stale temporary files, prunes expired records, then evicts
  the oldest remaining pending or quarantined record until the new record fits within
  `maxStorageBytes`; active temporary and leased files count against that bound and are not
  evicted. `maxStorageBytes` is therefore a per-partition, not a global, limit.
- Live delivery and replay share a `Retry-After` / exponential-backoff transmission gate per
  tenant, across that tenant's agents. A retryable response pauses only that tenant's immediate
  sends and replay probes; other tenants continue. The effective delay is capped at one hour.
  Replay skips released records within the same pass and scans past backed-off tenants within
  the bounded claim budget (not a limit on directory listings or preflight reads). Excluded
  records are skipped before leasing; post-claim content is still validated. Malformed records,
  including blank tenant IDs, are quarantined. Invalid replay endpoints, unexpected send
  exceptions, or failed claim releases stop the pass.
- Tenant gates are retained in a registry with a soft capacity of 256 and a 15-minute idle
  timeout. Inactive gates are evicted first; active sends and unexpired backoff are never evicted,
  so the registry may temporarily exceed its capacity.
- If records must survive container restarts, rescheduling, or host restarts, point
  `storageDirectory` at a protected persistent volume. Ephemeral storage can be lost when a
  container is replaced and still counts against container ephemeral-storage limits.

### Storage provisioning and migration

**Unix breaking change:** applications that previously relied on implicit temporary storage must
provision and configure a root or set `durableDelivery.enabled: false`. During deployment, create a
dedicated private directory as the application's service account, normally mode `0700`, for example:

```sh
install -d -m 700 "$HOME/.local/state/my-agent/telemetry"
```

Review existing ownership, extended/inherited ACL grants, symlinks, and ancestor protection before
reuse. Do not chmod shared system directories. Configure the absolute path through
`a365.durableDelivery.storageDirectory` (or the exporter's `durableDelivery.storageDirectory`);
the example's `A365_DURABLE_STORAGE_DIRECTORY` is application-read configuration, not an automatic
SDK environment override. Root validation is not a security audit.

Reusing the same explicit root, service identity, executable path, and application entry point
preserves `app-<hash>` partition identity and existing record replay. Retention limits and the record
format are unchanged. No old temporary-directory backlog is discovered or migrated automatically.
For a controlled migration, stop all writers/replayers, review the old cache and provenance, secure
the destination root and ACLs, and move the existing application partition intact. If executable or
application identity changes, its partition hash also changes; review the intended destination
partition before transferring records. Resume one instance first and confirm replay, allowing for
at-least-once duplicates. Retain a protected backup until migration is verified.

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
