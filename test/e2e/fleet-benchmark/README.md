# Fleet benchmark

Replay a generated fleet against one source/build directory, without model credentials, a real model service, or production data:

```sh
node scripts/fleet-benchmark.ts --build /path/to/build --output /tmp/fleet-before.json
```

For source-level main-thread attribution, see the [generated-fleet profiler](../../../scripts/fleet-profile/README.md). It reuses this runner and its stream checks in four sequential passes, with explicit sampling/SQLite/async-attribution caveats.

Run the same command against another checkout for an after result. Both checkouts need their locked dependencies installed. The runner uses the target's server, extensions and web code; it does not patch that checkout. Use the project's Node 26 runtime; the CPU meter uses `process.threadCpuUsage()`. No additional dependencies are needed.

Defaults: 1,100 listed conversations, a floor of 1,600 live tasks, 160 conversations making real durable model/tool rounds, one counted event-stream client (plus the browser's own stream when enabled), and 30 seconds of measurement. A loopback OpenAI-compatible stand-in returns one synthetic `fleet_pulse` call per round. Each pulse waits 250 ms, increments a document and returns about 4 KB of generated text. Background sleeping tasks fill the graph to the requested size; measurement waits until every filler has reached its sleeping state. Actual sizes and throughput are in the result: transient model/tool tasks can move the graph above or below the initial floor.

Options:

- `--think-ms N` delays each stand-in tool-request response by N milliseconds (default 0); summary responses remain immediate. First replies receive an additional deterministic phase offset spanning 0…N ms across the fleet, so agents do not form artificial synchronized cohorts; subsequent replies use the fixed delay. Use a delay to leave host headroom and compare CPU at nearly equal work, checking the actual request counts. Outstanding delays are cancelled at the end of the window.
- `--conversations N --tasks N --active N --clients N --seconds N` change the load. Conversations must be at least active + 3; seconds and clients must be positive.
- `--shape flat` (default) creates ownerless conversations. The browser expands Earlier before selecting an active row.
- `--shape tree` creates a tree root, forked branches, and the active conversations as task-owned children of one branch. The browser selects an active child in that branch's automatically mounted active-subagent list. Use it to measure subtree rendering/windowing.
- `--no-browser` measures the host and streams only. Otherwise the existing e2e Chromium discovery is used (`ULTIMATE_CHROMIUM` or a locally installed browser). A missing browser is recorded as skipped; a broken page fails the run.

The command prints the result path. The JSON records the target revision, a hash of tracked changes and untracked files under the measured source paths (including agents, dependency patches and the lockfile), and whether that identity changed during the run. It also records the runner's own revision and file hash. A source change marks the result `invalid` and exits nonzero; do not compare that run. The JSON has:

- `host`: main-thread CPU milliseconds, milliseconds per second, and per-second samples, measured **inside the host** with `process.threadCpuUsage()`. Other host threads, the stand-in, SSE clients and browser are excluded. Delayed timer samples carry their actual elapsed seconds. This is whole-host main-thread cost, not attribution to a particular callback. The CPU interval ends when the host services the stop command; the response-count interval ends on the runner's timer. JSON records both intervals and `windowSkewMs`. CPU per response is approximate: observed 60-second runs had up to 0.84 s (1.4%) of extra CPU sampling, potentially inflating that ratio by that amount.
- `streams[].events`: counts, SSE wire bytes (including framing), and largest JSON payload bytes grouped by event name, document kind, subscription and snapshot/operations delivery. Includes initial snapshots, warm-up and drain. `windowEvents` covers only the measurement window; heartbeat comments are excluded. The replicas also apply `tasksOps` and `conversationsUpsert` when a build emits them; unknown event names are counted without changing replicas.
- `page`: long-task count, total time overlapping the first measurement window after fresh navigation, longest task, navigation-to-sidebar-response time, page errors and final-state equality. At the default duration this is the first 30 seconds. The web bundle is built on an idle scratch host first; the measured page uses a fresh browser context/cache. Sidebar response ends when the clicked row is visibly selected, not merely when its network request starts. Replay stops on its own timer even if the page is unresponsive; `sidebarRespondedDuringReplay` distinguishes a response during load from recovery after the window.
- `providerToolCalls` counts stand-in responses requesting a tool, counted when sent, not tool completions; its rate reports throughput. Throughput matters because this is a **closed-loop** load. A faster build can do more rounds at the same CPU utilization. Compare throughput and CPU per call as well as CPU per second. There are no pass/fail performance thresholds; repeat runs on the same otherwise-idle machine.

After aborting the loops, each SSE replica's tasks, conversation list and subscribed documents must deeply equal the server's. The browser's actual SDK tasks, list and **all loaded documents** must also equal the server's (a scratch-only extension exposes a read-only SDK snapshot). Divergence, failed synthetic tools, and browser failures fail the command; no success result is written for them. A failure JSON records the error. A final screenshot and host log sit next to the JSON; do not use these local artifacts as public fixtures without reviewing them.

Each run creates a new scratch project, user home, provider configuration and SQLite store beside the output. The timeout budget is five minutes plus the requested measurement window, so a longer window is not cut short by the setup allowance. The host receives an allowlisted environment, no inherited provider credentials, and a fetch guard that refuses non-loopback destinations. Browser requests are restricted to loopback too. It never reads the user's Ultimate store or configuration. The scratch directory is deleted and owned processes stopped in cleanup; the JSON, screenshot and host log remain. Use a different output filename for concurrent runs. Run sequentially for meaningful comparisons.

Smoke test (small fleet, no browser):

```sh
pnpm test:e2e test/e2e/fleet-benchmark.test.ts
```

This measures generated workloads, not a claim about a production fleet, cold-store startup, model latency or a fixed performance improvement. The synthetic tool spawns no process; the stand-in speaks only the OpenAI chat-completions streaming API. It does not exercise a project's custom agents/extensions or git-worktree catchup. No production code or event shapes change.
