import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskGraph } from '@earendil-works/pi-durable'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import { copyJson } from '@earendil-works/chord/json'
import { expect, it, vi } from 'vitest'
import { createApi, Events } from '../server/api.ts'
import { parseConversationId, parseTaskId } from '../lib/ids.ts'

it('reads only the latest task snapshot once when its broadcast window closes', async () => {
  vi.useFakeTimers()
  const home = await mkdtemp(join(tmpdir(), 'api-task-snapshot-'))
  let graph: TaskGraph = { tasks: {} }
  let advance!: (call: { kind: 'value'; readonly value: TaskGraph; ops: readonly Op[] }) => void
  const harness = {
    observeTaskGraph: async (observer: { advance: typeof advance }) => {
      advance = observer.advance
      return { value: graph, detach() {} }
    },
    observeCommits: () => ({ detach() {} }),
    commit: async (fn: (tx: unknown) => unknown) =>
      fn({ scanConversations: async () => ({ items: [] }) }),
  }
  const events = new Events()
  let replica = graph
  events.listeners.add((name, data) => {
    if (name === 'tasksOps') replica = applyImmutable(replica, (data as { ops: Op[] }).ops)
  })
  const api = await createApi(
    { home } as Parameters<typeof createApi>[0],
    { harness, root: { id: 1 } } as unknown as Parameters<typeof createApi>[1],
    events,
    {} as Parameters<typeof createApi>[3],
    {} as Parameters<typeof createApi>[4],
    {} as Parameters<typeof createApi>[5],
  )
  let reads = 0
  try {
    for (let i = 1; i <= 12; i++) {
      const revision: TaskGraph = {
        tasks: {
          [i]: {
            id: parseTaskId(i),
            kind: 'sample',
            conversationId: parseConversationId(1),
            background: true,
            abortRequested: false,
            state: { status: 'running', phase: String(i) },
            conversations: [],
          },
        },
      }
      graph = revision
      advance({
        kind: 'value',
        get value() {
          reads++
          return revision
        },
        ops: [['r', copyJson(revision)]],
      })
    }
    expect(reads).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads).toBe(1)
    expect(replica).toEqual(graph)
  } finally {
    await api.close()
    vi.useRealTimers()
    await rm(home, { recursive: true, force: true })
  }
})
