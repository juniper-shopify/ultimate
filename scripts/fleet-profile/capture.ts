import { Session } from 'node:inspector'
import type { Profiler } from 'node:inspector'
import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { registerHooks } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { instrument, assertSites, expectedSites } from './instrument.ts'
import type { Mode } from './instrument.ts'
import { sourceFile } from './report.ts'
import type { Timing, Site } from './report.ts'

type Work = (this: unknown, ...args: unknown[]) => unknown
interface ProfileExtension {
  name: string
  hooks?: { task: string; handlers: Record<string, Work> }[]
  tools?: { name: string; execute: Work }[]
  sections?: { key: string; render: Work }[]
}
interface Hooks {
  begin(): Promise<void>
  end(): Promise<void>
  phase<T>(label: string, work: () => T, reset?: boolean): T
  root<T>(label: string, work: () => T): T
  wrap(label: string, work: Work, reset?: boolean): Work
  registration(): string
  extension(value: ProfileExtension): ProfileExtension
}
declare global {
  var fleetProfile: Hooks | undefined
}

const query = new URL(import.meta.url).searchParams
const mode = query.get('mode') as Mode
const output = query.get('output')
if (!output || !['sample', 'sync', 'actors'].includes(mode))
  throw new Error('Invalid fleet capture options')
const build = process.cwd()
const totals = new Map<string, Timing>()
const registeredLabels = new Set<string>()
const actorLabel = /^(hook:|section:|tool:|listener:extensions\/)/
const sites: Record<string, Site> = {}
let previousCpuRead: number | undefined
let smallestObservedCpuStepUs: number | null = null
const micros = () => {
  const cpu = process.threadCpuUsage()
  const value = cpu.user + cpu.system
  if (enabled && previousCpuRead !== undefined && value > previousCpuRead)
    smallestObservedCpuStepUs = Math.min(
      smallestObservedCpuStepUs ?? Infinity,
      value - previousCpuRead,
    )
  previousCpuRead = value
  return value
}
let enabled = false,
  startedCpu = 0,
  startedWall = 0
