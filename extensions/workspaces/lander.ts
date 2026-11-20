import type {
  ConversationId,
  JsonObject,
  ConversationDocToken,
  Tx,
} from '@earendil-works/pi-durable'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { copyJson } from '@earendil-works/chord/json'
import type { Context } from '@earendil-works/chord/context'
import { withAbortSignal } from '@earendil-works/chord/context'
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { debounce, deadline } from '../../lib/timers.ts'
import { git as gitCommand } from '../../lib/git.ts'
import { overshadowed, retriedLater, settled } from '../../lib/errors.ts'
import { needsRestart as restartNeeded } from '../../lib/layers.ts'
import { runGroup, sweepPidFiles } from '../../lib/process-group.ts'
import { landingWeight } from '../../lib/token-weight.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { CheckRan, SubmissionFailed, SubmissionLanded } from './api.ts'
import { setup } from './setup.ts'
import { addCheckout, treePath } from './tree.ts'
import type { Landed, LanderEntry, LanderOutcome, QueueEntry, WorkspaceIndex } from './types.ts'
import { LanderLog } from './entries.ts'
import { LanderReportEntry } from './refs.ts'

const conflictReportBytes = 4096
const mergeOutputBytes = 64 * 1024 * 1024
const utf8Prefix = (text: string, limit: number) => {
  const bytes = Buffer.from(text)
  let end = Math.min(limit, bytes.length)
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}
export const conflictSample = (output: string) => {
  const paths = lines(output)
  if (paths.length <= 200 && Buffer.byteLength(output) <= conflictReportBytes) return output
  const marker = `\n… ${paths.length} conflicting paths; showing a bounded sample.`
  return (
    utf8Prefix(paths.slice(0, 200).join('\n'), conflictReportBytes - Buffer.byteLength(marker)) +
    marker
  )
}
const git = async (source: Parameters<typeof gitCommand>[0], ...args: string[]) => {
  const options = typeof source === 'string' ? { cwd: source } : source
  const output = await gitCommand(
    args[0] === 'merge'
      ? { ...options, maxBuffer: Math.max(options.maxBuffer ?? 0, mergeOutputBytes) }
      : source,
    ...args,
  )
  return args[0] === 'diff' && args.includes('--name-only') && args.includes('--diff-filter=U')
    ? conflictSample(output)
    : output
}

const recentSubmitCardOutcomeLimit = 50
export async function landerPath(home: string, source: string, settings: JsonObject) {
  const configured = await treePath(settings, landerName(source))
  if (configured) return configured
  await mkdir(join(home, 'lander'), { recursive: true })
  return join(await realpath(join(home, 'lander')), landerHash(source))
}
const landerHash = (source: string) =>
  createHash('sha256').update(source).digest('hex').slice(0, 12)
const landerName = (source: string) => `ult-lander-${landerHash(source)}`
const checkoutCreationQueues = new Map<string, Promise<string>>()
export async function landerCheckout(
  home: string,
  source: string,
  settings: JsonObject,
  tip = 'HEAD',
) {
  const path = await landerPath(home, source, settings)
  const queued = settled(checkoutCreationQueues.get(path) ?? Promise.resolve()).then(async () => {
    const registered = (await git(source, 'worktree', 'list', '--porcelain'))
      .split('\n\n')
      .some((entry) => entry.split('\n').includes(`worktree ${path}`))
    if (!registered) {
      await rm(path, { recursive: true, force: true })
      await git(source, 'worktree', 'prune')
      await addCheckout(settings, source, path, landerName(source), ['--detach', tip])
    }
    return path
  })
  checkoutCreationQueues.set(path, queued)
  try {
    return await queued
  } finally {
    if (checkoutCreationQueues.get(path) === queued) checkoutCreationQueues.delete(path)
  }
}
export const log = (
  tx: Tx,
  id: ConversationId,
  entry: Pick<
    QueueEntry,
    'id' | 'conversationId' | 'tip' | 'target' | 'at' | 'divergence' | 'subject' | 'steps'
  >,
  data: Omit<LanderEntry, 'submission' | 'conversationId' | 'tip' | 'target' | 'at'>,
) => {
  const at = Date.now()
  if (data.step)
    entry.steps.push({
      step: data.step,
      at,
      ...(data.runs ? { runs: data.runs } : {}),
      ...(data.check ? { check: data.check } : {}),
    })
  return tx.appendEntry(LanderLog, id, {
    data: {
      submission: entry.id,
      conversationId: entry.conversationId,
      tip: entry.tip,
      target: entry.target,
      at,
      sourceEntry: entry.at,
      divergence: entry.divergence,
      ...(entry.subject && (data.step === 'queued' || data.step === 'started' || data.outcome)
        ? { subject: entry.subject }
        : {}),
      ...data,
    },
  })
}
const starterLine = (
  branch: ConversationId,
  sha: string,
  outcome: WorkspaceIndex['results'][string],
) =>
  [
    `#${branch}${outcome.subject?.title ? ` ${outcome.subject.title}` : ''} ${outcome.commits?.length ? `landed as ${sha.slice(0, 7)} on ${outcome.target}` : `had nothing new to land on ${outcome.target}`}`,
    ...(outcome.pushed ? [`pushed`] : []),
    ...(outcome.reason ? [outcome.reason] : []),
    ...(outcome.needsRestart ? ['needs restart'] : []),
    ...(outcome.flaky?.length ? [`flaky: ${outcome.flaky.join(', ')}`] : []),
  ]
    .join(' · ')
    .replace(/\s*\n\s*/g, ' ')

type Host = Pick<
  ExtensionHost,
  'home' | 'ultimateRoot' | 'harness' | 'projectSettings' | 'doc' | 'metadata' | 'notice' | 'emit'
>
type Seconds = number
type Check = { command: string; timeout?: Seconds }
type ConcurrentCheckGroup = Check[]
type Settings = {
  checks: (Check | ConcurrentCheckGroup)[]
  push?: string
  batch: number
}
const maxTargetMoveAttempts = 3
const pushTimeoutMs = 30 * 60 * 1000
type CheckLimits = { stall: Seconds; total: Seconds }
const defaultCheckLimitsSeconds: CheckLimits = { stall: 2 * 60, total: 10 * 60 }
export const limitsFor = (check: Check, limits: CheckLimits): CheckLimits =>
  check.timeout === undefined
    ? limits
    : { stall: Math.min(limits.stall, check.timeout), total: check.timeout }
const vitestFailureLine = /^\s*(FAIL|×|✗)\s/
const seconds = (value: number) => (value < 60 ? `${value} s` : `${+(value / 60).toFixed(1)} min`)

export const checkPids = (home: string) => join(home, 'lander-checks')
export const sweepChecks = async (home: string) => {
  const isResumedProcessCheck = (name: string) => name.startsWith(`${process.pid}-`)
  await sweepPidFiles(checkPids(home), isResumedProcessCheck)
  const names = await readdir(checkTemp(home)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const name of names)
    if (!name.startsWith(`${process.pid}-`))
      await rm(join(checkTemp(home), name), { recursive: true, force: true })
}
export const checkTemp = (home: string) => join(tmpdir(), `ultimate-lander-${landerHash(home)}`)

