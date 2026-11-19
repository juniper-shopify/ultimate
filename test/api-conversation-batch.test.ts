import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskGraph } from '@earendil-works/pi-durable'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApi, Events } from '../server/api.ts'
import type { ConversationSummary } from '../shared/protocol.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'api-conversation-batch-'))
  const titles = new Map([
    [1, 'first'],
    [2, 'second'],
  ])
  const state: { block?: Promise<void>; reads: number } = { reads: 0 }
  let commit!: (publication: { changes: unknown[] }) => void
  let graphChanged!: (call: { kind: 'value'; value: TaskGraph }) => void
  const harness = {
    observeTaskGraph: async (observer: { advance: typeof graphChanged }) => {
      graphChanged = observer.advance
      return { value: { tasks: {} }, detach() {} }
    },
    observeCommits: (observer: { advance: typeof commit }) => {
      commit = observer.advance
      return { detach() {} }
    },
    commit: async (fn: (tx: unknown) => unknown) =>
      fn({
        scanConversations: async () => ({ items: [...titles.keys()].map((id) => ({ id })) }),
        conversation: async (id: number) => ({ id }),
      }),
    conversation: async () => ({ agent: async () => ({ cwd: '/project' }) }),
    snapshot: async (_doc: unknown, id: number) => {
      const title = titles.get(id)
      state.reads++
      await state.block
      return { title }
    },
  }
  const events = new Events()
  const lists: ConversationSummary[][] = []
  events.listeners.add((name, data) => {
    if (name === 'conversations') lists.push(data as ConversationSummary[])
  })
  const api = await createApi(
    { home } as Parameters<typeof createApi>[0],
    { harness, root: { id: 1 } } as unknown as Parameters<typeof createApi>[1],
    events,
    {} as Parameters<typeof createApi>[3],
    {} as Parameters<typeof createApi>[4],
    {} as Parameters<typeof createApi>[5],
  )
  return {
    api,
    titles,
    state,
    lists,
    change: (id: number) =>
      commit({
        changes: [{ type: 'document', conversationId: id, record: { kind: 'ultimate.metadata' } }],
      }),
    graphChanged: (value: TaskGraph) => graphChanged({ kind: 'value', value }),
    close: async () => {
      await api.close()
      await rm(home, { recursive: true, force: true })
    },
  }
}

it('refreshes the server cache immediately and broadcasts the latest list once per fixed window', async () => {
  const f = await fixture()
  try {
    expect(f.lists).toHaveLength(1)
    for (let i = 0; i < 50; i++) {
      f.titles.set(1, `first-${i}`)
      f.change(1)
    }
    await vi.advanceTimersByTimeAsync(99)
    expect(f.api.conversations()[0].title).toBe('first-49')
    expect(f.lists).toHaveLength(1)
    f.titles.set(2, 'latest second')
    f.change(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.api.conversations()[1].title).toBe('latest second')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.lists).toHaveLength(2)
    expect(f.lists.at(-1)?.map((row) => row.title)).toEqual(['first-49', 'latest second'])
  } finally {
    await f.close()
  }
})

it('retains commits arriving during an awaited refresh and coalesces their broadcasts', async () => {
  const f = await fixture()
  let release!: () => void
  try {
    f.state.block = new Promise<void>((resolve) => (release = resolve))
    f.titles.set(1, 'before await')
    f.change(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.state.reads).toBe(3)
    f.titles.set(1, 'during await')
    f.change(1)
    f.titles.set(2, 'also during await')
    f.change(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.lists).toHaveLength(1)
    f.state.block = undefined
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.api.conversations().map((row) => row.title)).toEqual([
      'during await',
      'also during await',
    ])
    expect(f.lists).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(99)
    expect(f.lists).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.lists).toHaveLength(2)
    expect(f.lists.at(-1)?.map((row) => row.title)).toEqual(['during await', 'also during await'])
  } finally {
    release?.()
    await f.close()
  }
})

it('routes graph busy changes through the same list batch and cancels pending work on close', async () => {
  const f = await fixture()
  try {
    f.graphChanged({
      tasks: { 10: { conversationId: 1, background: false } as TaskGraph['tasks'][string] },
    })
    await vi.advanceTimersToNextTimerAsync()
    expect(f.lists).toHaveLength(1)
    expect(f.api.conversations()[0].busy).toBe(true)
    f.titles.set(1, 'renamed while busy')
    f.change(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.lists).toHaveLength(2)
    expect(f.lists.at(-1)?.[0]).toMatchObject({ title: 'renamed while busy', busy: true })
    f.change(2)
    await f.api.close()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.lists).toHaveLength(2)
  } finally {
    await f.close()
  }
})
