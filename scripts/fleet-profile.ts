import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, isDeepStrictEqual } from 'node:util'
import type { Profiler } from 'node:inspector'
import { caveats, sampleFunctions, timingRows } from './fleet-profile/report.ts'
import { assertSites } from './fleet-profile/instrument.ts'
import type { Capture, FleetResult } from './fleet-profile/report.ts'

const { values } = parseArgs({
  options: {
    build: { type: 'string', default: resolve('.') },
    output: { type: 'string' },
    conversations: { type: 'string', default: '24' },
    tasks: { type: 'string', default: '32' },
    active: { type: 'string', default: '2' },
    seconds: { type: 'string', default: '5' },
    clients: { type: 'string', default: '1' },
    shape: { type: 'string', default: 'flat' },
    'think-ms': { type: 'string', default: '0' },
  },
})
if (!values.output) throw new Error('Required: --output <report.json>')
if (Number(values.active) < 1) throw new Error('Profiling needs at least one active loop')
const output = resolve(values.output),
  build = resolve(values.build)
await mkdir(dirname(output), { recursive: true })
await rm(output, { force: true })
const results: Partial<
  Record<'plain' | 'sample' | 'sync' | 'actors', { fleet: FleetResult; capture?: Capture }>
> = {}
for (const mode of ['plain', 'sample', 'sync', 'actors'] as const) {
  const benchmarkOutput = `${output}.${mode}.json`
  const captureOutput = `${output}.${mode}.capture.json`
  await Promise.all(
    [benchmarkOutput, captureOutput, captureOutput + '.cpuprofile'].map((path) =>
      rm(path, { force: true }),
    ),
  )
  const args = [
    fileURLToPath(new URL('./fleet-benchmark.ts', import.meta.url)),
    '--build',
    build,
    '--output',
    benchmarkOutput,
    '--no-browser',
  ]
  for (const key of [
    'conversations',
    'tasks',
    'active',
    'seconds',
    'clients',
    'shape',
    'think-ms',
  ] as const)
    args.push('--' + key, values[key])
  if (mode !== 'plain') {
    const preload = new URL('./fleet-profile/capture.ts', import.meta.url)
    preload.searchParams.set('mode', mode)
    preload.searchParams.set('output', captureOutput)
    args.push('--host-import', preload.href)
  }
  const log = await open(`${output}.${mode}.runner.log`, 'w')
  const child = spawn(process.execPath, args, { stdio: ['ignore', log.fd, log.fd] })
  let interrupted = false
  const interrupt = () => {
    if (interrupted) return
    interrupted = true
    child.kill('SIGTERM')
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    const [code, signal] = (await once(child, 'exit')) as [number | null, string | null]
    if (code !== 0 || interrupted)
      throw new Error(`${mode} fleet exited ${code ?? signal}; see ${output}.${mode}.runner.log`)
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    await log.close()
  }
  const fleet = JSON.parse(await readFile(benchmarkOutput, 'utf8')) as FleetResult
  if (
    fleet.status !== 'passed' ||
    fleet.providerToolCalls < 1 ||
    !fleet.streams.every((stream) => stream.finalStateEqual)
  )
    throw new Error(`${mode} fleet did not complete with tool requests and equal replicas`)
  if (
    results.plain &&
    (!isDeepStrictEqual(results.plain.fleet.build, fleet.build) ||
      !isDeepStrictEqual(results.plain.fleet.tool, fleet.tool))
  )
    throw new Error('Build/tool identity changed between profiling passes; discard this comparison')
  results[mode] = {
    fleet,
    ...(mode !== 'plain' && {
      capture: JSON.parse(await readFile(captureOutput, 'utf8')) as Capture,
    }),
  }
}
const sampleRun = results.sample!,
  directRun = results.sync!,
  actorRun = results.actors!