export async function runLanderCheck(
  path: string,
  command: string,
  context: Context,
  pids: string,
  temp: string,
  limits: CheckLimits = defaultCheckLimitsSeconds,
) {
  const tmp = createTempBeforeWatchdog(temp)
  let output = ''
  let partial = ''
  const failed = new Set<string>()
  let stopped: string | undefined
  const watchdog = new AbortController()
  const signal = AbortSignal.any([
    watchdog.signal,
    ...(context.abortSignal ? [context.abortSignal] : []),
  ])
  const stop = (reason: string) => {
    if (signal.aborted) return
    stopped = reason
    watchdog.abort()
  }
  const stalled = () => stop(`Stalled: no output for ${seconds(limits.stall)}, stopped`)
  const stallDeadline = debounce(limits.stall * 1000, stalled)
  stallDeadline()
  const cancelTotal = deadline(limits.total * 1000, () =>
    stop(`Timed out after ${seconds(limits.total)}`),
  )
  const report = (reason: string, heading: string) => {
    const tests = [...failed].slice(-20)
    return [reason, ...(tests.length ? [heading, ...tests] : []), output].join('\n').trim()
  }
  const onOutput = (text: string) => {
    output = (output + text).slice(-3000)
    const split = (partial + text).split('\n')
    partial = split.pop()!.slice(-1000)
    for (const line of split) {
      const plain = stripVTControlCharacters(line).trim()
      if (vitestFailureLine.test(plain)) failed.add(plain.slice(0, 300))
    }
    stallDeadline()
  }
  try {
    let exit: Awaited<ReturnType<typeof runGroup>>
    try {
      exit = await runGroup('/bin/bash', ['-c', command], {
        cwd: path,
        env: { ...process.env, TMPDIR: tmp },
        pidFile: join(pids, `${process.pid}-${randomUUID()}.pid`),
        signal,
        grace: 2000,
        onOutput,
      })
    } catch (error) {
      context.abortSignal?.throwIfAborted()
      return { failure: `${output}\n${String(error)}`.trim() }
    }
    context.abortSignal?.throwIfAborted()
    if (stopped) return { failure: report(stopped, 'Failed tests so far:'), timedOut: true }
    if (exit.outOfMemory)
      return { failure: report(`Out of memory: exit ${exit.code}`, 'Failed tests so far:') }
    if (exit.code !== 0) return { failure: report(`exit ${exit.code}`, 'Failed tests:') }
    const last = lines(stripVTControlCharacters(output)).findLast((line) => line.trim())
    return { summary: last?.trim().slice(0, 200) }
  } finally {
    stallDeadline.cancel()
    cancelTotal()
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      retriedLater,
    )
  }
}

function createTempBeforeWatchdog(temp: string) {
  mkdirSync(temp, { recursive: true })
  return mkdtempSync(join(temp, `${process.pid}-`))
}

const parseCheck = (value: unknown): Check | undefined => {
  if (typeof value === 'string') return { command: value }
  if (!value || typeof value !== 'object') return undefined
  const { command, timeout } = value as { command?: unknown; timeout?: unknown }
  if (typeof command !== 'string') return undefined
  if (timeout === undefined) return { command }
  return typeof timeout === 'number' && timeout > 0 ? { command, timeout } : undefined
}
export const landerSettings = async (host: Pick<Host, 'projectSettings'>): Promise<Settings> => {
  const lander = (await host.projectSettings()).lander as
    | { checks?: unknown; push?: unknown; batch?: unknown }
    | undefined
  const entries = lander?.checks ?? []
  const checks = Array.isArray(entries)
    ? entries.map((entry) =>
        Array.isArray(entry)
          ? entry.length > 0
            ? entry.map(parseCheck)
            : [undefined]
          : parseCheck(entry),
      )
    : undefined
  if (!checks?.every((group) => (Array.isArray(group) ? group.every(Boolean) : group)))
    throw new Error(
      'lander.checks must be an array of checks or check groups; a check is a command or { "command", "timeout" } with timeout in seconds',
    )
  if (lander?.push !== undefined && typeof lander.push !== 'string')
    throw new Error('lander.push must be a remote name')
  const pushOutsidePreview =
    lander?.push && !process.env.ULTIMATE_PREVIEW_BRANCH ? lander.push : undefined
  if (
    lander?.batch !== undefined &&
    (typeof lander.batch !== 'number' || !Number.isSafeInteger(lander.batch) || lander.batch < 1)
  )
    throw new Error('lander.batch must be a positive integer')
  return {
    batch: lander?.batch ?? 1,
    checks: checks as Settings['checks'],
    ...(pushOutsidePreview ? { push: pushOutsidePreview } : {}),
  }
}
export const contains = (cwd: string, ancestor: string, descendant: string) =>
  git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant).then(
    () => true,
    () => false,
  )
const lines = (text: string) => text.split('\n').filter(Boolean)
const failure = (error: unknown) => {
  const output = error as Error & { stdout?: string; stderr?: string }
  return `${output.stdout ?? ''}${output.stderr ?? ''}${output.stdout || output.stderr ? '' : output.message}`
    .trim()
    .slice(-3000)
}
const remote = (cwd: string, signal: AbortSignal, ...args: string[]) =>
  git({ cwd, signal, timeout: 300000 }, ...args)

type CheckedIntegration = {
  base: string
  integrated: string
  flaky: string[]
}
type LandingRecord = Landed & {
  commitCount?: number
  pathCount?: number
  note?: string
  pushSha?: string
  restartRequired?: boolean
}
type LandingOutcome = LanderOutcome & Pick<LandingRecord, 'commitCount' | 'pathCount' | 'note'>
export async function landingRecord(
  source: string,
  base: string,
  sha: string,
  flaky: string[],
  signal: AbortSignal,
): Promise<LandingRecord> {
  try {
    const options = { cwd: source, signal, timeout: 120000 }
    const [commits, count, changed] = await Promise.all([
      git(options, 'log', '--oneline', '-n', '50', `${base}..${sha}`),
      git(options, 'rev-list', '--count', `${base}..${sha}`),
      git({ ...options, maxBuffer: 64 * 1024 * 1024 }, 'diff', '--name-only', base, sha),
    ])
    const paths = lines(changed)
    const sample = paths.slice(0, 200)
    const restartPath = paths.find((path) => restartNeeded([path]))
    if (restartPath && !restartNeeded(sample)) sample[sample.length - 1] = restartPath
    return {
      sha,
      base,
      commits: lines(commits),
      commitCount: Number(count),
      paths: sample,
      pathCount: paths.length,
      flaky,
    }
  } catch (error) {
    signal.throwIfAborted()
    return {
      sha,
      base,
      commits: [`${sha.slice(0, 7)} Integration merge`],
      paths: [],
      flaky,
      note: `Commit/path lists unavailable: ${failure(error)}\nRestart requirement unknown: audit server/, shared/, patches/ and pnpm-lock.yaml when updating Ultimate.`,
    }
  }
}
export async function runLanderPush(
  source: string,
  name: string,
  sha: string,
  target: string,
  context: Context,
  home: string,
  timeout = pushTimeoutMs,
) {
  const timer = new AbortController()
  const signal = AbortSignal.any([
    timer.signal,
    ...(context.abortSignal ? [context.abortSignal] : []),
  ])
  const cancel = deadline(timeout, () => timer.abort())
  let output = ''
  try {
    const { code } = await runGroup('git', ['push', '-q', name, `${sha}:refs/heads/${target}`], {
      cwd: source,
      signal,
      grace: 2000,
      pidFile: join(checkPids(home), `${process.pid}-push-${randomUUID()}.pid`),
      onOutput: (text) => {
        output = (output + text).slice(-3000)
      },
    })
    if (code === 0) return
    context.abortSignal?.throwIfAborted()
    if (timer.signal.aborted)
      throw new Error(
        `Push timed out after ${seconds(timeout / 1000)}${output ? `:\n${output}` : ''}`,
      )
    if (code !== 0) throw new Error(output || `git push exited ${code}`)
  } finally {
    cancel()
  }
}
const landedOutcome = (landed: LandingRecord): LandingOutcome => ({
  outcome: 'landed',
  sha: landed.sha,
  base: landed.base,
  commits: landed.commits.slice(0, 50),
  paths: landed.paths.slice(0, 200),
  flaky: landed.flaky,
  ...(landed.weight ? { weight: landed.weight } : {}),
  commitCount: landed.commitCount ?? landed.commits.length,
  pathCount: landed.pathCount ?? landed.paths.length,
  ...(landed.note ? { note: landed.note } : {}),
})
type CommittedDeliveryDecision = {
  phase: 'deliver'
  id: string
  conversationId: ConversationId
  headline?: string
  outcome: WorkspaceIndex['results'][string]
  concluded: boolean
  starter?: ConversationId
}
type ConcludedBranchRelease = { phase: 'release'; conversationId: ConversationId }
type BatchOutcome = { entry: QueueEntry; text: string; outcome: LandingOutcome }
type Continuation = { reports: BatchOutcome[]; singles: string[] }
type BatchState = { phase: 'batch'; ids: string[]; attempt: number; pushRetried?: boolean }
type BatchMerge = { id: string; sha: string; base: string; failure?: LanderOutcome }
type BatchPrepared = CheckedIntegration & { merges: BatchMerge[] }
const continueLanding = (continuation?: Continuation) =>
  continuation ? { phase: 'continue' as const, ...continuation } : { phase: 'next' as const }

