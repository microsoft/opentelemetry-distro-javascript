# Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant Microsoft the rights to use your contribution. For details, visit https://cla.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the pull request appropriately. Follow the instructions provided by the bot. You only need to do this once across all repositories using Microsoft's CLA process.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with questions or concerns.

## Before You Start

- Search existing issues before opening a new one.
- Open an issue before starting large changes so the scope and direction can be discussed.
- Keep changes focused and include tests when behavior changes.

## Development Setup

1. Install [Node.js](https://nodejs.org/) 22 or later.
2. Install dependencies.
3. Run formatting, linting, and tests before opening a pull request.

```bash
npm install
npm run build
npm run lint
npm test
```

### Using package-lock.json

The committed `package-lock.json` is generated through Microsoft's package proxy.
Microsoft contributors are required to use this proxy so dependencies undergo
the required security and vulnerability policies. The lockfile can contain
registry and tarball URLs that are inaccessible outside Microsoft.

If you cannot access the proxy, generate a replacement lockfile for local use
with an accessible npm registry. Changing `--registry` alone on the existing
lockfile does not reliably replace recorded custom-registry tarball URLs; regenerate
the lockfile rather than manually editing those URLs.

Start in a fresh checkout without `node_modules`, or move the existing root
`node_modules` directory outside the checkout first. This prevents reuse of
installed packages and the hidden `node_modules/.package-lock.json`. Back up any
local lockfile changes, then remove only the root `package-lock.json` (using your
file manager or shell). From the repository root, generate and use a local
lockfile, for example with the public npm registry:

```bash
npm install --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org/
npm ci --registry=https://registry.npmjs.org/
```

The first command resolves dependencies from `package.json` without installing
them; the second installs the generated lockfile normally. Scoped registry
settings, if configured, must also point to registries you can access.
Resolved versions may differ from the committed lockfile because of dependency
ranges and registry availability, including quarantine policies; this does not
guarantee the same dependency tree. Microsoft contributors must continue using
the required proxy rather than using this workflow to bypass its restrictions.

## Pull Requests

- Describe the problem and the approach clearly.
- Link related issues when applicable.
- Update documentation when public behavior or setup changes.
- Keep the repository planning and README documents aligned with the implementation.

## SDK performance benchmarks

After building, run the standalone harness on Node.js 22 or later. It measures
recording span creation (with and without an attribute), counter aggregation,
and log emission through the built SDK. Non-exporting processors and a metric
reader keep serialization, network transport, and exporter batching out of the
measurement. Recording/aggregation probes fail rather than measuring no-op
providers. This is not an end-to-end exporter or application benchmark.

```sh
node --expose-gc perf/benchmark.mjs --output tmp/perf/raw.json --iterations 100000 --rounds 12 --memory-iterations 10000 --memory-trials 5
node perf/export-events.mjs --input tmp/perf/raw.json --output tmp/perf/events.json
```

Both commands are offline by default. The benchmark disables inherited
OpenTelemetry/Application Insights exporter and sampler configuration,
SDKStats, automatic instrumentation, and network resource discovery in its
dedicated processes. The VM resource detector is temporarily replaced during
SDK startup because the distro invokes it independently of the detector
environment setting. None of these changes affect normal library usage.
Use a clean Node process without instrumentation preloads.

`--package-root` defaults to the current directory and must contain the tested
`@microsoft/opentelemetry` manifest and `dist/esm/index.js`. It can also point to
an extracted npm package, with dependencies installed in that directory or an
ancestor. The manifest supplies the measured package name/version. Optional
`--revision` must identify that tested package's source revision, not the CI
orchestration repository; omit it if unknown. Optional `--run-id` supplies an
explicit execution correlation shared by the result events. Neither identifier
is inferred from a host, collector, timestamp, or session.

The options shown above are the defaults. Each throughput scenario has 20,000
warmup operations followed by the requested number of measured rounds, with GC
before each round. Raw output retains nanosecond durations, per-round operation
rates, and the existing `ns/op` samples/median consumed by `perf/compare.mjs`.
Only the original two span cases are regression-gating in that comparison.
Throughput telemetry is the **median of per-round rates**, in `operations/s`,
not the reciprocal of the median duration.

Each memory trial uses a fresh `--expose-gc` worker, warms up
`min(memory-iterations, 1000)` operations, settles GC three times, captures a
baseline, performs the requested operations, then captures immediate and
post-GC snapshots. The raw artifact retains all snapshots, counts, timestamps,
package identity, runtime/OS/architecture, and supplied provenance.
Memory results are medians of **signed deltas**, without clamping or noise
thresholds: immediate heap-used, post-GC retained heap, and immediate RSS minus
baseline, in `By`; heap and retained-heap per-operation deltas are in
`By/{operation}`. These are noisy process observations, not total allocated
bytes or a leak diagnosis. Negative and zero observations remain valid.

The second command validates the raw observations and writes native OTLP JSON
named log events (`microsoft.opentelemetry.benchmark.result`). Each event has
`test.case.name`, `test.suite.name`, `benchmark.metric`, numeric `benchmark.value`,
`benchmark.unit`, `benchmark.statistic`, and actual iteration/round or
memory-trial counts. Case names are distinct from scenario labels. Metrics are
`microsoft.opentelemetry.benchmark.throughput` and
`microsoft.opentelemetry.benchmark.memory.{heap_used_delta,heap_used_delta_per_operation,retained_heap_delta,retained_heap_delta_per_operation,rss_delta}`.
The custom JSON reporting harness is identified by `telemetry.sdk.*` and
`service.name`, separately from the measured `package.name`/`package.version`.
Runtime/OS/architecture are measured resource attributes; optional provenance
uses `vcs.ref.head.revision` and `benchmark.run_id`.

Sending is a separate, explicit action for a trusted CI job or operator:

```sh
node perf/export-events.mjs --input tmp/perf/raw.json --output tmp/perf/events.json --endpoint https://YOUR-COLLECTOR/otlp/v1/logs
```

There is no default endpoint or environment-variable fallback. Keep the real
collector URL in private CI configuration, and gate submission separately from
offline benchmark execution (never submit untrusted PR results). HTTPS is
required except for loopback test servers. Credentials, query strings, and
redirects are not accepted. The request uses `Content-Type: application/json`;
timestamps/int64 attributes are strings and measurement `doubleValue` fields
are finite numbers. The default request timeout is 20,000 ms, configurable with
`--timeout-ms` up to 120,000 ms. Non-2xx responses, malformed success responses,
and partial success/error bodies fail the command. There are no automatic
retries because delivery may be uncertain. Both raw and generated payload files
remain available after export failure; archive them even on failed CI runs.
HTTP success alone does not prove downstream ingestion or dashboard refresh.
