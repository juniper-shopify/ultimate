## Design: one host, more than one thread

**Design only.** This proposes future, separately reviewed PRs; it changes no code, defaults or durability contract.
The goal is more parallel live agents in one host, without making another host the unit of capacity. More threads
will not by themselves remove the store's commit queue, duplicated work, memory pressure or browser work.

Recommendation: remove repeated work first, then move the provider client, then history reads, and only then consider
agent execution on several event loops. Each step below has a proof and a stop condition. There is no throughput
promise or proposal to enable all three at once.

### The budget we have measured

These measurements came from a host with about 160 concurrent agents and 1,100 stored conversations, and separate
scratch experiments. They describe an earlier build, not a benchmark of this document's branch. The relevant paths
were re-read on `a0638de4`; Pi Durable and pi-ai remain pinned to 1.5.2. Re-measure before implementing a step.

**Measured** means an observation of a running host or an offline store copy. **Replayed** means a scratch experiment
with synthetic inputs and, for model calls, a stand-in provider: no real model request. **Estimated** means a fit or
extrapolation, not an observed saving. CPU below means the main thread's time on a processor, not whole-process CPU.

#### Per model call

| Budget                      | Result                                                                                                            | Method and limits                                                                                                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live request-size slope     | **Estimated:** about 0.18 CPU-seconds per million counted prompt tokens                                           | Linear fit over 166 minutes of thread-time samples: utilization in percent ≈ 16 + 0.0094 × calls/minute + 0.30 × millions of counted prompt tokens/minute. This is a workload fit, not a capacity law.                                                                                                        |
| Busy thread                 | **Measured:** about 84% busy at 175 million counted prompt tokens/minute                                          | Same host/thread sampler and window; request rate contributes too. This does not establish a maximum agent count.                                                                                                                                                                                             |
| Complete scratch call cycle | **Replayed:** 18.44 / 30.00 / 58.59 ms per call at about 105k / 410k / 806k synthetic tokens                      | Main-thread scheduler accounting over 60-call windows, uninstrumented host, real Responses client, short streaming response and real read tool. Synthetic tokens are request-body bytes divided by four, not tokenizer output. Includes persistence, reactors, tool and preparation of the next call. No TLS. |
| Request shape               | **Measured:** about 7.2 bytes per counted prompt token; about 40% of request bytes were encrypted reasoning items | Request-size/usage and item-size comparison in one sampled conversation, not a fleet average. Do not equate the scratch token unit with live counted tokens.                                                                                                                                                  |

At about 417k synthetic tokens (roughly 1.6 MB), the attribution was:

| Work                                              | Time per call                                     | Method and limits                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two conversation reactors re-reading full context | **Replayed:** 4.86 + 4.27 ms inclusive            | Async callback CPU attribution; each made 60 full reads in a 60-call window. A separate uninstrumented removal experiment saved about 4.0–4.4 ms at roughly this size, not the sum of the attributed times. |
| SDK request-body `JSON.stringify`                 | **Replayed:** 4.74 ms; 12.06 ms at roughly 3.2 MB | Synchronous function timing, 60 serializations per window.                                                                                                                                                  |
| Provider message conversion                       | **Replayed:** 2.06 ms                             | Same timing hook, 60 conversions; reasoning items are parsed again here.                                                                                                                                    |
| GC                                                | **Replayed:** about 1.47 ms of sampled self time  | V8 CPU samples; cannot assign this to an individual caller.                                                                                                                                                 |
| Other fixed work                                  | **Estimated:** about 10 ms per call               | Intercept of the uninstrumented three-size fit: commits, tools and hooks are not individually partitioned. Not an additive remainder of the rows above.                                                     |

**Replayed instrumentation check:** one medium-size attribution repeat was 37.17 ms/call versus 28.56 ms without it.
Do not add these rows to reconstruct the uninstrumented total, or claim their sum as a saving. Fewer, larger messages
reduced conversion time but not serialization time at equal bytes. **Replayed:** the generation's incremental context
read was about 0.05 ms/call by callback CPU attribution; it is not the two reactors' uncached full-context read.

#### Per event: two different ways to stop progress

