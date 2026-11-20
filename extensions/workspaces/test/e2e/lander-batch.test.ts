import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { git } from '../../../../lib/git.ts'
import { context, prepareHarness } from '../../../../server/harness.ts'
import { Metadata } from '../../../../server/metadata.ts'
import { eventLog } from '../../../../server/events.ts'
import { temp, until } from '../../../../test/helpers.ts'
import { contains, createLander } from '../../lander.ts'
import { Workspaces } from '../../workspaces.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
})

async function fixture(conflicting: boolean, recover = false, rewind = false) {
  const directory = await temp('ultimate-batch-')
  const source = join(directory, 'source')
  const bare = join(directory, 'remote.git')
  const trace = join(directory, 'trace')
  const started = join(directory, 'push-started')
  const gate = join(directory, 'push-gate')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  await writeFile(join(source, 'base.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'base')
  const base = await git(source, 'rev-parse', 'HEAD')
  if (conflicting) {
    await writeFile(join(source, 'base.txt'), 'target\n')
    await git(source, 'commit', '-am', 'target change')
  }
  await git(directory, 'init', '--bare', bare)
  await git(source, 'remote', 'add', 'origin', bare)
  await git(source, 'push', '-q', 'origin', 'main')
  await writeFile(trace, '')
  const hook = join(bare, 'hooks/pre-receive')
  await writeFile(
    hook,
    `#!/bin/sh\nwhile read old new ref; do printf 'push %s\\n' "$new" >> '${trace}'; done\n`,
  )
  await chmod(hook, 0o755)
  if (recover)
    await writeFile(
      join(source, '.git/hooks/pre-push'),
      `#!/bin/sh\ncat >/dev/null\ntouch '${started}'\nwhile [ ! -f '${gate}' ]; do sleep 0.02; done\n`,
      { mode: 0o755 },
    )
  const command = `sha=$(git rev-parse HEAD); if test ! -f red.txt; then printf 'check PASS %s\\n' "$sha" >> '${trace}'; else printf 'check FAIL %s\\n' "$sha" >> '${trace}'; echo RED_MEMBER; exit 1; fi`
  const prepared = await prepareHarness({
    projectRoot: source,
    ultimateRoot: source,
    home: join(directory, 'state'),
    userHome: directory,
    faux: fauxProvider(),
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const events = eventLog(
    () => opened.harness,
    (_call, work) => work(),
  )
  const task = createLander(
    {
      home: prepared.home,
      ultimateRoot: source,
      harness: () => opened.harness,
      projectSettings: async () => ({ lander: { batch: 3, checks: [command], push: 'origin' } }),
      metadata: Metadata,
      doc: () => undefined,
      notice: (text) => {
        throw new Error(text)
      },
      emit: events.emit,
    },
    Workspaces,
    (_source, operation) => operation(),
    {
      starter: async () => undefined,
      working: async () => true,
      conclude: async () => {},
      reserveLanding: async () => {},
      retireLanding: async () => {},
      submitLanding: async (tx, to, input) => {
        await to.submit(tx, input)
      },
      release: async () => [],
    },
  )
  prepared.registry.install(defineExtension({ name: 'batch-test', tasks: [task] }))
  opened = await prepared.open()
  cleanup.push(() => opened.close())
  const at = await opened.harness.commit(
    (tx) => tx.appendEntry(opened.root.id, { kind: 'test.branch-point', data: {} }),
    context,
  )
  const submissions: { id: ConversationId; tip: string; path: string }[] = []
  for (const name of ['one', 'red', 'two']) {
    const branch = await opened.root.fork(at.id, { ownership: { kind: 'ownerless' } }, context)
    const path = join(directory, name)
    await git(source, 'worktree', 'add', '--detach', path, base)
    const file =
      name === 'red' && conflicting ? 'base.txt' : `${recover ? 'green-' : ''}${name}.txt`
    await writeFile(join(path, file), `${name}\n`)
    await git(path, 'add', '.')
    await git(path, 'commit', '-m', `${name} change`)
    submissions.push({ id: branch.id, tip: await git(path, 'rev-parse', 'HEAD'), path })
  }
  const before = await git(source, 'rev-parse', 'main')
  await opened.harness.commit(async (tx) => {
    const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
    for (const entry of submissions) {
      index.items[String(entry.id)] = {
        source,
        target: 'main',
        base,
        branch: `submission-${entry.id}`,
        path: entry.path,
        state: 'ready',
      }
      index.queue.push({
        id: String(entry.id),
        conversationId: entry.id,
        source,
        target: 'main',
        tip: entry.tip,
        at: at.id,
        divergence: 'None',
        state: 'queued',
        steps: [],
      })
    }
    index.landers[source] = await tx.createTask(
      task,
      { source },
      { conversationId: opened.root.id, ownership: { kind: 'conversation' } },
    )
  }, context)
  let interrupted: { landings: unknown[]; union: string; remote: string } | undefined
  if (recover) {
    await until(() =>
      access(started).then(
        () => true,
        () => false,
      ),
    )
    const index = (await opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
    const union = await git(source, 'rev-parse', 'main')
    const first = index.landers[source]
    await opened.harness.abortTask(first, context)
    await until(
      async () =>
        (await opened.harness.commit((tx) => tx.task(first), context))!.state.status === 'terminal',
    )
    interrupted = {
      landings: index.queue.map((entry) => entry.landed),
      union,
      remote: await git(bare, 'rev-parse', 'main'),
    }
    if (rewind) await git(source, 'reset', '--hard', '-q', before)
    await writeFile(gate, '')
    await opened.harness.commit(async (tx) => {
      const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
      draft.landers[source] = await tx.createTask(
        task,
        { source },
        { conversationId: opened.root.id, ownership: { kind: 'conversation' } },
      )
    }, context)
  }
  await until(async () => {
    const index = await opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
    return index?.queue.length === 0 && Object.keys(index.landers).length === 0
  })
  const index = (await opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
  const records = (await readFile(trace, 'utf8')).trim().split('\n')
  const pushed: string[] = []
  for (const [position, record] of records.entries()) {
    if (!record.startsWith('push ')) continue
    const sha = record.slice(5)
    expect(records.slice(0, position)).toContain(`check PASS ${sha}`)
    expect(records).not.toContain(`check FAIL ${sha}`)
    pushed.push(sha)
  }
  expect(pushed.length).toBeGreaterThan(0)
  expect(await git(bare, 'rev-parse', 'main')).toBe(pushed.at(-1))
  expect(await git(source, 'rev-parse', 'main')).toBe(pushed.at(-1))
  for (const entry of recover ? submissions : [submissions[0], submissions[2]]) {
    expect(index.results[String(entry.id)]).toMatchObject({
      outcome: 'landed',
      pushed: 'origin/main',
    })
    expect(await contains(bare, entry.tip, 'main')).toBe(true)
  }
  const red = index.results[String(submissions[1].id)]
  expect(red.outcome).toBe(recover ? 'landed' : 'failed')
  expect(
    await git(bare, 'merge-base', '--is-ancestor', submissions[1].tip, 'main').then(
      () => true,
      () => false,
    ),
  ).toBe(recover)
  expect(await git(bare, 'merge-base', '--is-ancestor', before, 'main')).toBe('')
  return { red, pushed, records, index, submissions, before, bare, command, interrupted }
}

it('retries a red union singly, refuses only the red member and pushes only exact checked results', async () => {
  const f = await fixture(false)
  expect(f.red.reason).toBe(`check failed twice: ${f.command}`)
  expect(f.red.output).toContain('RED_MEMBER')
  expect(f.pushed).toHaveLength(2)
  const failed = f.records.filter((line) => line.startsWith('check FAIL '))
  expect(failed).toHaveLength(4)
  expect(new Set(failed).size).toBe(2)
  for (const entry of f.submissions)
    expect(f.index.results[String(entry.id)].steps).toContainEqual(
      expect.objectContaining({ step: 'falling back to single submissions' }),
    )
})

it('refuses a conflicting member and pushes the green survivors as one checked union', async () => {
  const f = await fixture(true)
  expect(f.red.reason).toBe('it conflicts with main in')
  expect(f.red.output).toContain('base.txt')
  expect(f.pushed).toHaveLength(1)
  expect(f.records).toEqual([`check PASS ${f.pushed[0]}`, `push ${f.pushed[0]}`])
  expect(await git(f.bare, 'rev-list', '--count', '--merges', `${f.before}..main`)).toBe('2')
})

it('replaces an interrupted batch task without pushing any unchecked prefix', async () => {
  const f = await fixture(false, true)
  expect(f.interrupted!.remote).toBe(f.before)
  expect(f.interrupted!.landings).toHaveLength(3)
  for (const landed of f.interrupted!.landings)
    expect(landed).toMatchObject({ pushSha: f.interrupted!.union })
  expect(f.pushed).toHaveLength(1)
  expect(f.records).toEqual([`check PASS ${f.pushed[0]}`, `push ${f.pushed[0]}`])
  expect(await git(f.bare, 'rev-list', '--count', '--merges', `${f.before}..main`)).toBe('3')
})

it('lands each member again when its interrupted batch push was rewound off the target', async () => {
  const f = await fixture(false, true, true)
  expect(f.interrupted!.remote).toBe(f.before)
  for (const landed of f.interrupted!.landings)
    expect(landed).toMatchObject({ pushSha: f.interrupted!.union })
  expect(f.pushed).toHaveLength(3)
  expect(f.pushed).not.toContain(f.interrupted!.union)
})
