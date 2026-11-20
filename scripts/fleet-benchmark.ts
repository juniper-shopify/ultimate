import { fork, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, isDeepStrictEqual } from 'node:util'
import { pace, within } from '../lib/timers.ts'
import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import type { State } from '../web/src/sdk/store.ts'
import type { TaskGraph, JsonObject } from '@earendil-works/pi-durable'
import { browserBinary } from '../extensions/browser/server.ts'
import { scriptedModel } from '../test/e2e/scripted-model.ts'
import { streamClient } from '../test/e2e/fleet-benchmark/stream.ts'

declare global {
  interface Window {
    fleetState?: () => State
    fleetLongTasks?: { start: number; duration: number }[]
  }
}

const here = fileURLToPath(new URL('../test/e2e/fleet-benchmark', import.meta.url))
const { values } = parseArgs({
  options: {
    build: { type: 'string', default: resolve('.') },
    output: { type: 'string' },
    conversations: { type: 'string', default: '1100' },
    tasks: { type: 'string', default: '1600' },
    active: { type: 'string', default: '160' },
    seconds: { type: 'string', default: '30' },
    clients: { type: 'string', default: '1' },
    shape: { type: 'string', default: 'flat' },
    'think-ms': { type: 'string', default: '0' },
    'no-browser': { type: 'boolean', default: false },
  },
})
if (!values.output) throw new Error('Required: --output <result.json>')
if (!['flat', 'tree'].includes(values.shape)) throw new Error('--shape must be flat or tree')
const build = resolve(values.build)
const output = resolve(values.output)
const sourcePaths = [
  'server',
  'shared',
  'web',
  'lib',
  'extensions',
  'agents',
  'patches',
  'pnpm-lock.yaml',
  'package.json',
  'vite.config.ts',
]
const sourceIdentity = () => {
  const hash = createHash('sha256').update(
    execFileSync('git', ['-C', build, 'diff', '--binary', 'HEAD', '--', ...sourcePaths], {
      maxBuffer: 64 * 1024 * 1024,
    }),
  )
  const untracked = execFileSync(
    'git',
    ['-C', build, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...sourcePaths],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .toSorted()
  for (const file of untracked) {
    const path = join(build, file)
    const link = lstatSync(path).isSymbolicLink()
    hash
      .update(`\0${file}\0${link ? 'link' : 'file'}\0`)
      .update(link ? readlinkSync(path) : readFileSync(path))
  }
  return {
    revision: execFileSync('git', ['-C', build, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceChangesSha256: hash.digest('hex'),
    untrackedSourceFiles: untracked.length,
  }
}
const tool = {
  revision: execFileSync(
    'git',
    ['-C', fileURLToPath(new URL('..', import.meta.url)), 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim(),
  runnerSha256: createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex'),
}
const sourceAtStart = sourceIdentity()
const count = Number(values.conversations),
  taskCount = Number(values.tasks),
  activeCount = Number(values.active)
for (const value of [
  count,
  taskCount,
  activeCount,
  Number(values.seconds),
  Number(values.clients),
  Number(values['think-ms']),
])
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Sizes must be nonnegative integers')
if (count < activeCount + 3 || Number(values.seconds) < 1 || Number(values.clients) < 1)
  throw new Error('Need conversations >= active + 3, seconds >= 1 and clients >= 1')
const cleanups: (() => void | Promise<void>)[] = []
let page: Page | undefined
let pageResult: Record<string, unknown> = { status: 'skipped', reason: '--no-browser' }
let failure: unknown
async function releaseAll() {
  const errors: unknown[] = []
  for (const close of cleanups.toReversed()) {
    try {
      await close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length)
    throw new AggregateError(failure ? [failure, ...errors] : errors, 'Benchmark cleanup failed')
}
const interrupted = new AbortController()
const deadline = AbortSignal.any([
  AbortSignal.timeout(300_000 + Number(values.seconds) * 1000),
  interrupted.signal,
])
try {
  await mkdir(dirname(output), { recursive: true })
  const scratch = await mkdtemp(join(dirname(output), 'fleet-'))
  cleanups.push(() => rm(scratch, { recursive: true, force: true }))
  const project = join(scratch, 'project')
  await mkdir(join(project, '.ultimate/extensions'), { recursive: true })
  await cp(join(here, 'fixture'), join(project, '.ultimate/extensions/fleet-probe'), {
    recursive: true,
  })
  await rename(
    join(project, '.ultimate/extensions/fleet-probe/web.txt'),
    join(project, '.ultimate/extensions/fleet-probe/web.tsx'),
  )
  await symlink(join(build, 'node_modules'), join(project, 'node_modules'), 'dir')
  await mkdir(join(scratch, 'user/.ultimate'), { recursive: true })
  await writeFile(join(scratch, 'user/.ultimate/trust.json'), JSON.stringify({ [project]: true }))
  await writeFile(join(scratch, 'user/.ultimate/onboarding.json'), '{"firstRunDone":true}')
  await writeFile(
    join(project, '.ultimate/settings.json'),
    JSON.stringify({
      extensions: { disable: ['update', 'cloud', 'push', 'parallel', 'tailscale', 'claude-code'] },
      summaryModel: 'scripted/scripted-1',
      modelFamilies: {
        families: Object.fromEntries(
          ['default', 'design', 'fast', 'review', 'tiny'].map((name) => [
            name,
            { model: 'scripted/scripted-1' },
          ]),
        ),
      },
    }),
  )
  let looping = true,
    calls = 0
  let providerFailure: string | undefined
  let initialRequests = 0
  const providerStop = new AbortController()
  const provider = await scriptedModel(async (last) => {
    if (looping && last.role === 'tool' && !last.text.startsWith('Synthetic sample.'))
      providerFailure = `Synthetic tool failed: ${last.text.slice(0, 200)}`
    if (looping && (last.role === 'tool' || last.text === 'Run the fleet synthetic sample loop.')) {
      if (Number(values['think-ms']) > 0) {
        const phaseOffset =
          last.role === 'user'
            ? (Number(values['think-ms']) * initialRequests++) / Math.max(1, activeCount)
            : 0
        await pace(Number(values['think-ms']) + phaseOffset, providerStop.signal).catch(
          (error: unknown) => {
            if (!providerStop.signal.aborted) throw error
          },
        )
      }
      if (!looping) return { text: 'Synthetic run complete.' }
      calls++
      return { text: 'Inspecting a synthetic sample.', tool: { name: 'fleet_pulse', args: {} } }
    }
    return {
      text: '{"title":"Synthetic sample","activity":"inspect","summary":"Synthetic benchmark content."}',
    }
  })
  cleanups.push(async () => {
    providerStop.abort()
    await provider.close()
  })
  const log = await open(output.replace(/\.json$/, '') + '.host.log', 'w')
  cleanups.push(() => log.close())
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(scratch, 'user'),
    TMPDIR: scratch,
    ULTIMATE_HOME: join(scratch, 'store'),
    ULTIMATE_USER_HOME: join(scratch, 'user'),
    ULTIMATE_NO_OPEN: '1',
    ...provider.env,
  }
  const child = fork(
    join(here, 'host.ts'),
    [build, scratch, String(count), String(taskCount), String(activeCount), values.shape],
    {
      cwd: build,
      env,
      detached: true,
      execArgv: ['--import', join(here, 'guard.ts')],
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
    },
  )
  cleanups.push(() => stopHost())
  type Ready = { ready: true; url: string; fixed: number; active: number[]; parent?: number }
  type HostState = {
    tasks: TaskGraph
    conversations: State['conversations']
    docs: Record<string, Record<string, JsonObject | undefined>>
    ui: unknown
  }
  type Meter = {
    samples: { seconds: number; mainThreadMs: number; mainThreadMsPerSecond: number }[]
  }
  let serial = 0
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  const ready = new Promise<Ready>((resolveReady, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      const error = new Error(
        `Host exited ${code ?? signal}; see ${output.replace(/\.json$/, '')}.host.log`,
      )
      reject(error)
      for (const entry of pending.values()) entry.reject(error)
    })
    child.on('message', (raw: unknown) => {
      const message = raw as Ready | { id: number; error?: string; result?: unknown }
      if ('ready' in message) {
        resolveReady(message)
        return
      }
      const entry = pending.get(message.id)
      if (entry) {
        pending.delete(message.id)
        if (message.error) entry.reject(new Error(message.error))
        else entry.resolve(message.result)
      }
    })
  })
  const command = <T = unknown>(name: string, extra = {}) =>
    new Promise<T>((resolveCommand, reject) => {
      const id = ++serial
      pending.set(id, { resolve: (value) => resolveCommand(value as T), reject })
      child.send({ id, command: name, ...extra })
    })
  async function waitFor(check: () => boolean | Promise<boolean>) {
    while (!(await check())) {
      if (providerFailure) throw new Error(providerFailure)
      deadline.throwIfAborted()
      await pace(50)
    }
  }
  const clients: Awaited<ReturnType<typeof streamClient>>[] = []
  let browser: Browser | undefined
  const interrupt = () => {
    interrupted.abort(new Error('Benchmark interrupted'))
    child.kill('SIGTERM')
    browser?.close().catch((error: unknown) => console.error('Closing browser:', error))
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  cleanups.push(() => {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  })
  async function stopHost() {
    const exited =
      child.exitCode === null && child.signalCode === null
        ? once(child, 'exit').then(() => {})
        : Promise.resolve()
    try {
      process.kill(-child.pid!, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    await within(5000, exited, () => new Error('Host did not stop')).catch(async () => {
      process.kill(-child.pid!, 'SIGKILL')
      await exited
    })
  }
  const host = await Promise.race([
    ready,
    new Promise<never>((_, reject) =>
      deadline.addEventListener('abort', () => reject(new Error('Host startup timed out')), {
        once: true,
      }),
    ),
  ])
  for (let index = 0; index < Number(values.clients); index++) {
    const client = await streamClient(host.url, host.active[0] ?? host.fixed)
    clients.push(client)
    cleanups.push(() => client.close())
    await waitFor(client.ready)
    await client.subscribe()
  }
  if (!values['no-browser']) {
    const executablePath = await browserBinary().catch((error: unknown) => {
      pageResult = { status: 'skipped', reason: String(error) }
      return undefined
    })
    if (executablePath) {
      browser = await chromium.launch({ executablePath, headless: true })
      const ownedBrowser = browser
      cleanups.push(() => ownedBrowser.close())
      page = await browser.newPage()
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url())
        return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
          ? route.continue()
          : route.abort()
      })
      await page.addInitScript(() => {
        const tasks: { start: number; duration: number }[] = []
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            tasks.push({ start: entry.startTime, duration: entry.duration })
        }).observe({ type: 'longtask', buffered: true })
        Object.assign(window, { fleetLongTasks: tasks })
      })
      const warm = await browser.newPage()
      warm.on('pageerror', (error) => console.error('Warm page:', error.message))
      await warm.route('**/*', (route) => {
        const url = new URL(route.request().url())
        return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
          ? route.continue()
          : route.abort()
      })
      await warm.goto(`${host.url}/?conversation=${host.fixed}`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      })
      await warm.waitForFunction(() => 'fleetState' in window, { timeout: 120_000 })
      await warm.close()
      console.error('Bundle warmed')
    }
  }
  console.error('Starting loops')
  await command('start')
  if (activeCount) {
    const docs = Object.fromEntries(host.active.map((id) => [id, ['fleet.progress']]))
    await waitFor(async () => {
      const state = await command<HostState>('state', { docs })
      return host.active.every((id) => Number(state.docs[id]?.['fleet.progress']?.pulses ?? 0) > 0)
    })
  }
  await command('fill')
  await waitFor(async () => {
    const state = await command<HostState>('state')
    return Object.values(state.tasks.tasks)
      .filter((task) => task.kind === 'fleet.park')
      .every((task) => task.state.status === 'sleeping')
  })
  const initial = await command<HostState>('state')
  console.error('Measured fleet ready', Object.keys(initial.tasks.tasks).length)
  const requestsBefore = calls
  await command('measure')
  const started = performance.now()
  const startedAt = new Date().toISOString()
  for (const client of clients) client.measure(true)
  let navigationError: unknown
  const navigation = (async () => {
    if (!page) return
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${host.url}/?conversation=${host.fixed}`, {
      waitUntil: 'commit',
      timeout: 120_000,
    })
    await page.waitForFunction(
      ({ fixed, expectedCount }) => {
        const state = window.fleetState?.()
        return (
          state?.view?.conversation.id === fixed &&
          state.tasks &&
          state.conversations.length === expectedCount &&
          state.docsOf[1]?.['lineage.roots'] != null
        )
      },
      { fixed: host.fixed, expectedCount: count },
      { timeout: 120_000 },
    )
    const target = host.active[0] ?? host.fixed
    const row = page
      .locator(`[data-conversation="${target}"], [data-child-conversation="${target}"]`)
      .first()
    if (!(await row.isVisible())) await page.getByRole('button', { name: /^Earlier/ }).click()
    await row.click({ timeout: 120_000 })
    await page
      .locator(
        `[data-conversation="${target}"][data-selected="true"], [data-child-conversation="${target}"][data-selected="true"]`,
      )
      .first()
      .waitFor({ state: 'visible' })
    const sidebarMs = performance.now() - started
    pageResult = {
      status: 'measured',
      sidebarResponseMs: sidebarMs,
      sidebarRespondedDuringReplay: sidebarMs <= Number(values.seconds) * 1000,
      errors,
    }
  })().catch((error: unknown) => {
    navigationError = error
  })
  await pace(Math.max(0, Number(values.seconds) * 1000 - (performance.now() - started)), deadline)
  const wallSeconds = (performance.now() - started) / 1000
  const endedAt = new Date().toISOString()
  for (const client of clients) client.measure(false)
  const requestsAtEnd = calls
  looping = false
  const meter = await command<Meter>('stop')
  providerStop.abort()
  await navigation
  if (navigationError) throw navigationError
  if (providerFailure) throw new Error(providerFailure)
  console.error('Loops stopped; checking replicas')
  const docIds = { [host.active[0] ?? host.fixed]: ['pi.live', 'fleet.progress'] }
  await waitFor(async () => {
    const final = await command<HostState>('state', { docs: docIds })
    return clients.every((client) => {
      const state = client.state()
      return (
        isDeepStrictEqual(state.ui, final.ui) &&
        isDeepStrictEqual(state.tasks, final.tasks) &&
        isDeepStrictEqual(state.conversations, final.conversations) &&
        isDeepStrictEqual(state.docs, final.docs[host.active[0] ?? host.fixed])
      )
    })
  })
  console.error('SSE replicas equal')
  if (page) {
    let diagnosed = false
    const browserState = () =>
      page!.evaluate(() => {
        const state = window.fleetState!()
        if (!state.view) return undefined
        return {
          tasks: state.tasks,
          conversations: state.conversations,
          ui: state.shared,
          replicas: [
            { id: state.view.conversation.id, docs: state.docs },
            ...Object.entries(state.docsOf).map(([id, docs]) => ({ id: Number(id), docs })),
          ],
        }
      })
    await waitFor(async () => {
      const state = await browserState()
      if (!state) return false
      const docs: Record<number, string[]> = {}
      for (const replica of state.replicas)
        docs[replica.id] = [...new Set([...(docs[replica.id] ?? []), ...Object.keys(replica.docs)])]
      const server = await command<HostState>('state', { docs })
      if (!diagnosed) {
        console.error('Browser replica check', {
          tasks: isDeepStrictEqual(state.tasks, server.tasks),
          list: isDeepStrictEqual(state.conversations, server.conversations),
          docs: state.replicas.flatMap((replica) =>
            Object.entries(replica.docs)
              .filter(([kind, value]) => !isDeepStrictEqual(value, server.docs[replica.id]?.[kind]))
              .map(([kind]) => [replica.id, kind]),
          ),
        })
        diagnosed = true
      }
      return (
        isDeepStrictEqual(state.ui, server.ui) &&
        isDeepStrictEqual(state.tasks, server.tasks) &&
        isDeepStrictEqual(state.conversations, server.conversations) &&
        state.replicas.every((replica) =>
          Object.entries(replica.docs).every(
            ([kind, value]) =>
              value !== null && isDeepStrictEqual(value, server.docs[replica.id]?.[kind]),
          ),
        )
      )
    })
    const longTasks = await page.evaluate((seconds) => {
      const tasks = window.fleetLongTasks!.filter((task) => task.start < seconds * 1000)
      return {
        windowSeconds: seconds,
        count: tasks.length,
        totalMs: tasks.reduce(
          (sum, task) => sum + Math.min(task.duration, seconds * 1000 - task.start),
          0,
        ),
        longestMs: Math.max(0, ...tasks.map((task) => task.duration)),
      }
    }, Number(values.seconds))
    if ((pageResult.errors as string[]).length)
      throw new Error(`Browser errors: ${(pageResult.errors as string[]).join('; ')}`)
    pageResult = { ...pageResult, longTasks, finalStateEqual: true }
    await page.screenshot({ path: output.replace(/\.json$/, '') + '.png' })
  }
  const mainThreadMs = meter.samples.reduce(
    (sum: number, sample: { mainThreadMs: number }) => sum + sample.mainThreadMs,
    0,
  )
  const cpuSeconds = meter.samples.reduce(
    (sum: number, sample: { seconds: number }) => sum + sample.seconds,
    0,
  )
  const sourceChanged = !isDeepStrictEqual(sourceAtStart, sourceIdentity())
  const result = {
    schemaVersion: 1,
    tool,
    status: sourceChanged ? 'invalid' : 'passed',
    build: {
      directory: build,
      ...sourceAtStart,
      changedDuringRun: sourceChanged,
    },
    method:
      'Generated store; real host, loopback stand-in provider, tool loops and consuming SSE clients. No model service or production data. Main-thread CPU includes all host work, excludes provider/client/browser processes.',
    fleet: {
      shape: values.shape,
      thinkMs: Number(values['think-ms']),
      startupPhaseSpreadMs: Number(values['think-ms']),
      conversations: initial.conversations.length,
      ownedConversations: initial.conversations.filter(
        (conversation: { ownerTaskId?: number }) => conversation.ownerTaskId !== undefined,
      ).length,
      forkedConversations: initial.conversations.filter(
        (conversation: { branchOf?: unknown }) => conversation.branchOf !== undefined,
      ).length,
      backgroundTasksParked: Object.values(initial.tasks.tasks)
        .filter((task) => task.kind === 'fleet.park')
        .every((task) => task.state.status === 'sleeping'),
      requestedTasks: taskCount,
      tasks: Object.keys(initial.tasks.tasks).length,
      active: activeCount,
      clients: clients.length,
    },
    startedAt,
    endedAt,
    wallSeconds,
    providerToolCalls: requestsAtEnd - requestsBefore,
    providerToolCallsPerSecond: (requestsAtEnd - requestsBefore) / wallSeconds,
    host: {
      mainThreadMs,
      wallSeconds: cpuSeconds,
      requestWindowSeconds: wallSeconds,
      windowSkewMs: (cpuSeconds - wallSeconds) * 1000,
      perRequestTiming:
        'CPU uses the host sample interval; responses use the runner interval. ms/tool-call is approximate when these intervals differ.',
      mainThreadMsPerSecond: mainThreadMs / cpuSeconds,
      mainThreadMsPerToolCall:
        requestsAtEnd === requestsBefore ? null : mainThreadMs / (requestsAtEnd - requestsBefore),
      samples: meter.samples,
    },
    streams: clients.map((client) => ({
      events: client.counts(),
      windowEvents: client.windowCounts(),
      finalStateEqual: true,
    })),
    page: pageResult,
  }
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  if (sourceChanged) process.exitCode = 1
  console.log(output)
} catch (error) {
  failure = error
  await page
    ?.screenshot({ path: output.replace(/\.json$/, '') + '.failed.png', timeout: 5000 })
    .catch((screenshotError: unknown) => console.error('Failure screenshot:', screenshotError))
  await writeFile(
    output,
    JSON.stringify(
      { schemaVersion: 1, status: 'failed', error: String(error), page: pageResult },
      null,
      2,
    ) + '\n',
  )
  throw error
} finally {
  await releaseAll()
}
