import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskGraph } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { createApi, Events } from '../server/api.ts'

it('keeps initial and broadcast busy flags equal to the foreground-task scan', async () => {
  vi.useFakeTimers()
  const home = await mkdtemp(join(tmpdir(), 'api-busy-'))
  let graph: TaskGraph
  const ids = [1, 2, 3, 4]
  const makeTask = (id: number, conversationId: number, background: boolean) =>
    ({ id, conversationId, background }) as TaskGraph['tasks'][string]
  graph = {
    tasks: {
      10: makeTask(10, 1, false),
      11: makeTask(11, 1, true),
      12: makeTask(12, 2, true),
      13: makeTask(13, 3, false),
      14: makeTask(14, 3, false),
      15: makeTask(15, 99, false),
    },
  }
  let advance!: (call: { kind: 'value'; value: TaskGraph }) => void
  const harness = {
    observeTaskGraph: async (observer: { advance: typeof advance }) => {
      advance = observer.advance
      return { value: graph, detach() {} }
    },
    observeCommits: () => ({ detach() {} }),
    commit: async (fn: (tx: unknown) => unknown) =>
      fn({ scanConversations: async () => ({ items: ids.map((id) => ({ id })) }) }),
    conversation: async () => ({ agent: async () => ({ cwd: '/project' }) }),
    snapshot: async () => undefined,
  }
  const events = new Events()
  const lists: unknown[] = []
  events.listeners.add((name, data) => {
    if (name === 'conversations') lists.push(data)
  })
  const api = await createApi(
    { home } as Parameters<typeof createApi>[0],
    { harness, root: { id: 1 } } as unknown as Parameters<typeof createApi>[1],
    events,
    {} as Parameters<typeof createApi>[3],
    {} as Parameters<typeof createApi>[4],
    {} as Parameters<typeof createApi>[5],
  )
  const expected = () =>
    ids.map((id) => ({
      id,
      cwd: '/project',
      busy: Object.values(graph.tasks).some(
        (task) => task.conversationId === id && !task.background,
      ),
    }))
  try {
    expect(lists).toEqual([expected()])
    graph = { tasks: { 12: makeTask(12, 2, false) } }
    advance({ kind: 'value', value: graph })
    await vi.runAllTimersAsync()
    expect(lists).toHaveLength(2)
    expect(lists.at(-1)).toEqual(expected())
    graph = { tasks: {} }
    advance({ kind: 'value', value: graph })
    await vi.runAllTimersAsync()
    expect(lists.at(-1)).toEqual(expected())
  } finally {
    await api.close()
    vi.useRealTimers()
    await rm(home, { recursive: true, force: true })
  }
})
