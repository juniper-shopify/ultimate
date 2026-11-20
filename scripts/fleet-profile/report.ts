import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Profiler } from 'node:inspector'

export const caveats = [
  'V8 samples are elapsed-time weights, not a CPU partition. Synchronous SQLite waits appear in native samples; use the separate direct native SQLite exec/run/get/all thread-CPU table, not a rescaled sampled share (prepare/open/close are not timed).',
  'Synchronous JS sites use hrtime.bigint elapsed time: on an unloaded core pure-CPU work approximates CPU, but elapsed includes preemption, pauses and waits. It is not thread CPU. Inclusive rows overlap and exclusive rows subtract only measured children.',
  'Thread-CPU totals, native SQLite and async actors use process.threadCpuUsage; per-call deltas can be kernel-quantized. Zero is below resolution, not free. The smallest observed positive read step is diagnostic, not a calibrated clock resolution. Aggregate longer runs; do not add separate-pass tables.',
  'Extension listener/hook attribution is perturbative and async ancestry is incomplete. Scheduler and independent listener dispatch reset attribution; unassigned CPU remains unassigned.',
  'The generated tool waits and commits a synthetic document; it does not spawn processes or exercise process-backed tools.',
  'The loopback stand-in speaks the Completions API, not Responses. This does not measure Responses-specific behavior or real model latency.',
  'Each mode uses a fresh generated store. Finite windows include in-flight request boundary effects; compare repeated runs on an otherwise quiet machine.',
  'Synchronous/actor probes target the current source and pinned dependency boundaries. A changed target fails explicitly; no files in the build or node_modules are rewritten.',
]

export interface Timing {
  calls: number
  inclusiveUs: number
  exclusiveUs: number
  inclusiveElapsedUs?: number
  exclusiveElapsedUs?: number
}
export interface Site {
  file: string
  line: number
}
export interface Capture {
  mode: string
  threadMs: number
  wallMs: number
  rows: Record<string, Timing & Site>
  sites: Record<string, Site>
  smallestObservedCpuStepUs: number | null
}
export interface FleetResult {
  status: string
  providerToolCalls: number
  host: { mainThreadMs: number; mainThreadMsPerToolCall: number | null }
  build: unknown
  tool: unknown
  fleet: unknown
  streams: { finalStateEqual: boolean }[]
}

export function sourceFile(url: string, build: string) {
  if (!url || url.startsWith('node:')) return url || '(native/runtime)'
  const path = url.startsWith('file:') ? fileURLToPath(url) : url
  const dependency = path.lastIndexOf('/node_modules/')
  if (dependency >= 0) return path.slice(dependency + 1)
  return relative(build, path)
}

export function sampleFunctions(profile: Profiler.Profile, requests: number, build: string) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map<number, number>()
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id)
  const rows = new Map<
    string,
    { name: string; file: string; line: number; selfMs: number; inclusiveMs: number }
  >()
  const keyOf = (frame: Profiler.ProfileNode['callFrame']) =>
    JSON.stringify([frame.functionName, frame.url, frame.lineNumber])
  const rowOf = (frame: Profiler.ProfileNode['callFrame']) => {
    const key = keyOf(frame)
    let row = rows.get(key)
    if (!row) {
      row = {
        name: frame.functionName || '(anonymous)',
        file: sourceFile(frame.url, build),
        line: frame.lineNumber + 1,
        selfMs: 0,
        inclusiveMs: 0,
      }
      rows.set(key, row)
    }
    return row
  }
  let idleMs = 0,
    activeMs = 0,
    sqliteSampleMs = 0
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    const id = profile.samples![index]
    const dt = (profile.timeDeltas?.[index] ?? 0) / 1000
    const node = nodes.get(id)
    if (!node) throw new Error(`Missing CPU profile node ${id}`)
    if (node.callFrame.functionName === '(idle)') {
      idleMs += dt
      continue
    }
    activeMs += dt
    rowOf(node.callFrame).selfMs += dt
    const seen = new Set<string>()
    let at: number | undefined = id
    let sqlite = false
    const visited = new Set<number>()
    while (at !== undefined && !visited.has(at)) {
      visited.add(at)
      const ancestor = nodes.get(at)!
      const key = keyOf(ancestor.callFrame)
      if (!seen.has(key)) rowOf(ancestor.callFrame).inclusiveMs += dt
      seen.add(key)
      sqlite ||= ancestor.callFrame.url.includes('/chord/dist/sqlite/')
      at = parents.get(at)
    }
    if (
      sqlite &&
      !node.callFrame.url &&
      ['exec', 'run', 'get', 'all'].includes(node.callFrame.functionName)
    )
      sqliteSampleMs += dt
  }
  return {
    activeSampleMs: activeMs,
    idleSampleMs: idleMs,
    sqliteNativeSampleMs: sqliteSampleMs,
    rows: [...rows.values()].map((row) => ({
      ...row,
      selfSampleMsPerRequest: requests ? row.selfMs / requests : null,
      inclusiveSampleMsPerRequest: requests ? row.inclusiveMs / requests : null,
    })),
  }
}

export function timingRows(capture: Capture, requests: number) {
  return Object.entries(capture.rows)
    .map(([label, row]) => ({
      label,
      ...row,
      callsPerRequest: requests ? row.calls / requests : null,
      inclusiveThreadMsPerRequest: requests ? row.inclusiveUs / 1000 / requests : null,
      exclusiveThreadMsPerRequest: requests ? row.exclusiveUs / 1000 / requests : null,
      inclusiveElapsedMsPerRequest:
        requests && row.inclusiveElapsedUs !== undefined
          ? row.inclusiveElapsedUs / 1000 / requests
          : null,
      exclusiveElapsedMsPerRequest:
        requests && row.exclusiveElapsedUs !== undefined
          ? row.exclusiveElapsedUs / 1000 / requests
          : null,
    }))
    .toSorted((a, b) => b.inclusiveUs - a.inclusiveUs)
}
