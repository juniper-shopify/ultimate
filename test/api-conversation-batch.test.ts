import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { TaskGraph } from '@earendil-works/pi-durable'
import { copyJson } from '@earendil-works/chord/json'
import type { Op } from '@earendil-works/chord/delta'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApi, Events } from '../server/api.ts'
import type { ConversationSummary } from '../shared/protocol.ts'
import { createStore } from '../web/src/sdk/store.ts'
import { FakeSource } from './web/fake-source.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'api-conversation-batch-'))
  const titles = new Map([
    [1, 'first'],
    [2, 'second'],
  ])
  const cwds = new Map<number, string>()
  let server: ReturnType<typeof createServer> | undefined
  const clients: { close: () => Promise<void> }[] = []
  const state: { block?: Promise<void>; reads: number } = { reads: 0 }
  let commit!: (publication: { changes: unknown[] }) => void
  let graphChanged!: (call: { kind: 'value'; value: TaskGraph; ops: readonly Op[] }) => void
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
    conversation: async (id: number) => ({
      agent: async () => ({ cwd: cwds.get(id) ?? '/project' }),
    }),
    watchDoc: async () => ({ value: {}, start() {}, stop: async () => {} }),
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
    if (name === 'conversationsUpsert') {
      const next = new Map(lists.at(-1)!.map((row) => [row.id, row]))
      for (const row of data as ConversationSummary[]) next.set(row.id, row)
      lists.push([...next.values()])
    }
  })
  const api = await createApi(
    { home } as Parameters<typeof createApi>[0],
    { harness, root: { id: 1 } } as unknown as Parameters<typeof createApi>[1],
    events,
    {
      current: () => ({
        process: { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}` },
      }),
    } as Parameters<typeof createApi>[3],
    {} as Parameters<typeof createApi>[4],
    { rules: new Set() } as Parameters<typeof createApi>[5],
  )
  return {
    api,
    titles,
    cwds,
    state,
    lists,
    change: (id: number) =>
      commit({
        changes: [{ type: 'document', conversationId: id, record: { kind: 'ultimate.metadata' } }],
      }),
    cwdChanged: (id: number) =>
      commit({
        changes: [
          {
            type: 'document',
            conversationId: id,
            record: { kind: 'pi.agent' },
            ops: [['s', ['cwd'], cwds.get(id)]],
          },
        ],
      }),
    graphChanged: (value: TaskGraph) =>
      graphChanged({ kind: 'value', value, ops: [['r', copyJson(value)]] }),
    connect: async () => {
      if (!server) {
        server = createServer((request, response) => void api.handle(request, response))
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      }
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const response = await fetch(url + '/api/events')
      const reader = response.body!.getReader()
      const source = new FakeSource(url)
      const store = createStore({
        eventSource: () => source,
        fetch: async () => Response.json({}),
      })
      store.start()
      source.open()
      let buffer = ''
      const client = {
        store,
        next: async () => {
          while (true) {
            const index = buffer.indexOf('\n\n')
            if (index >= 0) {
              const frame = buffer.slice(0, index)
              buffer = buffer.slice(index + 2)
              const name = /^event: (.+)$/m.exec(frame)?.[1]
              if (name !== 'conversations' && name !== 'conversationsUpsert') continue
              const rows = JSON.parse(/^data: (.+)$/m.exec(frame)![1]) as ConversationSummary[]
              source.send(name, rows)
              return { name, rows }
            }
            const chunk = await reader.read()
            if (chunk.done) throw new Error('Conversation stream ended')
            buffer += new TextDecoder().decode(chunk.value)
          }
        },
        close: async () => {
          store.stop()
          await reader.cancel()
        },
      }
      clients.push(client)
      return client
    },
    close: async () => {
      for (const client of clients) await client.close()
      await api.close()
      server?.closeAllConnections()
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
      await rm(home, { recursive: true, force: true })
    },
  }
}

it('materializes changed rows from both publishers in server order and resets on reconnect', async () => {
  const f = await fixture()
  try {
    const client = await f.connect()
    expect((await client.next()).name).toBe('conversations')
    expect(client.store.getState().conversations).toEqual(f.api.conversations())
    const untouched = client.store.getState().conversations[0]
    f.titles.set(2, 'Updated metadata')
    f.cwds.set(2, '/project/next')
    f.change(2)
    f.graphChanged({
      tasks: { 10: { conversationId: 2, background: false } as TaskGraph['tasks'][string] },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(await client.next()).toMatchObject({
      name: 'conversationsUpsert',
      rows: [{ id: 2, title: 'Updated metadata', cwd: '/project/next', busy: true }],
    })
    expect(client.store.getState().conversations).toEqual(f.api.conversations())
    expect(client.store.getState().conversations[0]).toBe(untouched)
    f.cwds.set(2, '/project/final')
    f.cwdChanged(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(await client.next()).toMatchObject({
      name: 'conversationsUpsert',
      rows: [{ id: 2, cwd: '/project/final', busy: true }],
    })
    f.titles.set(3, 'New conversation')
    f.change(3)
    f.graphChanged({ tasks: {} })
    await vi.advanceTimersByTimeAsync(100)
    expect(await client.next()).toMatchObject({
      name: 'conversationsUpsert',
      rows: [{ id: 3, title: 'New conversation' }],
    })
    await vi.advanceTimersByTimeAsync(800)
    expect(await client.next()).toMatchObject({
      name: 'conversationsUpsert',
      rows: [{ id: 2, busy: false }],
    })
    expect(client.store.getState().conversations).toEqual(f.api.conversations())
    expect(client.store.getState().conversations.map((row) => row.id)).toEqual([1, 2, 3])
    expect(client.store.getState().conversations[0]).toBe(untouched)
    await client.close()
    const reconnected = await f.connect()
    expect((await reconnected.next()).name).toBe('conversations')
    expect(reconnected.store.getState().conversations).toEqual(f.api.conversations())
  } finally {
    await f.close()
  }
})

it('delivers a reverted row to a client that connected between the two changes', async () => {
  const f = await fixture()
  try {
    f.titles.set(1, 'Transient title')
    f.change(1)
    await vi.advanceTimersByTimeAsync(0)
    const client = await f.connect()
    expect((await client.next()).rows[0].title).toBe('Transient title')
    f.titles.set(1, 'first')
    f.change(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(await client.next()).toMatchObject({
      name: 'conversationsUpsert',
      rows: [{ id: 1, title: 'first' }],
    })
    expect(client.store.getState().conversations).toEqual(f.api.conversations())
  } finally {
    await f.close()
  }
})

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
