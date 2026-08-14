# A365 Final Hardening Alignment Design

## Decision

Align the JavaScript durable-delivery implementation with the final merged behavior of
`microsoft/opentelemetry-distro-dotnet#137` while retaining the idiomatic nested
`durableDelivery` JavaScript API.

Durable delivery is enabled by default. Callers can explicitly disable it with
`durableDelivery.enabled: false`. If durable storage cannot initialize, the exporter logs the
failure and continues with network-only delivery rather than preventing otherwise successful
exports.

## Behavioral Changes

### Retry classification

- Treat HTTP 401 as retryable alongside 408, 429, and 5xx responses.
- Persist retryable live exports when storage is available.
- Preserve retryable status when persistence is disabled or fails; do not convert the transport
  outcome into a permanent rejection.
- Delete replay records only after successful delivery or a confirmed permanent response.

### Replay token isolation

- Token resolver exceptions, timeouts, and missing tokens produce a token-unavailable outcome,
  not a transport failure.
- Restore or retain the affected record for a later pass and continue processing other claimed
  records.
- Token-unavailable outcomes do not update the shared transmission gate.
- A record for one tenant or agent cannot starve unrelated records.

### Shutdown

- Track and await every accepted live export regardless of whether durable storage is enabled.
- Stop new admission before draining.
- In durable mode, abort outstanding transport when the configured shutdown deadline is reached
  so retryable payloads can be handed to storage.
- In network-only mode, use the same bounded shutdown deadline and report timeout explicitly.

### Storage roots

- Partition every configured or default storage root by a stable application identity hash so
  unrelated applications under one OS account cannot replay or evict each other's records.
- Derive the identity from stable process/application attributes and avoid credentials or
  telemetry content.
- Probe Unix temporary candidates in the explicit order `TMPDIR`, `/var/tmp`, `/tmp`, removing
  duplicates while preserving order.
- Continue to enforce owner-only permissions, atomic writes, retention, and capacity limits.

### Replay routing

- Persist only the identity, endpoint mode, payload, creation time, and record version.
- Resolve cluster category and domain override from the current exporter configuration during
  replay.
- Existing records containing the older routing fields remain readable, but replay ignores those
  fields so corrected configuration takes effect after restart.

### Retry-After

- Use any valid positive `Retry-After` value directly, capped at one hour.
- Use jittered exponential fallback only when the header is absent, invalid, zero, or negative.
- Preserve the existing one-probe half-open and generation protections.

## Public API

Keep `Agent365DurableDeliveryOptions` and its nested `durableDelivery` placement. Change only the
resolved default:

```ts
new ResolvedDurableDeliveryOptions().enabled === true;
```

Explicit `enabled: false` remains supported. Storage initialization failure is observable through
diagnostic logging but does not change the public option object or require a new callback.

## Error Handling

Network delivery remains authoritative when storage is unavailable. A successful HTTP response
reports success even if storage initialization failed. A retryable HTTP or transport failure
reports exporter failure if it cannot be persisted, allowing upstream diagnostics to reflect
that telemetry was not durably accepted.

Replay treats token availability separately from transport health. Unknown replay exceptions
restore the claim and continue where safe; malformed records remain quarantined.

## Tests

Add focused tests that fail against the current branch and prove:

- durability defaults to enabled and explicit disable still works;
- storage initialization failure allows successful network export;
- 401 live exports persist and 401 replay records remain pending;
- persistence failure does not make a retryable response permanent;
- missing, timed-out, and throwing token resolvers do not block later records or back off the gate;
- shutdown drains active network-only exports and reports bounded timeout;
- configured and default roots receive stable application partitions;
- Unix fallback tries `TMPDIR`, `/var/tmp`, then `/tmp`;
- replay uses current routing configuration for records written with old routing fields;
- short positive `Retry-After` values are honored without the fallback minimum.

Run the focused durable-delivery unit tests first, then build, lint, format checks, the full unit
suite, and the repository test suite before pushing.

## Pull Request

Update the existing durable-delivery branch, push it as
`feature/a365-durable-delivery`, and create a pull request against `main`. The PR description will
link the .NET PR, explain the JavaScript-specific API shape, enumerate the final hardening parity,
and include validation results.
