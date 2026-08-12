# A365 Durable Delivery Design

## Decision

Add opt-in, disk-backed store-and-forward delivery to the JavaScript A365 exporter. Keep the
standard OpenTelemetry `BatchSpanProcessor`; implement durability inside `Agent365Exporter`
using Node.js built-ins.

The feature is required for applications that must retain A365 telemetry across extended
network outages, throttling, and process restarts. The current exporter retries transient
failures four times in memory, then reports failure. `BatchSpanProcessor` does not requeue the
failed batch, so those spans are lost. Short retries remain useful without durability, but they
do not provide the delivery guarantee introduced by
`microsoft/opentelemetry-distro-dotnet#137`.

Durability remains disabled by default because it writes potentially sensitive telemetry to
disk and requires a writable, persistent filesystem. This is especially important for
containers, where the default local filesystem may be ephemeral.

## Alternatives

### 1. Exporter-integrated durable delivery (selected)

The exporter attempts delivery and persists retryable failures before completing the export.
A background coordinator replays stored records.

Advantages:

- Retains the standard OpenTelemetry processor and shutdown integration.
- Keeps serialization, identity partitioning, token resolution, transport, and replay in one
  bounded subsystem.
- Can report success only after network delivery or a successful durable handoff.

Trade-off: the exporter becomes stateful and owns filesystem lifecycle.

### 2. Custom durable span processor

Replace `BatchSpanProcessor` with an A365-specific processor that owns memory batching, disk
storage, replay, and shutdown.

This gives maximum lifecycle control, but duplicates OpenTelemetry batching logic and creates a
larger compatibility and maintenance surface. The .NET PR needed this partly because it supports
separate synchronous and asynchronous processor models; JavaScript does not.

### 3. Require an external OpenTelemetry Collector

Delegate persistence and retry to a sidecar or host collector.

This is operationally strong when a collector is already mandatory, but it does not protect the
current direct A365 HTTP path and cannot preserve data when the application cannot reach the
collector. It also changes deployment requirements rather than providing SDK parity.

## Public API

Add an optional nested setting to both `A365Options` and `Agent365ExporterOptions`:

```ts
interface Agent365DurableDeliveryOptions {
  enabled?: boolean; // default false
  storageDirectory?: string;
  maxStorageBytes?: number; // default 50 MiB
  maxRecordAgeMilliseconds?: number; // default 2 days
  replayIntervalMilliseconds?: number; // default 2 minutes
  maxReplayBatchSize?: number; // default 10
  leaseDurationMilliseconds?: number; // default 2 minutes
  shutdownTimeoutMilliseconds?: number; // default 10 seconds
  tokenResolutionTimeoutMilliseconds?: number; // default 30 seconds
}
```

`durableDelivery.enabled` must be explicitly set to `true`. The remaining values use defaults
compatible with the .NET behavior where practical. The nested object is idiomatic JavaScript,
avoids a double-negative `disableOfflineStorage` option, and leaves room for future durable
delivery settings without expanding the top-level A365 option list.

No new runtime dependency is required. `package-lock.json` changes only if the implementation
later proves that a dependency is necessary.

## Components

### Durable record

A versioned JSON record contains:

- creation time and record identifier;
- tenant ID, agent ID, and optional agentic user ID;
- cluster category, domain override, and S2S endpoint mode;
- serialized OTLP request body.

Bearer tokens are never persisted. Replay resolves a fresh endpoint from the stored endpoint
settings and obtains a fresh token from the configured resolver.

### Persistent store

Use `node:fs/promises`, `node:path`, `node:os`, and `node:crypto`.

- Create directories with mode `0700` and files with mode `0600`.
- Reject symbolic-link storage roots and harden existing permissions.
- When no directory is configured, probe platform candidates in order and continue after
  inaccessible or read-only candidates instead of silently disabling durability.
- Write to a unique temporary file, sync it, close it, and atomically rename it to a pending
  record.
- Prune expired records first, then oldest records until the configured capacity can accept the
  new record. Log every eviction.
- Reject a single record larger than the storage capacity.
- Claim replay work with atomic rename from pending to a process-specific leased name. Recover
  leases older than `leaseDurationMilliseconds`. This provides multi-process exclusion without
  a third-party lock package.
