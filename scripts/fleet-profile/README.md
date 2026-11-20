# Generated-fleet host profiles

From a checkout with locked dependencies installed, using Node 26:

```sh
node scripts/fleet-profile.ts --build /path/to/build --output /tmp/host-profile.json
```

This invokes the existing fleet benchmark and reuses its generator, loopback-only stand-in, consuming SSE client, replica-equality checks and cleanup. No production data, model credentials or real model service is used. The build and its dependencies are not rewritten. Defaults are deliberately small: 24 conversations, 32 initial live tasks, two active loops, one consuming client, and five seconds **per pass**. The browser is disabled. The build also needs its locked dependencies installed.

`--conversations`, `--tasks`, `--active`, `--clients`, `--seconds`, `--shape` and `--think-ms` have the benchmark's meanings. Increase sizes deliberately and run on an otherwise idle machine. Active loops must be positive. A quick smoke run:

```sh
node scripts/fleet-profile.ts --conversations 8 --tasks 12 --active 2 --seconds 1 --output /tmp/profile-smoke.json
pnpm test:e2e test/e2e/fleet-profile.test.ts
```

## Four fresh stores, four views of the work

The command runs four passes sequentially against the same build, each with a fresh generated store:

1. **plain**: the benchmark without profiling, a control for the cost of instrumentation.
2. **sample**: an inspector CPU profile with a 500-microsecond sampling interval. Prints the top functions by self and inclusive sampled elapsed milliseconds per tool request, with file and one-based line. Raw `.cpuprofile` output can also be opened in a CPU-profile viewer.
3. **sync**: high-resolution `process.hrtime.bigint()` elapsed timers around immutable copying, task-graph publication, scheduler wake/sleep scans, Session publication/adoption, settings resolution, extension ordering and SSE sends. These synchronous elapsed times approximate pure-CPU cost only on an unloaded core; they also include preemption, pauses and any waits. They are **not thread CPU**. Native SQLite `exec`, `run`, `get` and `all` retain separate `process.threadCpuUsage()` timers to exclude I/O wait; native iterate/prepare/open/close are not timed. Inclusive rows overlap; exclusive time subtracts measured children.
4. **actors**: selected async attribution for extension commit listeners, hooks, tools and prompt sections. Independent listener dispatch and scheduler entry reset attribution so future work is not assigned to the actor that merely woke it. The table is explicitly **perturbative**, not a prediction of CPU savings from deleting a listener.

An optional `--host-import` on the underlying benchmark loads the scratch-only capture module before host imports. The fixture awaits its begin/end callbacks at the measurement boundary; inspector start/stop is not raced with the driver's acknowledgement. Source probes use Node module load hooks and prototype wrappers only in that child process. Every expected sync/actor source site is inventoried in the capture. A moved/renamed file or missing function fails before measurement; the report also verifies the complete inventory. Instrumented sites not called during the window receive explicit zero-call rows, printed as `not called`, rather than disappearing.

The report JSON retains every function and timing row, request counts, per-pass main-thread CPU and actual fleet sizes, build identity, replica-equality results and the caveats. Build identity must remain the same across all four passes, not just within each pass; otherwise the command fails. An earlier aggregate report is removed before a new run, and a success report is written only after all passes and probes validate. Intermediate files use the output name as a prefix: each pass's benchmark JSON and logs, capture JSON, and the sampled CPU profile. Scratch stores are removed and the benchmark owns and stops its host/provider processes. Interrupting the command forwards termination to the current benchmark and waits for its cleanup. Local artifacts can contain checkout paths: review them before sharing; do not commit them as fixtures.

## Interpretation and limits

- **Sample weights are elapsed time, not a CPU partition.** Synchronous SQLite waits can appear as time inside native `exec`. The report prints non-idle sampled time / measured thread CPU as a diagnostic, and reports directly timed native SQLite CPU from the sync pass separately. It does **not** normalize all sample shares to thread CPU or subtract one run's native timing from another run's samples. That would falsely shrink copying and inflate storage CPU. Top sampled functions are useful for locating work, not an additive CPU budget.
- **Per-call thread-CPU deltas can be coarse** because `process.threadCpuUsage()` is limited by kernel accounting. CPU zeros print `below resolution`, not free work. Sync/actor captures record their smallest observed positive CPU-read step; this is a diagnostic, not a calibrated resolution guarantee. Aggregate long runs for SQLite/actor CPU. Whole-pass thread CPU stays the primary total; high-resolution synchronous elapsed rows are not an additive CPU partition and include preemption/waits.
- Inclusive rows overlap. Direct exclusive rows remove only instrumented child phases, not all possible descendants. Sampling, direct timers and async actors use different runs and must not be added together.
- Async ancestry is incomplete. The actor table includes wrapper/async-hooks overhead and does not own all CPU, GC or asynchronous runtime work. Compare the actor pass's thread CPU/request with the plain control to see perturbation; do not treat the difference between table rows as exact uninstrumented savings.
- The fixture tool waits 250 ms, commits a progress document and returns synthetic text. It **does not spawn processes** or exercise real process-backed tools. The stand-in speaks the **Completions API**, not Responses, so this does not establish the cost of Responses-specific conversion paths or real model latency.
- Each pass is a closed-loop load: a faster pass can do more requests. Every table uses that pass's own request count. Finite measurement windows have in-flight boundary effects and different transcript growth. Repeat runs; one small smoke run is not a production performance result.
- This measures the host's **main thread**, not provider/client processes, other host threads, browser latency, or a production fleet's state mix. There is no performance pass/fail threshold.
