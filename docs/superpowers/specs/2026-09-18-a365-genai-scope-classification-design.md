# A365 GenAI Scope Classification Design

## Goal

Ensure A365 baggage enrichment reaches spans from supported JavaScript GenAI
instrumentations when `gen_ai.operation.name` is unavailable or provisional at
span start, without classifying unrelated spans as GenAI.

## Supported instrumentation scopes

The classifier recognizes exact scope names owned by this distribution:

- `microsoft-otel-langchain`
- `microsoft-otel-openai-agents`
- The resolved `instrumentationOptions.openaiAgents.tracerName`, when configured

`Agent365Sdk` does not require scope fallback because manual A365 scopes provide
their operation as an initial span attribute. Scope names are matched exactly;
prefixes and dotted descendants are not accepted implicitly.

## Classification precedence

At `A365SpanProcessor.onStart()`:

1. A recognized explicit `gen_ai.operation.name` classifies the span with that
   known operation.
2. An explicit but unrecognized operation remains authoritative over span-name
   inference. A supported instrumentation scope may still classify the span as
   GenAI with an unknown operation.
3. When no explicit operation exists, an exact recognized operation at the
   beginning of the span name, followed by the end of the name or a space,
   classifies the span with that operation.
4. Otherwise, an exact supported instrumentation scope classifies the span as
   GenAI with an unknown operation.
5. Spans with no recognized operation, name, or scope remain untouched.

Known `invoke_agent` operations receive generic, invoke-agent-specific, and
registered custom baggage. GenAI spans with an unknown operation receive only
generic and registered custom baggage.

## Configuration flow

`A365SpanProcessor` accepts an optional iterable of additional supported scope
names. It always includes the two distribution-owned defaults. Distro
initialization passes the resolved OpenAI Agents `tracerName` from
`config.instrumentationOptions`, which includes defaults applied by existing
configuration resolution.

No global registry is introduced. Instrumentors remain responsible only for
producing spans, and exporter filtering continues to use final recognized
operation names.

## Testing

Unit tests cover:

- Recognized operations independent of instrumentation scope.
- LangChain spans whose operation is added after `startSpan()`.
- OpenAI Agents spans starting with the provisional `chain` operation.
- Generic/custom enrichment without invoke-agent-only baggage for unknown
  operations under supported scopes.
- The configured custom OpenAI tracer name.
- Unrelated scopes, scope prefix collisions, and span-name prefix collisions.
- Explicit unrecognized operations remaining authoritative over span names.

Functional instrumentation tests assert baggage enrichment on spans emitted by
the LangChain and OpenAI Agents adapters. Source-defined scope names are
deterministic, so running external service samples is unnecessary unless these
tests reveal a mismatch.

## Non-goals

- Recognizing Python-specific scope roots such as `agent_framework`,
  `semantic_kernel`, or `opentelemetry.instrumentation.openai_v2`.
- Classifying spans from arbitrary descendants of a recognized scope prefix.
- Changing A365 exporter eligibility or accepting operation names from ambient
  baggage.