const profile = JSON.parse(
  await readFile(output + '.sample.capture.json.cpuprofile', 'utf8'),
) as Profiler.Profile
const sampled = sampleFunctions(profile, sampleRun.fleet.providerToolCalls, build)
const direct = timingRows(directRun.capture!, directRun.fleet.providerToolCalls)
const actors = timingRows(actorRun.capture!, actorRun.fleet.providerToolCalls)
assertSites('sync', directRun.capture!.sites)
assertSites('actors', actorRun.capture!.sites)
const report = {
  schemaVersion: 1,
  status: 'passed',
  method:
    'Four sequential generated-fleet runs: plain control, V8 sampling, direct synchronous elapsed/native CPU, perturbative async actors. No production data or real model request.',
  caveats,
  build: results.plain!.fleet.build,
  tool: results.plain!.fleet.tool,
  fleet: results.plain!.fleet.fleet,
  runs: Object.fromEntries(
    Object.entries(results).map(([mode, run]) => [
      mode,
      {
        requests: run.fleet.providerToolCalls,
        threadMsPerRequest: run.fleet.host.mainThreadMsPerToolCall,
        mainThreadMs: run.fleet.host.mainThreadMs,
        fleet: run.fleet.fleet,
        smallestObservedCpuStepUs: run.capture?.smallestObservedCpuStepUs ?? null,
        finalStateEqual: true,
      },
    ]),
  ),
  sampled: {
    ...sampled,
    activeSampleToThreadCpuRatio: sampled.activeSampleMs / sampleRun.capture!.threadMs,
  },
  direct,
  instrumentedSites: { sync: directRun.capture!.sites, actors: actorRun.capture!.sites },
  sqliteNative: direct.filter((row) => row.label.startsWith('sqlite.')),
  sqliteNativeThreadMsPerRequest:
    direct
      .filter((row) => row.label.startsWith('sqlite.'))
      .reduce((sum, row) => sum + row.exclusiveUs, 0) /
    1000 /
    directRun.fleet.providerToolCalls,
  actors,
}
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log('Host main-thread profile: generated fleet, loopback Completions stand-in')
for (const caveat of caveats) console.log('CAVEAT: ' + caveat)
const rounded = (value: number | null) => (value === null ? null : Math.round(value * 1000) / 1000)
const showCpu = (value: number | null, calls = 1) =>
  !calls
    ? 'not called'
    : value === 0
      ? 'below resolution'
      : value === null
        ? 'not timed'
        : rounded(value) || '<0.001'
const showTimings = (rows: typeof direct) =>
  rows.map((row) => ({
    site: row.label,
    file: row.file,
    line: row.line,
    'calls/request': rounded(row.callsPerRequest),
    'inclusive CPU ms/request': showCpu(row.inclusiveThreadMsPerRequest, row.calls),
    'exclusive CPU ms/request': showCpu(row.exclusiveThreadMsPerRequest, row.calls),
  }))
const showSamples = (rows: typeof sampled.rows) =>
  rows.map((row) => ({
    function: row.name,
    file: row.file,
    line: row.line,
    'self sample ms/request': rounded(row.selfSampleMsPerRequest),
    'inclusive sample ms/request': rounded(row.inclusiveSampleMsPerRequest),
  }))
console.table(
  Object.fromEntries(
    Object.entries(report.runs).map(([mode, run]) => [
      mode,
      {
        requests: run.requests,
        'thread CPU ms/request': showCpu(run.threadMsPerRequest),
        'smallest observed CPU read step us': run.smallestObservedCpuStepUs,
        finalStateEqual: run.finalStateEqual,
      },
    ]),
  ),
)
console.log('Top functions by SELF sampled elapsed ms/request (not thread CPU):')
console.table(showSamples(sampled.rows.toSorted((a, b) => b.selfMs - a.selfMs).slice(0, 20)))
console.log(
  'Top functions by INCLUSIVE sampled elapsed ms/request (overlapping, async ancestry incomplete):',
)
console.table(
  showSamples(sampled.rows.toSorted((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 20)),
)
console.log(
  'Direct synchronous ELAPSED time (hrtime.bigint, not CPU; inclusive rows overlap; waits/preemption included):',
)
console.table(
  direct
    .filter((row) => !row.label.startsWith('sqlite.'))
    .map((row) => ({
      site: row.label,
      file: row.file,
      line: row.line,
      'calls/request': rounded(row.callsPerRequest),
      'inclusive elapsed ms/request': !row.calls
        ? 'not called'
        : row.inclusiveElapsedMsPerRequest === null
          ? 'not timed'
          : rounded(row.inclusiveElapsedMsPerRequest) || '<0.001',
      'exclusive elapsed ms/request': !row.calls
        ? 'not called'
        : row.exclusiveElapsedMsPerRequest === null
          ? 'not timed'
          : rounded(row.exclusiveElapsedMsPerRequest) || '<0.001',
    })),
)
console.log('Native SQLite thread CPU, separately timed (not the sampled SQLite wall weight):')
console.table(showTimings(report.sqliteNative))
console.log(
  `Timed native SQLite APIs total: ${showCpu(report.sqliteNativeThreadMsPerRequest)} thread CPU ms/request (exec/run/get/all; separate direct run).`,
)
console.log(
  `SQLite native sampled elapsed weight: ${sampled.sqliteNativeSampleMs.toFixed(3)} ms; non-idle sample/thread-CPU ratio: ${report.sampled.activeSampleToThreadCpuRatio.toFixed(3)}. Neither is a CPU partition.`,
)
console.log(
  'PER-EXTENSION LISTENERS / HOOKS / SECTIONS: PERTURBATIVE async attribution, not additive to resource timings:',
)
console.table(
  showTimings(
    actors.filter((row) => /^(listener:extensions\/|hook:|section:|tool:)/.test(row.label)),
  ),
)
console.log(output)