- Delete delivered and confirmed-permanent records. Restore retryable, token-unavailable, and
  unknown-fault records to pending.
- Quarantine malformed or unsupported-version records so one poison file cannot block replay.

### Transmission gate

One gate is shared by live delivery and replay within an exporter instance.

- Respect `Retry-After` delay-seconds and HTTP-date values.
- Otherwise use jittered exponential backoff, bounded from 10 seconds to one hour.
- Allow one half-open probe after the delay.
- Issue a generation-bearing permit for each send. A success may close the gate only when it
  belongs to the current generation, preventing an older successful request from erasing a newer
  server backoff.
- Timers are `unref()`'d so replay does not keep a Node.js process alive.

### Delivery manager

`Agent365Exporter` delegates each serialized chunk to a delivery manager:

1. If the gate defers live traffic, persist the chunk.
2. Otherwise perform one HTTP attempt.
3. Treat 2xx as delivered.
4. Persist transport errors, timeouts, token-resolver exceptions, 408, 429, and 5xx.
5. Treat missing tokens and other 4xx responses as permanent failures and do not persist them.
6. Continue processing other tenant/agent groups when one group fails.

An export succeeds only when every chunk was delivered or durably persisted. It fails when any
chunk was permanently rejected, could not be persisted, or was otherwise dropped. This avoids
the .NET PR bug where a storage failure in one identity group aborts unrelated groups.

Without durable delivery enabled, retain the current bounded in-memory retry behavior.

### Replay coordinator

The coordinator starts lazily after durable storage initializes successfully. Each pass claims
up to `maxReplayBatchSize` records and processes them independently. Replay is at-least-once and
non-FIFO; duplicates are possible if delivery succeeds but record deletion fails.

Replay uses the same gate and transport classification as live delivery. It resolves tokens with
`tokenResolutionTimeoutMilliseconds` so an unresponsive resolver cannot hang replay or shutdown.

## Shutdown

`shutdown()`:

1. stops new export admission;
2. clears the replay timer;
3. aborts replay HTTP I/O;
4. waits for accepted live exports and active replay work up to
   `shutdownTimeoutMilliseconds`;
5. rejects with a timeout error if work remains.

The implementation must never report successful shutdown and then block indefinitely during
disposal. `forceFlush()` waits for accepted live work and triggers one bounded replay pass, but it
does not wait for a future backoff window.

## Security and privacy

Durable records may contain prompts, responses, tool arguments, user identifiers, and other
sensitive telemetry. Documentation must state:

- durability is opt-in;
- records are plaintext but owner-readable only;
- callers should select a protected persistent volume when restart survival is required;
- storage capacity and retention limits bound exposure;
- credentials are never stored.

Filesystem errors are surfaced through exporter failure and diagnostic logging. Explicitly
enabled durability must not silently degrade to in-memory-only delivery.

## Tests

Use Vitest fake timers and temporary directories. At minimum cover:

- network, timeout, 408, 429, 5xx, and token-resolver exceptions persist;
- missing tokens and permanent 4xx do not persist;
- export succeeds after persistence and fails after persistence failure;
- one identity's persistence failure does not skip other identities;
- restart replay with a new exporter instance and fresh token;
- `Retry-After`, jitter bounds, one half-open probe, and stale-success generation handling;
- atomic writes, capacity eviction, retention, malformed-record quarantine, and record versioning;
- `0700` directory and `0600` file permissions on Unix;
- candidate-directory fallback and explicit-directory failure;
- concurrent replay claims and stale lease recovery;
- shutdown success, bounded timeout, aborted fetch, and hung token resolver;
- existing non-durable retry behavior remains unchanged;
- distro option wiring, public exports, documentation, build, lint, and package tests.

## .NET PR review constraints carried into this design

The JavaScript implementation must not reproduce the reviewed PR's high-confidence defects:

- storage failure must not abort unrelated identity groups;
- shutdown deadlines must be observable and must not be followed by an unbounded wait;
- Unix permissions must be explicitly owner-only;
- stale successes must not erase newer backoff;
- invalid default storage roots must fall through to later candidates;
- public options must actually wire durability for public exporter construction.