A synchronous scan or GC pause prevents an event-loop turn. An awaited child process inside a transaction can leave
HTTP and timers running while holding the host-wide commit line. Both delay agents; only the former is a busy thread.

| Event                               | Budget                                                                                                                                                                                                                     | Method and limits                                                                                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store-wide history search           | **Measured:** 7.5–21.8 s without a model-call start on the running host; 35.3 s without an event-loop turn on an offline copy                                                                                              | Call-start gap observation on the host; heartbeat plus thread accounting around the actual search on an 8.7-GB copy with about 770,000 physical entries. Call-start silence alone is not an event-loop measurement.                                                 |
| Git in an input transaction         | **Measured:** about 179–735 ms in ordinary sampled catch-up invocations, with multi-second tails. **Replayed:** 2 s injected per git call held the hook for 10.17 s and another conversation's publication gap was 10.26 s | Timed actual helper calls, excluding durable tally/transcript reads; controlled two-conversation stand-in experiment. The same slow git outside the transaction allowed other commits. Previously admitted writes can still publish during a later callback's hold. |
| Commit-line occupancy from catch-up | **Estimated:** about 2.6 s/minute, ordinary sample envelope 1.5–6.4 s/minute                                                                                                                                               | Transfer of sampled helper costs to a two-hour placement census, about 7.5 changed-baseline transactions/minute. Placements are not exact hook counts; these are neither live utilization measurements nor bounds.                                                  |
| Open/reload backfills               | **Estimated:** 12.5–19.2 CPU-seconds                                                                                                                                                                                       | About 2,306.6 MB of active entry records times a scratch backfill coefficient of 5.4–8.3 ms/MB, covering both scans. Not a measured live reload or necessarily one uninterrupted pause.                                                                             |
| Trust read lock                     | **Replayed:** 2.02 lock-directory create/remove cycles per model call. **Measured:** 3,794 cycles/minute across several hosts                                                                                              | Scratch filesystem event count over 1,440 calls; running-host filesystem watcher. Counts show I/O amplification, not its CPU or stall cost.                                                                                                                         |
| Provider health sample              | **Measured:** one synced rewrite per model response                                                                                                                                                                        | Filesystem write/sync observation. Duration and attributable thread cost not measured.                                                                                                                                                                              |
| Task-graph broadcast                | **Replayed:** 14.9 / 41.7 / 47.9 CPU-ms per second with zero / one / three pages                                                                                                                                           | Thread-time replay with 1,137 conversations, 1,602 tasks and real event-stream clients. This is a rate, not the duration of one event.                                                                                                                              |
| Large heap collection               | **Measured:** 3.7 s pause while heap fell from 5.1 to 2.7 GB                                                                                                                                                               | Host pause/heap watcher observation, not a function-level allocation profile. It does not identify which cache caused the pressure.                                                                                                                                 |

Avoidance comes first: committed-entry reactor updates, trust-read caching, coalesced broadcasts, fewer health writes,
current-only backfills, and yielding/cancellable searches. External I/O in input hooks also needs preparation outside
the commit line. Moving it to another thread while awaiting it on the line would not fix that hold.

**Measured offline yielding experiment:** the no-hit search's longest no-turn interval fell from 35.3 s to 206 ms,
with about 20 s of thread CPU either way, using heartbeat/thread accounting on the same copy. Another sliced search
still reached 518 ms without a turn. Yielding removes the whole-search monopoly, not the single-page/record floor;
it is not a hard latency bound and does not itself stop a timed-out search.

### 1. Provider client off the thread

This is the narrowest compute boundary: keep scheduling, hooks, durable state and publication on the host; move
conversion, serialization, HTTP handling and stream parsing together. Network waiting is already asynchronous; the
reason to move it is the JavaScript before, during and after the wait, not to make an HTTP socket parallel.

The seam is [guardToolArguments](../server/tool-arguments.ts), which already wraps `Models.streamSimple` and routes
`completeSimple` through the guarded stream. [prepareHarness](../server/harness.ts) supplies that runtime to Pi.
Keep the existing whitespace guard and tracing outside the transport so both implementations see the same events.

#### First try the cheaper stack, shipped separately

