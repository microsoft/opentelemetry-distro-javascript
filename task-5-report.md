## Task 5 review-fix evidence

### RED

With Node 22.14.0, the Task 5 exporter regression run initially failed as expected:

- Restarted durable delivery did not replay without `forceFlush`.
- Shutdown of an in-flight multi-chunk durable export dropped the later chunk.
- Durable delivery could initialize after shutdown.
- Store initialization failure rejected `forceFlush`.

Command:

```text
node node_modules/vitest/vitest.mjs run test/internal/unit/a365/agent365Exporter.test.ts
```

Result: 4 failed, 114 passed; the pre-change test run also reported the initialization rejection as unhandled.

### GREEN

- Added eager, failure-contained durable initialization and immediate startup replay.
- Shutdown now stops admission/replay, aborts request I/O, drains accepted exports to stability within its deadline, then closes durable delivery.
- Shared Agent365 URL construction and SDKStats response/exception recording across durable and normal sends.
- Added regressions for startup replay, multi-chunk shutdown handoff, lifecycle-safe initialization, and non-poisoning initialization failures.

Validated with Node 22.14.0:

- Focused exporter and durable manager tests: 137 passed.
- All A365, main, and config unit tests: 597 passed, 2 todo.
- `npm run build`: passed.
- `npm run lint`: passed (existing repository warnings only).
- `npm run format`: passed.