type BranchReportHeldAsNote = ConversationId
type UnderwayReportPhase = {
  phase: 'report'
  id: string
  conversationId: BranchReportHeldAsNote
  text: string
  headline?: string
  outcome: WorkspaceIndex['results'][string]
}

type State =
  | { phase: 'next' }
  | ({ phase: 'land'; id: string; attempt: number; pushRetried?: boolean } & {
      continuation?: Continuation
    })
  | (UnderwayReportPhase & { continuation?: Continuation })
  | (CommittedDeliveryDecision & { continuation?: Continuation })
  | (ConcludedBranchRelease & { continuation?: Continuation })
  | { phase: 'card-failed'; error: string }
  | BatchState
  | ({ phase: 'continue' } & Continuation)

export async function hasPendingLanderReport(tx: Tx, index: WorkspaceIndex, id: ConversationId) {
  for (const taskId of Object.values(index.landers)) {
    const state = (await tx.task(taskId))?.state
    if (!state || state.status === 'terminal') continue
    const checkpoint = state.checkpoint as State | undefined
    if (checkpoint?.phase === 'report' && checkpoint.conversationId === id) return true
  }
  return false
}

export async function activeLandingCards(tx: Tx, index: WorkspaceIndex) {
  const results: string[] = []
  for (const taskId of Object.values(index.landers)) {
    const task = await tx.task(taskId)
    const checkpoint = task?.state.checkpoint as State | undefined
    if (checkpoint?.phase === 'deliver' && checkpoint.concluded && checkpoint.starter !== undefined)
      results.push(checkpoint.id)
  }
  return results
}