let parent: { child: number; childElapsed: number } | undefined
const row = (label: string) => {
  let value = totals.get(label)
  if (!value) {
    value = { calls: 0, inclusiveUs: 0, exclusiveUs: 0 }
    totals.set(label, value)
  }
  return value
}
const als = new AsyncLocalStorage<string[]>()
const contexts = new Map<number, string[]>()
interface Frame {
  labels: string[]
  start: number
}
let frame: Frame | undefined
const stack: (Frame | undefined)[] = []
function account() {
  if (!frame) return
  const now = micros(),
    elapsed = now - frame.start
  row(frame.labels.at(-1)!).exclusiveUs += elapsed
  for (const label of new Set(frame.labels)) row(label).inclusiveUs += elapsed
  frame.start = now
}
const asyncHook = createHook({
  init(id) {
    const labels = als.getStore()
    if (labels?.length) contexts.set(id, labels)
  },
  before(id) {
    if (!enabled) return
    account()
    stack.push(frame)
    const labels = contexts.get(id)
    frame = labels?.length ? { labels, start: micros() } : undefined
  },
  after() {
    if (enabled) {
      account()
      frame = stack.pop()
      if (frame) frame.start = micros()
    }
  },
  destroy(id) {
    contexts.delete(id)
  },
})
if (mode === 'actors') asyncHook.enable()
function phase<T>(label: string, work: () => T, reset = false): T {
  if (!enabled) return work()
  if (mode === 'actors') {
    const selected = actorLabel.test(label)
    if (selected) row(label).calls++
    if (!selected && !reset) return work()
    account()
    const previous = frame
    const labels = selected ? [...(reset ? [] : (als.getStore() ?? [])), label] : []
    frame = labels.length ? { labels, start: micros() } : undefined
    try {
      return als.run(labels, work)
    } finally {
      account()
      frame = previous
      if (frame) frame.start = micros()
    }
  }
  const value = row(label)
  value.calls++
  const previous = parent,
    current = { child: 0, childElapsed: 0 }
  parent = current
  const start = micros()
  const startElapsed = process.hrtime.bigint()
  try {
    return work()
  } finally {
    const elapsedUs = Number(process.hrtime.bigint() - startElapsed) / 1000
    const cpuUs = micros() - start
    value.inclusiveUs += cpuUs
    value.exclusiveUs += cpuUs - current.child
    value.inclusiveElapsedUs = (value.inclusiveElapsedUs ?? 0) + elapsedUs
    value.exclusiveElapsedUs = (value.exclusiveElapsedUs ?? 0) + elapsedUs - current.childElapsed
    parent = previous
    if (parent) {
      parent.child += cpuUs
      parent.childElapsed += elapsedUs
    }
  }
}
function wrap(label: string, work: Work, reset = false): Work {
  if (mode !== 'actors' || actorLabel.test(label)) registeredLabels.add(label)
  return function (...args) {
    return phase(label, () => work.apply(this, args), reset)
  }
}
function registration() {
  const lines = (new Error().stack ?? '')
    .split('\n')
    .filter((line) => !line.includes('/scripts/fleet-profile/'))
  const line =
    lines.find((value) => value.includes('/extensions/')) ??
    lines.find((value) => value.includes('/server/'))
  const match = line?.match(/\(?((?:file:\/\/\/|\/)[^()]+):(\d+):(\d+)\)?$/)
  if (!match) return 'listener:unassigned'
  const file = sourceFile(match[1], build)
  const label = `listener:${file}:${match[2]}`
  sites[label] = { file, line: Number(match[2]) }
  return label
}
const session = new Session()
function post<T = unknown>(method: string, params = {}): Promise<T> {
  return new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result as T))),
  )
}
if (mode === 'sample') {
  session.connect()
  await post('Profiler.enable')
  await post('Profiler.setSamplingInterval', { interval: 500 })
}
globalThis.fleetProfile = {
  phase,
  wrap,
  registration,
  root: (label, work) => phase(label, work, true),
  extension(value) {
    return {
      ...value,
      ...(value.hooks && {
        hooks: value.hooks.map((hook) => ({
          ...hook,
          handlers: Object.fromEntries(
            Object.entries(hook.handlers).map(([key, work]) => [
              key,
              wrap(`hook:${value.name}/${hook.task}/${key}`, work),
            ]),
          ),
        })),
      }),
      ...(value.tools && {
        tools: value.tools.map((tool) => ({
          ...tool,
          execute: wrap(`tool:${value.name}/${tool.name}`, tool.execute),
        })),
      }),
      ...(value.sections && {
        sections: value.sections.map((section) => ({
          ...section,
          render: wrap(`section:${value.name}/${section.key}`, section.render),
        })),
      }),
    }
  },
  async begin() {
    assertSites(mode, sites)
    totals.clear()
    smallestObservedCpuStepUs = null
    previousCpuRead = undefined
    if (mode === 'sample') await post('Profiler.start')
    startedCpu = micros()
    startedWall = performance.now()
    enabled = true
  },
  async end() {
    if (mode === 'actors') account()
    const threadMs = (micros() - startedCpu) / 1000,
      wallMs = performance.now() - startedWall
    enabled = false
    if (mode === 'sample') {
      const { profile } = await post<{ profile: Profiler.Profile }>('Profiler.stop')
      writeFileSync(output + '.cpuprofile', JSON.stringify(profile))
      session.disconnect()
    }
    asyncHook.disable()
    for (const label of [...registeredLabels, ...(mode === 'sync' ? expectedSites.sync : [])])
      row(label)
    const rows = Object.fromEntries(
      [...totals].map(([label, timing]) => [
        label,
        {
          ...timing,
          ...(sites[label] ?? { file: '(registered extension)', line: 0 }),
        },
      ]),
    )
    writeFileSync(
      output,
      JSON.stringify(
        {
          mode,
          threadMs,
          wallMs,
          rows,
          sites,
          expectedSiteLabels: expectedSites[mode],
          wrappedCallbackLabels: [...registeredLabels],
          smallestObservedCpuStepUs: mode === 'sample' ? null : smallestObservedCpuStepUs,
        },
        null,
        2,
      ),
    )
  },
}
if (mode === 'sync') {
  const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'exec')!.value as (
    this: DatabaseSync,
    sql: string,
  ) => void
  DatabaseSync.prototype.exec = function (sql) {
    return phase('sqlite.exec', () => originalExec.call(this, sql))
  }
  const db = new DatabaseSync(':memory:')
  const prototype = Object.getPrototypeOf(db.prepare('SELECT 1')) as Record<string, Work>
  for (const key of ['run', 'get', 'all']) {
    const original = prototype[key]
    if (typeof original !== 'function') throw new Error(`Missing native SQLite method ${key}`)
    prototype[key] = wrap('sqlite.' + key, original)
  }
  db.close()
  for (const label of ['sqlite.exec', 'sqlite.run', 'sqlite.get', 'sqlite.all'])
    sites[label] = { file: 'node:sqlite (native)', line: 0 }
}
if (mode !== 'sample')
  registerHooks({
    load(url, context, next) {
      const result = next(url, context)
      if (!result.source) return result
      const source =
        typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source)
      const changed = instrument(source, url, mode, build)
      Object.assign(sites, changed.sites)
      return changed.source === source ? result : { ...result, source: changed.source }
    },
  })
