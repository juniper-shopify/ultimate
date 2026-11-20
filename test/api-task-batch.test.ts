import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskGraph } from '@earendil-works/pi-durable'
import { copyJson } from '@earendil-works/chord/json'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import type { ServerEvents } from '../shared/protocol.ts'
import { expect, it, vi } from 'vitest'
import { createApi, Events } from '../server/api.ts'

it('broadcasts the latest task graph once per fixed second under continuous changes', async () => {
  vi.useFakeTimers()
  const home = await mkdtemp(join(tmpdir(), 'api-task-batch-'))
  let advance!: (call: { kind: 'value'; value: TaskGraph; ops: readonly Op[] }) => void
  const harness = {
    observeTaskGraph: async (observer: { advance: typeof advance }) => {
      advance = observer.advance
      return { value: { tasks: {} }, detach() {} }
    },
    observeCommits: () => ({ detach() {} }),
    commit: async (fn: (tx: unknown) => unknown) =>
      fn({ scanConversations: async () => ({ items: [] }) }),
  }
  const events = new Events()
  const graphs: TaskGraph[] = []
  let replica: TaskGraph = { tasks: {} }
  events.listeners.add((name, data) => {
    if (name === 'tasks') {
      replica = data as TaskGraph
      graphs.push(replica)
    }
    if (name === 'tasksOps') {
      replica = applyImmutable(replica, (data as ServerEvents['tasksOps']).ops)
      graphs.push(replica)
    }
  })
  const api = await createApi(
    { home } as Parameters<typeof createApi>[0],
    { harness, root: { id: 1 } } as unknown as Parameters<typeof createApi>[1],
    events,
    {} as Parameters<typeof createApi>[3],
    {} as Parameters<typeof createApi>[4],
    {} as Parameters<typeof createApi>[5],
  )
  const graphAt = (phase: number): TaskGraph => ({
    tasks: { 10: { conversationId: 1, state: { phase } } as unknown as TaskGraph['tasks'][string] },
  })
  try {
    for (let i = 0; i < 10; i++) {
      const value = graphAt(i)
      advance({ kind: 'value', value, ops: [['r', copyJson(value)]] })
      await vi.advanceTimersByTimeAsync(99)
      expect(graphs).toHaveLength(0)
    }
    const latest = graphAt(10)
    advance({ kind: 'value', value: latest, ops: [['r', copyJson(latest)]] })
    await vi.advanceTimersByTimeAsync(10)
    expect(graphs).toEqual([latest])
    const final = { tasks: {} }
    advance({ kind: 'value', value: final, ops: [['r', copyJson(final)]] })
    await vi.advanceTimersByTimeAsync(999)
    expect(graphs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(graphs).toEqual([latest, final])
  } finally {
    await api.close()
    vi.useRealTimers()
    await rm(home, { recursive: true, force: true })
  }
})