export function createLander(
  host: Host,
  Workspaces: ConversationDocToken<WorkspaceIndex>,
  serializeSourceWrites: <T>(source: string, operation: () => Promise<T>) => Promise<T>,
  after: {
    starter: (id: ConversationId, context: Context) => Promise<ConversationId | undefined>
    working: (tx: Tx, id: ConversationId) => Promise<boolean>
    conclude: (tx: Tx, id: ConversationId) => Promise<void>
    reserveLanding: import('./api.ts').BranchesService['reserveLanding']
    retireLanding: import('./api.ts').BranchesService['retireLanding']
    submitLanding: import('./api.ts').BranchesService['submitLanding']
    release: (id: ConversationId, context: Context) => Promise<unknown>
  },
  limits: CheckLimits = defaultCheckLimitsSeconds,
) {
  async function integrationRestartRequired(
    source: string,
    base: string,
    sha: string,
    signal: AbortSignal,
  ) {
    if ((await realpath(source)) !== (await realpath(host.ultimateRoot))) return undefined
    try {
      return restartNeeded(
        lines(
          await git(
            { cwd: source, signal, maxBuffer: 64 * 1024 * 1024 },
            'diff',
            '--name-only',
            base,
            sha,
          ),
        ),
      )
    } catch (error) {
      if (signal.aborted) throw error
      return true
    }
  }
  async function resetTrackedIntegration(source: string, tip: string, signal: AbortSignal) {
    const path = await landerCheckout(host.home, source, await host.projectSettings(), tip)
    const options = { cwd: path, signal, timeout: 300000 }
    await git(options, 'reset', '--hard', '-q')
    await git(options, 'checkout', '-q', '--detach', '--force', tip)
    await git(options, 'clean', '-fdq')
    return path
  }

  const recordOutcome = async (
    tx: Tx,
    lander: ConversationId,
    entry: QueueEntry,
    text: string,
    outcome: LandingOutcome,
    sha = outcome.sha,
  ): Promise<UnderwayReportPhase> => {
    const id = entry.id
    const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
    const steps = draft.queue.find((item) => item.id === id)!.steps
    draft.queue = draft.queue.filter((item) => item.id !== id)
    if (outcome.sha) draft.items[String(entry.conversationId)].landed = outcome.sha
    draft.results[id] = {
      ...outcome,
      at: entry.at,
      divergence: entry.divergence,
      target: entry.target,
      tip: entry.tip,
      lander,
      steps,
      conversationId: entry.conversationId,
      ...(entry.subject ? { subject: entry.subject } : {}),
    }
    for (const old of Object.keys(draft.results).slice(0, -recentSubmitCardOutcomeLimit))
      delete draft.results[old]
    await log(tx, lander, entry, outcome)
    if (outcome.outcome === 'failed')
      await host.emit(tx, SubmissionFailed, {
        submission: id,
        conversationId: entry.conversationId,
        target: entry.target,
        reason: outcome.reason ?? '',
      })
    if (outcome.outcome === 'landed') {
      const subject = entry.subject ?? {}
      const commits = (outcome.commits ?? []).map((commit) => {
        const space = commit.indexOf(' ')
        return { sha: commit.slice(0, space), subject: commit.slice(space + 1) }
      })
      await host.emit(tx, SubmissionLanded, {
        submission: id,
        conversationId: entry.conversationId,
        at: entry.at,
        sha: outcome.sha!,
        base: outcome.base!,
        target: entry.target,
        lander,
        divergence: entry.divergence,
        title: subject.title ?? (await tx.doc(host.metadata, entry.conversationId)).title ?? '',
        ...(subject.summary ? { summary: subject.summary } : {}),
        ...(subject.feature ? { feature: subject.feature } : {}),
        commits: commits.slice(0, 10),
        commitCount: outcome.commitCount ?? commits.length,
        paths: (outcome.paths ?? []).slice(0, 8),
        ...(outcome.pushed ? { pushed: outcome.pushed } : {}),
      })
    }
    return {
      phase: 'report',
      id,
      conversationId: entry.conversationId,
      outcome: draft.results[id],
      headline: starterLine(entry.conversationId, sha ?? '', draft.results[id]),
      text: `[lander] Submission ${id} (#${entry.conversationId}, ${entry.tip.slice(0, 7)}) ${text}\nLog: lander conversation #${lander}.`,
    }
  }
  const landingSummary = (entry: QueueEntry, landed: LandingRecord, how = '') =>
    [
      landed.commits.length
        ? `landed${how} as ${landed.sha.slice(0, 7)} on ${entry.target}.`
        : `had nothing new to land on ${entry.target}.`,
      ...(landed.commits.length ? [`Commits:\n${landed.commits.slice(0, 50).join('\n')}`] : []),
      ...((landed.commitCount ?? landed.commits.length) > Math.min(50, landed.commits.length)
        ? [
            `… and ${(landed.commitCount ?? landed.commits.length) - Math.min(50, landed.commits.length)} more commits`,
          ]
        : []),
      ...(landed.note ? [landed.note] : []),
      ...landed.flaky.map((command) => `Flaky: ${command}`),
    ].join('\n')

  const Lander = defineTask<{ source: string }, State, null>({
    name: 'workspaces.lander',
    version: 2,
    migrate: (input, checkpoint) => ({
      input: input as { source: string },
      checkpoint: checkpoint as State,
    }),
    initial: () => ({ phase: 'next' }),
    phases: {
      next: async (task, runtime, context) => {
        let batch = 1
        try {
          batch = (await landerSettings(host)).batch
        } catch (error) {
          context.abortSignal?.throwIfAborted()
          host.notice(
            `Reading batch settings failed; the single lander will report it: ${failure(error)}`,
          )
        }
        return runtime.commit(async (tx) => {
          const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
          const entry = index.queue.find((item) => item.source === task.input.source)
          if (!entry) {
            delete index.landers[task.input.source]
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }
          if (batch > 1 && !entry.landed) {
            const entries = index.queue.filter((item) => item.source === task.input.source)
            const recovered = entries.findIndex(
              (item) => item.landed || item.target !== entry.target,
            )
            const selected = entries.slice(0, recovered === -1 ? batch : Math.min(batch, recovered))
            if (selected.length > 1) {
              for (const saved of selected) {
                saved.state = 'landing'
                await log(tx, runtime.conversationId, saved, { step: 'started' })
              }
              return {
                status: 'running',
                checkpoint: { phase: 'batch', ids: selected.map((item) => item.id), attempt: 1 },
              }
            }
          }
          entry.state = 'landing'
          await log(tx, runtime.conversationId, entry, { step: 'started' })
          return { status: 'running', checkpoint: { phase: 'land', id: entry.id, attempt: 1 } }
        }, context)
      },
      land: async (task, runtime, context) => {
        const { id, attempt, pushRetried, continuation } = task.state.checkpoint
        const { signal } = runtime
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const entry = index.queue.find((item) => item.id === id)!
        const recordedFirstFastForward = async () =>
          (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.queue.find(
            (item) => item.id === id,
          )?.landed
        const step = (
          text: string,
          {
            runs,
            result,
            output,
            ran,
          }: {
            runs?: string
            result?: LanderEntry['check']
            output?: string
            ran?: { ms: number; timedOut?: boolean }
          } = {},
        ) =>
          runtime.commit(async (tx) => {
            const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.find(
              (item) => item.id === id,
            )!
            saved.step = text
            await log(tx, runtime.conversationId, saved, {
              step: text,
              ...(runs ? { runs } : {}),
              ...(result ? { check: result } : {}),
              ...(output ? { output } : {}),
            })
            if (result && ran)
              await host.emit(tx, CheckRan, {
                submission: id,
                command: result.command,
                result: ran.timedOut ? 'timeout' : result.result,
                ms: Math.round(ran.ms),
              })
          }, context)
        const commitLandingOutcome = (text: string, outcome: LandingOutcome, sha = outcome.sha) =>
          runtime.commit(
            async (tx) => ({
              status: 'running',
              checkpoint: {
                ...(await recordOutcome(tx, runtime.conversationId, entry, text, outcome, sha)),
                ...(continuation ? { continuation } : {}),
              },
            }),
            context,
          )
        const summary = (landed: LandingRecord, sha: string, how = '') =>
          [
            landed.commits.length
              ? `landed${how} as ${sha.slice(0, 7)} on ${entry.target}.`
              : `had nothing new to land on ${entry.target}.`,
            ...(landed.commits.length
              ? [`Commits:\n${landed.commits.slice(0, 50).join('\n')}`]
              : []),
            ...((landed.commitCount ?? landed.commits.length) > Math.min(50, landed.commits.length)
              ? [
                  `… and ${(landed.commitCount ?? landed.commits.length) - Math.min(50, landed.commits.length)} more commits`,
                ]
              : []),
            ...(landed.note ? [landed.note] : []),
            ...landed.flaky.map((command) => `Flaky: ${command}`),
          ].join('\n')
        const fail = async (reason: string, output?: string, hint?: string) => {
          const landed: LandingRecord | undefined = await recordedFirstFastForward()
          const needsRestart =
            landed?.restartRequired &&
            (await realpath(source)) === (await realpath(host.ultimateRoot))
          const detail = [output ? `${reason}:\n${output}` : reason, ...(hint ? [hint] : [])].join(
            '\n',
          )
          const facts = {
            reason: landed ? `Push failed: ${reason}` : reason,
            ...(output ? { output } : {}),
            ...(hint ? { hint } : {}),
          }
          return landed
            ? commitLandingOutcome(
                `${summary(landed, landed.sha, ' locally')}\nPush failed: ${detail}${needsRestart ? '\nNeeds restart.' : ''}`,
                {
                  ...landedOutcome(landed),
                  ...facts,
                  ...(needsRestart ? { needsRestart } : {}),
                },
              )
            : commitLandingOutcome(`was not landed: ${detail}`, {
                outcome: 'failed',
                ...facts,
              })
        }
        const retry = (retried = pushRetried) =>
          runtime.commit(
            () => ({
              status: 'running',
              checkpoint: {
                phase: 'land',
                id,
                attempt: attempt + 1,
                ...(retried ? { pushRetried: retried } : {}),
                ...(continuation ? { continuation } : {}),
              },
            }),
            context,
          )
        const { source, target } = entry
        const checkContext = withAbortSignal(signal, context)
        const push = async (settings: Settings, checkedCommit: string) => {
          if (!settings.push) return { text: 'Not pushed.' }
          if (await contains(source, checkedCommit, `refs/remotes/${settings.push}/${target}`)) {
            await step(`already pushed to ${settings.push}/${target}`)
            return {
              remote: `${settings.push}/${target}`,
              text: `Pushed to ${settings.push}/${target}.`,
            }
          }
          await step(`pushing to ${settings.push}`)
          try {
            await runLanderPush(
              source,
              settings.push,
              checkedCommit,
              target,
              checkContext,
              host.home,
            )
            return {
              remote: `${settings.push}/${target}`,
              text: `Pushed to ${settings.push}/${target}.`,
            }
          } catch (error) {
            if (signal.aborted) throw error
            if (!pushRetried) return { retry: retry(true) }
            return { retry: fail(`${settings.push} rejected the push`, failure(error)) }
          }
        }
        const landedReport = async (settings: Settings, landed: LandingRecord, sha: string) => {
          const pushed = await push(settings, landed.pushSha ?? sha)
          if (pushed.retry) return pushed.retry
          const needsRestart =
            (await realpath(source)) === (await realpath(host.ultimateRoot)) &&
            (landed.restartRequired || restartNeeded(landed.paths))
          return commitLandingOutcome(
            [summary(landed, sha), pushed.text, ...(needsRestart ? ['Needs restart.'] : [])].join(
              '\n',
            ),
            {
              ...landedOutcome(landed),
              ...(pushed.remote ? { pushed: pushed.remote } : {}),
              ...(needsRestart ? { needsRestart } : {}),
            },
            sha,
          )
        }
        try {
          const settings = await landerSettings(host)
          const landingFromEarlierTask: LandingRecord | undefined = entry.landed
          if (
            landingFromEarlierTask &&
            attempt === 1 &&
            !pushRetried &&
            (await contains(
              source,
              landingFromEarlierTask.pushSha ?? landingFromEarlierTask.sha,
              `refs/heads/${target}`,
            ))
          )
            return await landedReport(settings, landingFromEarlierTask, landingFromEarlierTask.sha)
          let checkedIntegration = await runtime.memo<CheckedIntegration>(
            `prepared:${id}:${attempt}`,
            context,
          )
          if (!checkedIntegration) {
            let mergedBeforeChecks = await runtime.memo<{ base: string; sha: string }>(
              `merged:${id}:${attempt}`,
              context,
            )
            const path = await resetTrackedIntegration(
              source,
              mergedBeforeChecks?.sha ?? (await git(source, 'rev-parse', `refs/heads/${target}`)),
              signal,
            )
            if (!mergedBeforeChecks) {
              await step('preparing')
              const base = await git(path, 'rev-parse', 'HEAD')
              const mergeOrReportConflict = async (
                commit: string,
                message: string,
                reason: string,
                hint: string,
              ) => {
                try {
                  await remote(
                    path,
                    signal,
                    'merge',
                    '--no-edit',
                    '--no-stat',
                    '-q',
                    '-m',
                    message,
                    commit,
                  )
                  return false
                } catch (error) {
                  if (signal.aborted) throw error
                  const conflicts = await git(
                    { cwd: path, signal, timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
                    'diff',
                    '--name-only',
                    '--diff-filter=U',
                  )
                  await remote(path, signal, 'merge', '--abort').catch(overshadowed)
                  if (conflicts) await fail(reason, conflicts, hint)
                  else await fail('the merge failed', failure(error))
                  return true
                }
              }
              if (settings.push) {
                if (
                  await remote(path, signal, 'ls-remote', settings.push, `refs/heads/${target}`)
                ) {
                  await remote(path, signal, 'fetch', '-q', settings.push, target)
                  const fetched = await git(path, 'rev-parse', 'FETCH_HEAD')
                  if (!(await contains(path, fetched, 'HEAD'))) {
                    await step(`merging ${settings.push}/${target}`)
                    if (
                      await mergeOrReportConflict(
                        fetched,
                        `Merge ${settings.push}/${target}`,
                        `${settings.push}/${target} conflicts with local ${target}`,
                        `Reconcile ${settings.push}/${target} with local ${target}, then submit again.`,
                      )
                    )
                      return
                  }
                }
              }
              await step('merging')
              if (
                await mergeOrReportConflict(
                  entry.tip,
                  `Merge ${entry.tip.slice(0, 7)} from #${entry.conversationId} into ${target}\n\nUltimate-Conversation: ${entry.conversationId}`,
                  `it conflicts with ${target} in`,
                  `Merge ${target} into your workspace, resolve, verify and submit again.`,
                )
              )
                return
              mergedBeforeChecks = await runtime.memo(
                `merged:${id}:${attempt}`,
                { base, sha: await git(path, 'rev-parse', 'HEAD') },
                context,
              )
            }
            const { base } = mergedBeforeChecks
            await step('setting up')
            await setup(source, path, await host.projectSettings(), signal)
            const flaky: string[] = []
            for (const [position, group] of settings.checks.entries()) {
              const members = Array.isArray(group) ? group : [group]
              const commands = members.map((check) => check.command)
              const run = (command: string, member: number) =>
                runLanderCheck(
                  path,
                  command,
                  checkContext,
                  checkPids(host.home),
                  checkTemp(host.home),
                  limitsFor(members[member], limits),
                )
              const runCheckWithOneDurableRerun = async (command: string, member: number) => {
                const attemptMemoKey = `check:${id}:${attempt}:${Array.isArray(group) ? `${position}.${member}` : position}`
                let memoizedFirstRun = await runtime.memo<'passed' | 'failed'>(
                  attemptMemoKey,
                  context,
                )
                if (!memoizedFirstRun) {
                  await step(`checking: ${command}`, { runs: command })
                  const began = performance.now()
                  const ran = await run(command, member)
                  const unmemoizedResult = ran.failure === undefined ? 'passed' : 'failed'
                  const logAttemptBeforeMemo = step
                  await logAttemptBeforeMemo(`checked: ${command}`, {
                    result: {
                      command,
                      result: unmemoizedResult,
                      ...(ran.summary ? { summary: ran.summary } : {}),
                    },
                    output: ran.failure,
                    ran: { ms: performance.now() - began, timedOut: ran.timedOut },
                  })
                  memoizedFirstRun = await runtime.memo(attemptMemoKey, unmemoizedResult, context)
                }
                if (memoizedFirstRun === 'passed') return {}
                let rerun = await runtime.memo<{ failure?: string }>(
                  `${attemptMemoKey}:rerun`,
                  context,
                )
                if (!rerun) {
                  await step(`rerunning: ${command}`, { runs: command })
                  const began = performance.now()
                  const ran = await run(command, member)
                  const timing = { ms: performance.now() - began, timedOut: ran.timedOut }
                  if (ran.failure === undefined)
                    await step(`checked: ${command}`, {
                      result: {
                        command,
                        result: 'flaky',
                        ...(ran.summary ? { summary: ran.summary } : {}),
                      },
                      ran: timing,
                    })
                  else
                    await runtime.commit(async (tx) => {
                      await host.emit(tx, CheckRan, {
                        submission: id,
                        command,
                        result: ran.timedOut ? 'timeout' : 'failed',
                        ms: Math.round(timing.ms),
                      })
                    }, context)
                  rerun = await runtime.memo<{ failure?: string }>(
                    `${attemptMemoKey}:rerun`,
                    ran.failure === undefined ? {} : { failure: ran.failure },
                    context,
                  )
                }
                return rerun.failure === undefined ? { flaky: true } : { failure: rerun.failure }
              }
              const settledCheckGroup = await Promise.allSettled(
                commands.map(runCheckWithOneDurableRerun),
              )
              const results = settledCheckGroup.map((outcome) => {
                if (outcome.status === 'rejected') throw outcome.reason
                return outcome.value
              })
              const failed = results.findIndex((result) => result.failure !== undefined)
              if (failed !== -1)
                return await fail(
                  `check failed twice: ${commands[failed]}`,
                  results[failed].failure,
                  'Fix it at its cause (a flaky test too: fix or delete it), verify and submit again.',
                )
              flaky.push(...commands.filter((_command, member) => results[member].flaky))
            }
            const checkedTreeChanged =
              (await git(path, 'rev-parse', 'HEAD')) !== mergedBeforeChecks.sha ||
              (await git(path, 'status', '--porcelain'))
            if (checkedTreeChanged)
              return await fail(
                'the integration checkout changed during checks',
                `${await git(path, 'log', '--oneline', '-3')}\n${await git(path, 'status', '--short')}`.trim(),
                'Submit again.',
              )
            checkedIntegration = await runtime.memo<CheckedIntegration>(
              `prepared:${id}:${attempt}`,
              { base, integrated: mergedBeforeChecks.sha, flaky },
              context,
            )
          }
          const { base, integrated, flaky } = checkedIntegration
          await step('fast-forwarding')
          const required = entry.landed
            ? await integrationRestartRequired(source, base, integrated, signal)
            : undefined
          let refused: string | undefined
          const moved = await serializeSourceWrites(source, async () => {
            const current = await git(source, 'rev-parse', `refs/heads/${target}`)
            const replayAfterFastForward = current === integrated
            if (replayAfterFastForward) return false
            if (current !== base) return true
            try {
              const checkoutHoldingTargetBranch = (
                await git(source, 'worktree', 'list', '--porcelain')
              )
                .split('\n\n')
                .map((record) => record.split('\n'))
                .find((record) => record.includes(`branch refs/heads/${target}`))?.[0]
                .slice('worktree '.length)
              if (checkoutHoldingTargetBranch)
                await git(
                  { cwd: checkoutHoldingTargetBranch, timeout: 600000 },
                  'merge',
                  '-q',
                  '--ff-only',
                  integrated,
                )
              else await git(source, 'update-ref', `refs/heads/${target}`, integrated, base)
            } catch (error) {
              refused = failure(error)
            }
            return false
          })
          if (refused)
            return fail(
              `the checkout of ${target} refused the fast-forward to ${integrated.slice(0, 7)}`,
              refused,
            )
          if (moved) {
            if (attempt < maxTargetMoveAttempts) return retry()
            return fail(`${target} kept moving during ${maxTargetMoveAttempts} attempts.`)
          }
          const weight = await landingWeight(source, base, integrated)
          const firstFastForwardCandidate: LandingRecord = {
            ...(await landingRecord(source, base, integrated, flaky, signal)),
            ...(weight ? { weight } : {}),
          }
          let landed = firstFastForwardCandidate
          const earlierPush = landingFromEarlierTask?.pushSha
          const integratedHoldsEarlierPush =
            earlierPush !== undefined && (await contains(source, earlierPush, integrated))
          await runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            const saved = draft.queue.find((item) => item.id === id)!
            saved.landed ??= firstFastForwardCandidate
            const ownRecord: LandingRecord = saved.landed
            if (required !== undefined)
              ownRecord.restartRequired = ownRecord.restartRequired || required
            if (ownRecord.pushSha) {
              const previousPush = ownRecord.pushSha
              for (const item of draft.queue) {
                const record: LandingRecord | undefined = item.landed
                if (item.source !== source || !record?.pushSha || record.pushSha !== previousPush)
                  continue
                const siblingKeepsItsOwnRecovery =
                  item.id !== id && (previousPush !== earlierPush || !integratedHoldsEarlierPush)
                if (siblingKeepsItsOwnRecovery) continue
                record.pushSha = integrated
                if (required !== undefined)
                  record.restartRequired = record.restartRequired || required
              }
            }
            landed = copyJson(saved.landed) as LandingRecord
            draft.items[String(entry.conversationId)].landed = integrated
          }, context)
          return await landedReport(settings, landed, integrated)
        } catch (error) {
          if (signal.aborted) throw error
          return fail('it failed', failure(error))
        }
      },
      continue: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const { reports, singles } = task.state.checkpoint
          const [report, ...remaining] = reports
          if (report)
            return {
              status: 'running',
              checkpoint: {
                ...(await recordOutcome(
                  tx,
                  runtime.conversationId,
                  report.entry,
                  report.text,
                  report.outcome,
                )),
                continuation: { reports: remaining, singles },
              },
            }
          const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
          const entry = singles
            .map((id) => index.queue.find((item) => item.id === id))
            .find(Boolean)
          if (!entry) return { status: 'running', checkpoint: { phase: 'next' } }
          entry.state = 'landing'
          await log(tx, runtime.conversationId, entry, { step: 'started' })
          return {
            status: 'running',
            checkpoint: {
              phase: 'land',
              id: entry.id,
              attempt: 1,
              continuation: { reports: [], singles: singles.slice(singles.indexOf(entry.id) + 1) },
            },
          }
        }, context),
      batch: async (task, runtime, context) => {
        const { ids, attempt, pushRetried } = task.state.checkpoint
        const { source } = task.input
        const { signal } = runtime
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const entries = ids.map((id) => index.queue.find((item) => item.id === id)!)
        const target = entries[0].target
        const key = `batch:${ids.join(':')}:${attempt}`
        let active = entries
        const step = (
          text: string,
          data: {
            runs?: string
            check?: LanderEntry['check']
            output?: string
            ms?: number
            timedOut?: boolean
          } = {},
        ) =>
          runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            for (const entry of active) {
              const saved = draft.queue.find((item) => item.id === entry.id)!
              saved.step = text
              await log(tx, runtime.conversationId, saved, {
                step: text,
                ...(data.runs ? { runs: data.runs } : {}),
                ...(data.check ? { check: data.check } : {}),
                ...(data.output ? { output: data.output } : {}),
              })
              if (data.check && data.ms !== undefined)
                await host.emit(tx, CheckRan, {
                  submission: entry.id,
                  command: data.check.command,
                  result: data.timedOut ? 'timeout' : data.check.result,
                  ms: Math.round(data.ms),
                })
            }
          }, context)
        const fallback = () =>
          runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            for (const entry of entries) {
              const saved = draft.queue.find((item) => item.id === entry.id)!
              saved.state = 'queued'
              saved.step = 'falling back to single submissions'
              await log(tx, runtime.conversationId, saved, { step: saved.step })
            }
            return {
              status: 'running',
              checkpoint: { phase: 'continue', reports: [], singles: ids },
            }
          }, context)
        const finish = (outcomes: BatchOutcome[]) =>
          outcomes.some((result) => result.outcome.outcome === 'failed' && result.entry.landed)
            ? fallback()
            : runtime.commit(
                () => ({
                  status: 'running',
                  checkpoint: { phase: 'continue', reports: outcomes, singles: [] },
                }),
                context,
              )
        const mergeFailures = (merges: BatchMerge[]) =>
          finish(
            entries.map((entry) => {
              const outcome = merges.find((merge) => merge.id === entry.id)!.failure!
              return {
                entry,
                outcome,
                text: `was not landed: ${outcome.reason}:\n${outcome.output ?? ''}${outcome.hint ? `\n${outcome.hint}` : ''}`,
              }
            }),
          )
        try {
          const settings = await landerSettings(host)
          let prepared = await runtime.memo<BatchPrepared>(`prepared:${key}`, context)
          if (!prepared) {
            const memoized = await runtime.memo<{
              base: string
              sha: string
              merges: BatchMerge[]
            }>(`merged:${key}`, context)
            const root = await runtime.memo<{ base: string; sha: string }>(`root:${key}`, context)
            const path = await resetTrackedIntegration(
              source,
              memoized?.sha ??
                root?.sha ??
                (await git(source, 'rev-parse', `refs/heads/${target}`)),
              signal,
            )
            let merged = memoized
            if (!merged) {
              await step('preparing')
              const base = root?.base ?? (await git(path, 'rev-parse', 'HEAD'))
              if (
                !root &&
                settings.push &&
                (await remote(path, signal, 'ls-remote', settings.push, `refs/heads/${target}`))
              ) {
                await remote(path, signal, 'fetch', '-q', settings.push, target)
                const fetched = await git(path, 'rev-parse', 'FETCH_HEAD')
                if (!(await contains(path, fetched, 'HEAD'))) {
                  await step(`merging ${settings.push}/${target}`)
                  try {
                    await remote(
                      path,
                      signal,
                      'merge',
                      '--no-edit',
                      '--no-stat',
                      '-q',
                      '-m',
                      `Merge ${settings.push}/${target}`,
                      fetched,
                    )
                  } catch (error) {
                    if (signal.aborted) throw error
                    const output = await git(
                      { cwd: path, signal, timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
                      'diff',
                      '--name-only',
                      '--diff-filter=U',
                    )
                    await remote(path, signal, 'merge', '--abort').catch(overshadowed)
                    const reason = output
                      ? `${settings.push}/${target} conflicts with local ${target} in`
                      : 'the merge failed'
                    const detail = output || failure(error)
                    const hint = output
                      ? `Reconcile ${settings.push}/${target} with local ${target}, then submit again.`
                      : ''
                    return await finish(
                      entries.map((entry) => ({
                        entry,
                        text: `was not landed: ${reason}:\n${detail}${hint ? `\n${hint}` : ''}`,
                        outcome: {
                          outcome: 'failed',
                          reason,
                          output: detail,
                          ...(hint ? { hint } : {}),
                        },
                      })),
                    )
                  }
                }
              }
              if (!root)
                await runtime.memo(
                  `root:${key}`,
                  { base, sha: await git(path, 'rev-parse', 'HEAD') },
                  context,
                )
              const merges: BatchMerge[] = []
              for (const entry of entries) {
                const mergeKey = `merged:${key}:${entry.id}`
                const cached = await runtime.memo<BatchMerge>(mergeKey, context)
                if (cached) {
                  await remote(path, signal, 'reset', '--hard', '-q', cached.sha)
                  merges.push(cached)
                  continue
                }
                active = [entry]
                await step('merging')
                const before = await git(path, 'rev-parse', 'HEAD')
                let result: BatchMerge
                try {
                  await remote(
                    path,
                    signal,
                    'merge',
                    '--no-ff',
                    '--no-edit',
                    '--no-stat',
                    '-q',
                    '-m',
                    `Merge ${entry.tip.slice(0, 7)} from #${entry.conversationId} into ${target}\n\nUltimate-Conversation: ${entry.conversationId}`,
                    entry.tip,
                  )
                  result = { id: entry.id, base: before, sha: await git(path, 'rev-parse', 'HEAD') }
                } catch (error) {
                  if (signal.aborted) throw error
                  const output = await git(
                    { cwd: path, signal, timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
                    'diff',
                    '--name-only',
                    '--diff-filter=U',
                  )
                  await remote(path, signal, 'merge', '--abort').catch(overshadowed)
                  await remote(path, signal, 'reset', '--hard', '-q', before)
                  result = {
                    id: entry.id,
                    base: before,
                    sha: before,
                    failure: {
                      outcome: 'failed',
                      reason: output ? `it conflicts with ${target} in` : 'the merge failed',
                      output: output || failure(error),
                      ...(output
                        ? {
                            hint: `Merge ${target} into your workspace, resolve, verify and submit again.`,
                          }
                        : {}),
                    },
                  }
                }
                merges.push(await runtime.memo(mergeKey, result, context))
              }
              merged = await runtime.memo(
                `merged:${key}`,
                { base, sha: await git(path, 'rev-parse', 'HEAD'), merges },
                context,
              )
            }
            active = entries.filter(
              (entry) => !merged.merges.find((merge) => merge.id === entry.id)!.failure,
            )
            if (!active.length) return await mergeFailures(merged.merges)
            await step('setting up')
            await setup(source, path, await host.projectSettings(), signal)
            const flaky: string[] = []
            const checkContext = withAbortSignal(signal, context)
            for (const [position, group] of settings.checks.entries()) {
              const members = Array.isArray(group) ? group : [group]
              const results = await Promise.allSettled(
                members.map(async (check, member) => {
                  const checkKey = `check:${key}:${position}.${member}`
                  for (const run of [0, 1]) {
                    let result = await runtime.memo<{ failure?: string }>(
                      `${checkKey}:${run}`,
                      context,
                    )
                    if (!result) {
                      await step(`${run ? 'rerunning' : 'checking'}: ${check.command}`, {
                        runs: check.command,
                      })
                      const began = performance.now()
                      const ran = await runLanderCheck(
                        path,
                        check.command,
                        checkContext,
                        checkPids(host.home),
                        checkTemp(host.home),
                        limitsFor(check, limits),
                      )
                      await step(`checked: ${check.command}`, {
                        check: {
                          command: check.command,
                          result: ran.failure ? 'failed' : run ? 'flaky' : 'passed',
                          ...(ran.summary ? { summary: ran.summary } : {}),
                        },
                        output: ran.failure,
                        ms: performance.now() - began,
                        timedOut: ran.timedOut,
                      })
                      result = await runtime.memo<{ failure?: string }>(
                        `${checkKey}:${run}`,
                        ran.failure === undefined ? {} : { failure: ran.failure },
                        context,
                      )
                    }
                    if (result.failure === undefined) return { flaky: run === 1 }
                  }
                  return { failed: true }
                }),
              )
              const values = results.map((result) => {
                if (result.status === 'rejected') throw result.reason
                return result.value
              })
              if (values.some((result) => result.failed)) return await fallback()
              flaky.push(
                ...members
                  .filter((_check, member) => values[member].flaky)
                  .map((check) => check.command),
              )
            }
            if (
              (await git(path, 'rev-parse', 'HEAD')) !== merged.sha ||
              (await git(path, 'status', '--porcelain'))
            )
              return await fallback()
            prepared = await runtime.memo(
              `prepared:${key}`,
              { base: merged.base, integrated: merged.sha, merges: merged.merges, flaky },
              context,
            )
          }
          const { base, integrated, merges, flaky } = prepared
          active = entries.filter(
            (entry) => !merges.find((merge) => merge.id === entry.id)!.failure,
          )
          if (!active.length) return await mergeFailures(merges)
          const landings = new Map<string, LandingRecord>()
          for (const merged of merges) {
            if (merged.failure) continue
            const existing = entries.find((entry) => entry.id === merged.id)!.landed
            if (existing) {
              landings.set(merged.id, copyJson(existing) as LandingRecord)
              continue
            }
            const weight = await landingWeight(source, merged.base, merged.sha)
            landings.set(merged.id, {
              ...(await landingRecord(source, merged.base, merged.sha, flaky, signal)),
              ...(weight ? { weight } : {}),
            })
          }
          const required = await integrationRestartRequired(
            source,
            prepared.base,
            integrated,
            signal,
          )
          await step('fast-forwarding')
          const moved = await serializeSourceWrites(source, async () => {
            const current = await git(source, 'rev-parse', `refs/heads/${target}`)
            if (await contains(source, integrated, current)) return false
            if (current !== base) return true
            const holding = (await git(source, 'worktree', 'list', '--porcelain'))
              .split('\n\n')
              .map((record) => record.split('\n'))
              .find((record) => record.includes(`branch refs/heads/${target}`))?.[0]
              .slice('worktree '.length)
            if (holding)
              await git({ cwd: holding, timeout: 600000 }, 'merge', '-q', '--ff-only', integrated)
            else await git(source, 'update-ref', `refs/heads/${target}`, integrated, base)
            return false
          })
          if (moved) {
            if (attempt >= maxTargetMoveAttempts) return await fallback()
            return await runtime.commit(
              () => ({
                status: 'running',
                checkpoint: {
                  phase: 'batch',
                  ids,
                  attempt: attempt + 1,
                  ...(pushRetried ? { pushRetried } : {}),
                },
              }),
              context,
            )
          }
          await runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            for (const entry of active) {
              const saved = draft.queue.find((item) => item.id === entry.id)!
              saved.landed ??= landings.get(entry.id)!
              Object.assign(saved.landed, { pushSha: integrated })
              const record: LandingRecord = saved.landed
              if (required !== undefined)
                record.restartRequired = record.restartRequired || required
              landings.set(entry.id, copyJson(saved.landed) as LandingRecord)
              draft.items[String(entry.conversationId)].landed = saved.landed.sha
            }
          }, context)
          let pushFailure: string | undefined
          if (
            settings.push &&
            !(await contains(source, integrated, `refs/remotes/${settings.push}/${target}`))
          ) {
            for (const pushAttempt of pushRetried ? [0] : [0, 1]) {
              const pushKey = `push:${key}:${pushAttempt}`
              let pushed = await runtime.memo<{ failure?: string }>(pushKey, context)
              if (!pushed) {
                await step(`pushing to ${settings.push}`)
                try {
                  await runLanderPush(
                    source,
                    settings.push,
                    integrated,
                    target,
                    withAbortSignal(signal, context),
                    host.home,
                  )
                  pushed = {}
                } catch (error) {
                  if (signal.aborted) throw error
                  pushed = { failure: failure(error) }
                }
                pushed = await runtime.memo<{ failure?: string }>(pushKey, pushed, context)
              }
              pushFailure = pushed.failure
              if (!pushFailure) break
              if (!pushRetried && pushAttempt === 0) {
                let movedRemote = true
                try {
                  await remote(source, signal, 'fetch', '-q', settings.push, target)
                  const fetched = await git(source, 'rev-parse', 'FETCH_HEAD')
                  if (await contains(source, integrated, fetched)) {
                    pushFailure = undefined
                    break
                  }
                  movedRemote = !(await contains(source, fetched, integrated))
                } catch (error) {
                  if (signal.aborted) throw error
                  host.notice(
                    `Could not inspect ${settings.push}/${target} after rejected push: ${failure(error)}`,
                  )
                }
                if (movedRemote)
                  return await runtime.commit(
                    () => ({
                      status: 'running',
                      checkpoint: { phase: 'batch', ids, attempt: attempt + 1, pushRetried: true },
                    }),
                    context,
                  )
              }
            }
          }
          const isRunningClone = (await realpath(source)) === (await realpath(host.ultimateRoot))
          return await finish(
            entries.map((entry) => {
              const merged = merges.find((merge) => merge.id === entry.id)!
              if (merged.failure) {
                const { reason, output, hint } = merged.failure
                return {
                  entry,
                  outcome: merged.failure,
                  text: `was not landed: ${reason}:\n${output}${hint ? `\n${hint}` : ''}`,
                }
              }
              const landed = landings.get(entry.id)!
              const needsRestart =
                isRunningClone && (landed.restartRequired || restartNeeded(landed.paths))
              return {
                entry,
                outcome: {
                  ...landedOutcome(landed),
                  ...(settings.push && !pushFailure
                    ? { pushed: `${settings.push}/${target}` }
                    : {}),
                  ...(pushFailure
                    ? {
                        reason: `Push failed: ${settings.push} rejected the push`,
                        output: pushFailure,
                      }
                    : {}),
                  ...(needsRestart ? { needsRestart } : {}),
                },
                text: [
                  landingSummary(entry, landed, pushFailure ? ' locally' : ''),
                  pushFailure
                    ? `Push failed: ${settings.push} rejected the push:\n${pushFailure}`
                    : settings.push
                      ? `Pushed to ${settings.push}/${target}.`
                      : 'Not pushed.',
                  ...(needsRestart ? ['Needs restart.'] : []),
                ].join('\n'),
              }
            }),
          )
        } catch (error) {
          if (signal.aborted) throw error
          host.notice(`Batch landing fell back to single submissions: ${failure(error)}`)
          return await fallback()
        }
      },
      report: async (task, runtime, context) => {
        const { id, conversationId, text, outcome, continuation } = task.state.checkpoint
        const headline =
          task.state.checkpoint.headline ?? starterLine(conversationId, outcome.sha ?? '', outcome)
        const branch = conversationId
        const entry = { kind: LanderReportEntry.kind, data: { id, outcome } }
        const next = { status: 'running', checkpoint: continueLanding(continuation) } as const
        if (outcome.outcome === 'failed') {
          await (
            await runtime.conversation(branch, context)
          )?.submit(
            {
              type: 'input',
              content: text,
              entry,
              whenBusy: 'followUp',
              requestId: `lander:${id}`,
            },
            context,
          )
          await runtime.commit(() => next, context)
          return
        }
        await (
          await host.harness().conversation(branch, context)
        )?.submit(
          {
            type: 'write',
            requestId: `lander:${id}`,
            entry: { ...entry, model: [{ role: 'user', content: text, timestamp: Date.now() }] },
          },
          context,
        )
        const starter = await after.starter(branch, context)
        await runtime.commit(async (tx) => {
          let concludedInThisCommit = false
          const moreSubmissions = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.some(
            (submission) => submission.conversationId === branch,
          )
          if (!moreSubmissions && !(await after.working(tx, branch)))
            try {
              await after.conclude(tx, branch)
              concludedInThisCommit = true
            } catch (error) {
              host.notice(`Not concluding #${branch} after landing: ${String(error)}`)
            }
          if (concludedInThisCommit && starter !== undefined && starter !== branch)
            await after.reserveLanding(tx, branch, id)
          return {
            status: 'running',
            checkpoint: {
              phase: 'deliver',
              id,
              conversationId,
              headline,
              outcome,
              concluded: concludedInThisCommit,
              ...(starter !== undefined && starter !== branch ? { starter } : {}),
              ...(continuation ? { continuation } : {}),
            },
          }
        }, context)
      },
      deliver: async (task, runtime, context) => {
        const {
          id,
          conversationId,
          headline,
          outcome,
          concluded: conclusionCommitted,
          starter,
          continuation,
        } = task.state.checkpoint
        const entry = { kind: LanderReportEntry.kind, data: { id, outcome } }
        const content = `${headline ?? starterLine(conversationId, outcome.sha ?? '', outcome)}\nDiverged: ${outcome.divergence}\n${conclusionCommitted ? `#${conversationId} is concluded.` : `#${conversationId} still has work under way; it reports when it stops.`}`
        try {
          const to =
            starter === undefined ? undefined : await runtime.conversation(starter, context)
          await runtime.commit(async (tx) => {
            if (to && conclusionCommitted)
              await after.submitLanding(
                tx,
                to,
                { type: 'input', content, entry, whenBusy: 'followUp', requestId: `lander:${id}` },
                conversationId,
                id,
              )
            else if (to)
              await to.submit(tx, {
                type: 'write',
                requestId: `lander:${id}`,
                entry: { ...entry, model: [{ role: 'user', content, timestamp: Date.now() }] },
              })
            else if (conclusionCommitted && starter !== undefined) await after.retireLanding(tx, id)
            return {
              status: 'running',
              checkpoint: conclusionCommitted
                ? { phase: 'release', conversationId, ...(continuation ? { continuation } : {}) }
                : continueLanding(continuation),
            }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted || !conclusionCommitted || starter === undefined) throw error
          await runtime.commit(async (tx) => {
            await after.retireLanding(tx, id)
            return {
              status: 'running',
              checkpoint: {
                phase: 'card-failed',
                error: error instanceof Error ? error.message : String(error),
              },
            }
          }, context)
        }
      },
      'card-failed': (task) => {
        throw new Error(task.state.checkpoint.error)
      },
      release: async (task, runtime, context) => {
        await after
          .release(task.state.checkpoint.conversationId, context)
          .catch((error: unknown) => {
            context.abortSignal?.throwIfAborted()
            host.notice(
              `Releasing #${task.state.checkpoint.conversationId} failed: ${String(error)}`,
            )
          })
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: continueLanding(task.state.checkpoint.continuation),
          }),
          context,
        )
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
        if (index.landers[task.input.source] === task.id) delete index.landers[task.input.source]
        for (const item of index.queue)
          if (item.source === task.input.source) {
            item.state = 'queued'
            delete item.step
          }
        const checkpoint = task.state.checkpoint
        if (
          checkpoint.phase === 'deliver' &&
          checkpoint.concluded &&
          checkpoint.starter !== undefined
        )
          await after.retireLanding(tx, checkpoint.id)
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  return Lander
}