1. **Cache converted items per message** in pi-ai. Key immutable messages by identity, plus every conversion input
   that can affect the result (provider/model compatibility, tool-ID normalization and surrounding transcript state).
   Verify identity stability rather than assuming the cached context guarantees it. Hooks that replace messages must
   invalidate or bypass the cache. **Proof:** byte-identical requests on synthetic histories with tools, reasoning,
   system/tool changes and provider switches; bounded cache lifetime; CPU at several byte sizes and message counts.
2. **Assemble the body from cached item strings**, on that cache. Use a supported SDK raw-body path, if available,
   rather than a replacer that still visits the whole historical tree. **Proof:** exact bytes against the original
   serializer, including escaping and omitted values; payload hooks still apply in their original order; allocation
   and CPU curves improve. Carry dependency changes as versioned patches/upstream PRs, never local package edits.

Only proceed if a fresh profile still puts the client among the leading main-thread costs and its remaining cost
misses the person's chosen latency/throughput budget. The roughly 4.74 + 2.06 ms attribution is not a proven combined
saving, and a worker must beat the cached implementation, not just the original.

#### Then the worker stack

1. **Extract a transport seam, no behavior change.** Preserve `streamSimple`, terminal result/error, tracing,
   whitespace abort and `completeSimple`. **Proof:** existing stream/guard tests and byte/event differential against
   the original transport, including a failed and an aborted stream.
2. **Add an opt-in worker transport, default off.** A bounded pool owns provider clients and their connection/session
   state. Requests and replies have session generation, call ID and sequence; streams remain pinned to their owner.
   **Proof:** stand-in byte/event equality, concurrent sessions, worker crash and clean shutdown. No automatic resend
   of an uncertain request. Keep this experimental until transcript sync and extension decoration below are ready.
3. **Synchronize transcripts incrementally.** Send an initial snapshot once per session generation, then append-only
   updates with acknowledged prefix revisions. A call names the acknowledged revision it needs, not a full transcript
   to clone again. Reset, compaction, fork, replaced history, model/compatibility change and worker loss explicitly
   invalidate the prefix and start a new generation. System/tool definitions and options have their own revisions.
   **Proof:** reset/fork/retry races, no stale prefix, ordering across calls, bounded cache release, and main-thread
   clone bytes proportional to appended data in steady state. Measure both initial sync and steady-state cost.
4. **Make request decoration data.** Global `fetch` wrappers do not run in another worker realm; functions, telemetry
   objects and arbitrary provider overlays cannot be structured-cloned. Resolve endpoint, headers, identity, proxy,
   auth scope and supported payload changes into an explicit per-call description. Credentials stay ephemeral and
   out of logs. Preserve credential refresh, HTTP dispatcher configuration and extension ordering explicitly.
   **Proof:** extension/transport contract tests, refresh during a session, redaction, HTTP failure and stream capture.
5. **Consider enabling it only for proven provider paths.** Compare cached-inline and worker modes at fleet size.
   **Proof:** lower main-thread CPU and longest stall, unchanged request bytes and terminal messages, measured total
   CPU/RSS, bounded queues, and no worse commit latency or throughput at the chosen load. Otherwise keep it opt-in.

Pi's `beforeProviderRequest`/`onPayload` replacement chain receives the converted body today; it is not just a header
hook. [fast](../extensions/fast/server.ts) and [wire](../extensions/wire/server.ts) illustrate mutation and inspection.
Preserving an arbitrary callback by sending the entire body back to the host defeats the boundary. A worker cannot
silently omit it: either introduce a declarative equivalent, explicitly keep that provider path inline, or obtain
agreement to change the extension contract before enabling it. The same applies to custom `fetch`, `onResponse`,
provider registrations and WebSocket continuation state. Start with one tested native API, not every provider.

Abort and timeout are protocol operations, not cloned `AbortSignal`s. The host owns a deadline and cancellation;
the worker must acknowledge them, stop transport/retries, settle exactly once and discard late events by call ID.
Bound queued requests and response buffers so a slow host cannot accumulate unbounded partials. Preserve event order
and avoid cloning a growing full partial on every token. Reconstruct the existing event shape at the seam, including
its final result. Measure event-copy cost as well as request-copy cost. Pool size and per-worker heap need a memory
budget; one worker per agent is not the default proposal.

