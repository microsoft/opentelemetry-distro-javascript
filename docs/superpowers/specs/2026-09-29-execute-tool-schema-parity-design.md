# ExecuteTool Schema Parity Design

## Goal

Align the JavaScript typed ExecuteTool payload experience with the current .NET and Python implementations while preserving the existing behavior for legacy raw object and string payloads.

## Alternatives considered

1. **Explicit extension data serialized as `metadata` (selected).** Declared schema fields remain authoritative, provider fields cannot collide with them, and the wire shape matches Python and the latest .NET POCO models.
2. **Flatten extension data and reject collisions.** This prevents overwrites but produces a different wire contract from the other SDKs.
3. **Keep flat last-write-wins properties.** This preserves the current PR implementation but permits silent schema-field replacement and does not fix the reported issue.

## Model contract

Every typed schema model exposes an optional `extension_data` mapping. During serialization, a non-empty mapping is emitted as `metadata`. Extension entries are never merged into the model object, so keys such as `action`, `schema_version`, `status`, and `code` remain isolated inside `metadata`.

Declared model properties that are `null` or `undefined` are omitted. Empty arrays, empty objects, `false`, zero, and empty strings are preserved. Values inside caller-provided mappings and arrays preserve explicit `null`.

## Serialization

Typed ExecuteTool models use a dedicated recursive serializer rather than native `JSON.stringify` directly:

- validate `action`, outcome `status`, and policy `decision` against their public enum tokens;
- reject non-finite numbers, `bigint`, functions, symbols, unsupported object instances, and cyclic references;
- preserve repeated non-cyclic references;
- serialize `Date` values as ISO-8601 strings, byte arrays as base64, sets as arrays, and enum members as their string values;
- require extension data and nested mappings to be ordinary string-keyed records;
- return the existing diagnostic JSON for any typed-payload serialization failure.

Legacy untyped payloads continue through `safeSerializeToJson` unchanged.

## Components

- `tool-call-models.ts` defines the public `extension_data` fields and removes the open index signatures that currently allow undeclared fields to collide with schema properties.
- `message-utils.ts` owns schema-aware conversion and safe typed-payload serialization.
- Unit tests cover top-level and nested collisions, metadata omission, null semantics, enum validation, non-finite numbers, unsupported values, cycles, repeated references, and ordinary successful payloads.
- Documentation examples use `extension_data` and show the emitted `metadata` wire shape.

## Compatibility

The feature is not yet released, so correcting the typed model construction API does not break an existing published contract. Existing raw `Record<string, unknown>` and JSON string ToolCallDetails payloads retain their current behavior.

## Success criteria

- JavaScript collision behavior and wire output match .NET and Python.
- A regression test fails if extension keys are flattened or can replace declared fields.
- Typed serialization never throws and never silently coerces invalid schema values.
- Existing tests, type checks, build, formatting, and linting pass.