### 2. History reads off the thread

Keep the writer on the host. Move history searches, entry pages and entry-derived backfill scans to workers with
owned read-only SQLite connections. [codemode's local reads](../extensions/codemode/server.ts),
[closed-chapter reads](../extensions/codemode/chapters.ts) and the
[HTTP history endpoint](../server/api.ts) are the entry points. This is not a second writable Harness and does not
move transactional document reads or repair writes out of the writer. Keep new reader paths opt-in until cancellation,
visibility and chapter lifecycle are proven.

**Measured offline prototype:** on the same store copy, a rare search parsed ten hits: 1.843 s wall, 1.821 s worker
CPU and 13.6 ms main-thread CPU. A no-hit search took 97.65 s wall, 14.24 s worker CPU and 291 ms main CPU, including a
heartbeat. Method: read-only SQLite in a worker, SQL substring filtering, fork-cutoff walk, parsing hits only, separate
thread accounting. Six option cases matched the original. This shows isolation, not a production implementation or
an overall speedup. The substring shortcut is not yet proven for every stored JSON representation or Unicode needle.

**Replayed WAL finding:** 100 commits completed in 6.06 ms beside a pinned read transaction. A PASSIVE checkpoint
advanced only 3 of 230 frames; TRUNCATE was busy until the reader released its transaction. Method: synthetic SQLite
writer, reader and explicit checkpoint attempts. Readers need not block ordinary commits, but a long-lived reader
can pin the WAL and delay checkpoint/truncation. Do not turn a store-wide search into one long read transaction.

Small PR stack:

1. **Define a read-only adapter and bounded worker lifecycle.** Do not use a writable storage opener: Pi Durable's
   `storage/sqlite/storage.js` initializer runs migrations. Open read-only without migrations, journal changes or a
   checkpoint on close. Bound admission, page work, connection count and result bytes. **Proof:** file/sidecar and
   schema checks, cancellation/close ownership, no data/schema writes from the reader, and checkpoint progress between pages
   while commits continue. Measure worst single-row/query time; a page count alone is not a time bound.
2. **Move entry pages, preserving semantics.** Walk ancestor cutoffs and descending entry order. Preserve `before`,
   kinds, limits, compact/full results and validation/errors. The writer supplies a publication fence for each page:
   disk commit can precede host publication, so a reader must not expose stored-but-unpublished batches. **Proof:**
   differential fixtures for nested forks, resets, compaction, empty/large records, pagination and concurrent appends;
   reads after an acknowledged commit see it, and never leak beyond their fence. Measure main-thread result cloning.
3. **Move search onto those pages.** Preserve conversation enumeration and result order. Inherited entries can appear
   in several conversations; do not silently deduplicate them. Start with the existing JavaScript match/format logic,
   not the prototype's SQL filter. **Proof:** exact results/errors for kinds, limits, full/compact, Unicode needles,
   missing conversations and concurrent appends; main-thread CPU, wall time and competing model-loop progress.
4. **Cancel work, not just its promise.** Pass tool abort, HTTP disconnect, deadline and shutdown to queued/running
   jobs; bound transaction/query duration, release iterators and close the connection. Synchronous SQLite work cannot
   hear a message while it runs: prove a query-interrupt or worker-termination path, with cleanup, before promising a
   cancellation bound. **Proof:** aborted searches cease consuming CPU/I/O, queued reads are removed, WAL pins release,
   and late results never reach a closed caller. Return a cancellation error, not a silently truncated success.
5. **Handle chapter changes.** Key jobs/connections by store identity and chapter generation, not a filename alone.
   Drain/cancel readers before a switch and reject old-generation replies; closed chapters remain read-only.
   **Proof:** switch away/back, shutdown, stale replies, and zero connections or WAL pins leaked after switching.
6. **Move backfill scans.** Derive facts in the reader; apply them in a short writer transaction only if conversation
   bounds/document revision still match, otherwise retry. Skip already-current conversations before scanning.
   **Proof:** backfill equals a full repair after missed commits, appends racing repair, cancellation and chapter
   switches. Enable each reader path only after its semantic, lifecycle and fleet-load proofs pass.

First preserve today's paged visibility, not a new whole-search snapshot: the conversation list is enumerated once;
an already-entered conversation's cursor excludes new higher IDs, while later conversations may expose newer commits.
Use bounded page transactions and carry the fork/cursor bounds between them. Any stronger snapshot promise needs a
separate consistency decision, not a pinned transaction spanning a long search. A backfill uses explicit validated
bounds because it writes derived state. Do not read Session-only deferred document state from an independent connection.

For search, initially parse candidate rows in the worker and run the existing JavaScript match/format logic. Pushing
substring filtering into SQL is another PR: matching stored JSON text is not automatically equivalent to matching
`JSON.stringify(parsedEntry)`, and UTF-8 substring positions are not JavaScript UTF-16 positions. Require equivalence
for all supported storage/import formats, not merely a canonical-JSON audit of one copy.

### 3. More than one event loop for agents

This is a redesign of Pi Durable integration, not another SQLite connection or an async wrapper.

Pi Durable 1.5.2's `session/session.js` header describes one in-process mutation line. A callback and its settlement
run serially, then admitted writes join group commit off the line. Publication updates caches and observers in line
order; reads gate on unpublished writes. Its `harness/scheduler.js` similarly makes task-transition decisions on that
line, with in-memory ownership/cancellation indexes. Giving several event loops independent Sessions over the same
store loses these guarantees even if SQLite serializes disk writes.

There is already a small process boundary in [lib/spawn.ts](../lib/spawn.ts): the helper owns child creation, a fixed
request/reply protocol, backpressure and failure notification. It does not run the durable scheduler or arbitrary
extension callbacks elsewhere. Reuse the ownership/lifecycle pattern, not the claim that agent sharding already exists.

The smallest useful first step is one executor process for one opt-in shard of conversations. The host remains the
only scheduler, store owner, ID allocator, transaction executor, document owner and publisher. The executor runs model
streams and explicitly supported tool handlers; every durable read/commit goes through the writer's protocol. No Tx,
tracked document, Session object or closure crosses the boundary. Shared-document and cross-conversation operations
still execute on the writer. Unsupported extension/tool code stays local, explicitly, rather than partly migrating.

Small PR stack, requiring the earlier transport work and upstream agreement:

1. **Measure the writer critical path.** Add queue-wait/callback/store/publication measurements without changing
   ordering. **Proof:** known delayed-callback and delayed-store fixtures attribute each delay to the right stage;
   instrumentation overhead is measured with it enabled/disabled.
2. **Add prepare-before-the-line admission in Pi Durable.** External I/O belongs before transactional application;
   validate prepared inputs inside the transaction and retry stale facts outside it. Cover every placement origin,
   not just HTTP submission. **Proof:** queued inputs, steers, reset, handoff, cancellation and restart preserve order
   and atomic placement, with unrelated commits progressing during delayed preparation.
3. **Migrate catch-up to that seam.** Gather git facts outside; validate baseline/workspace identity inside and
   atomically publish note/input/baseline. **Proof:** identical notes, no skipped baselines, racing inputs/target
   movement and delayed git. A cold cache delivering catch-up one input late is a behavior change, not the same fix.
   Never race a live Tx callback against a timeout. Prompt-file loading, model-auth fallback and setup checks also
   await external I/O in input hooks: migrate one consumer per follow-up PR with the same atomicity/progress proof.
4. **Separate execution from scheduling, still in-process.** Define messages for task attempt, context revisions,
   reads, tool invocation, partial progress, terminal outcome and cancellation. Keep arbitrary transaction callbacks
   on the writer, not serialized as code. **Proof:** identical committed entries, task graph and replay outcomes
   with the seam enabled; bounded message sizes and explicit rejection of unsupported handlers.
5. **Run one shard in a second process, default off.** The writer grants a task-attempt token and fences late commits
   after cancellation/disconnect; acknowledged commits alone count as durable. **Proof:** kill either side at each
   boundary, including after a tool side effect but before its result commit. Preserve replay-safe versus interrupted
   tool behavior, input/steer order, abort cascades and exactly one accepted outcome. Fence store writes and stop the
   old executor/process group before reassigning unsafe work: an epoch cannot undo a filesystem or network effect.
6. **Expand only after a fleet replay.** Compare worker threads and processes for heap/RSS, GC isolation, IPC, spawn
   cost and crash recovery. Assign conversations stably; do not move an active one in the first version. Replicate
   only committed revisions needed by that shard and define extension reload/version acknowledgement. **Proof:**
   unrelated shards progress during a CPU-heavy tool/stream, shared docs stay coherent, shutdown/restart leaves no
   orphan executor, and writer queue latency remains within the chosen budget as shard count rises.

A process gives a clearer failure boundary; threads may have cheaper communication. Neither choice removes shared
storage, disk, CPU or extension-state limits. The writer remains a shared serial limit; measure its service time
before proposing parallel writers. The scheduler's kept context ranges already have idle retention/eviction in
1.5.2. Profile retained objects and actual expiry first, rather than proposing idle eviction as if it did not exist.

Several independent hosts are the alternative today, but not several owners of one state home (see
[running](running.md)). Separate stores give separate commit lines and event loops at the cost of separate histories,
roots, task graphs and document ownership, duplicated runtime/cache memory and repeated setup/reload work. Cross-host
reads/messages can coordinate them, not provide one atomic shared transaction. Using one project checkout also leaves
filesystem/git contention and requires work isolation. These are qualitative costs, not measured scaling ratios.

### Decisions reserved for a person

- Choose the target: acceptable agent/commit latency, sustained load and total memory/CPU budget. Approve a new
  baseline after the cheaper fixes before spending complexity on workers.
- Choose the initial provider and extension contract. Is explicit inline execution acceptable for custom hooks,
  fetch wrappers or tools, or must their contracts become data before any off-thread path ships?
- Choose thread versus process isolation, worker pool limits, credential ownership and failure/retry policy.
- Approve read consistency across pages, cancellation/error behavior and chapter-switch draining. Stronger snapshots
  or partial-result APIs are separate behavior changes.
- Approve upstream dependency work and its maintenance, the single-writer execution protocol and the supported tool
  side-effect boundary. No relaxation of durability, ordering or replay guarantees is implied by this design.

### What is not known

- The relevant seams and single-writer design still exist on the inspected `main`; the earlier measurements have
  not been re-taken there. Other intervening changes can alter costs. This document carries no performance result
  for its own branch and adds no test: it is a design, not an implementation.
- The live shares of TLS, proxy/auth work, encrypted reasoning and a fully active fleet's heap remain unpartitioned.
  **Estimated:** comparing scratch thread-time windows with the live cost fit suggests only about two thirds of
  live per-call cost was reproduced at comparable bytes. The retained-heap check was not a fleet scheduler experiment.
- No successful Anthropic call-size curve was obtained: the stand-in did not recognize those requests. Other APIs,
  WebSockets, credential refresh, provider overlays and extension callbacks need independent coverage.
- Heap ownership and the cost of cloned stream partials, initial transcript sync, cancellation/termination and
  extension reload across workers are not measured. Neither worker pool size nor a sharding throughput gain is known.
- The reader prototype does not establish complete fork/order/error/Unicode equivalence, bounded WAL growth, safe
  chapter switching or cancellation. A no-hit worker read can be slow even with an idle main thread.
- Browser cost per event by function and the cause of repeated large document snapshots (subscription churn,
  reconnects or root replacement) still need profiling/counting. Threading the host does not fix browser parsing or
  rendering. Whether a one-second lag of sidebar busy marks is acceptable is also undecided; it is not a worker gain.

Every implementation PR should publish its command, synthetic fixture shape, versions, before/after main-thread and
total CPU, wall time, longest no-turn interval, commit-queue delay, bytes copied, RSS and outcome comparison. Use a
stand-in provider and a fresh scratch store; never require someone else's transcripts or a real paid model request.
A thread moved is not a result until the host makes progress sooner within the agreed memory and behavior budget.
