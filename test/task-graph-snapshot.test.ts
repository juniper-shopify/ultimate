import type { TaskGraph } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import { expect, it, vi } from 'vitest'
import { until } from './helpers.ts'
// Pi upstream: @earendil-works/pi-durable@1.5.2 dist/harness/task-graph.js — lazy immutable graph snapshots. Drop when Pi snapshots the graph on demand.
import { TaskGraphView } from '../node_modules/@earendil-works/pi-durable/dist/harness/task-graph.js'

it('keeps held and late-read task graph revisions immutable across every graph operation', async () => {
  let commit!: (publication: unknown, ctx: typeof context) => void
  let registryChanged!: () => void
  const blocked = new Map<number, NonNullable<TaskGraph['tasks'][string]['blocked']>>()
  const errors: unknown[] = []
  const session = {
    followCommits: (listener: typeof commit) => {
      commit = listener
    },
    subscribeClose: () => {},
    readOnLine: async (read: (storage: unknown) => unknown) =>
      read({ scanTasks: async () => ({ items: [] }) }),
    report: (error: unknown) => errors.push(error),
  }
  const view = new TaskGraphView(
    session as unknown as ConstructorParameters<typeof TaskGraphView>[0],
    {
      blocked: (record) => blocked.get(record.id),
      subscribeBlocked: (listener) => {
        registryChanged = listener
        return () => {}
      },
    },
  )
  const calls: { readonly value: TaskGraph; ops: readonly Op[] }[] = []
  const expected: TaskGraph[] = []
  let replica: TaskGraph = { tasks: {} }
  const observation = await view.observe(
    {
      advance: (call) => {
        if (call.kind !== 'value') return
        calls.push(call)
        replica = applyImmutable(replica, call.ops)
        expected.push(replica)
      },
      end: () => {},
    },
    context,
  )
  const task = (
    id: number,
    state: object = { status: 'pending', checkpoint: { phase: 'first' } },
  ) => ({
    type: 'task',
    value: {
      id,
      kind: 'sample',
      version: 1,
      conversationId: 1,
      background: false,
      abortRequested: false,
      state,
    },
  })
  const publish = (...changes: unknown[]) => commit({ kind: 'stored', changes }, context)
  const high = 2 ** 32
  publish(task(1), task(65), task(2), task(3), task(high + 65), task(high + 1))
  const held = calls[0].value
  publish(
    { type: 'conversation', value: { id: 100, owner: { taskId: 1 } } },
    { type: 'conversation', value: { id: 99, owner: { taskId: 1 } } },
  )
  publish(
    task(1, { status: 'waiting', checkpoint: { phase: 'join' }, on: [65], policy: 'allSettled' }),
  )
  blocked.set(65, 'missing_task')
  registryChanged()
  blocked.delete(65)
  registryChanged()
  const watch = await view.watch(context)
  watch.start(async () => {})
  publish(
    task(1, { status: 'terminal', outcome: { status: 'completed', result: null } }),
    task(65, { status: 'completing', outcome: { status: 'completed', result: null } }),
  )
  await until(() => watch.value.tasks[65]?.state.status === 'completing')
  const heldWatch = watch.value
  await watch.stop()
  publish(
    task(65, { status: 'terminal', outcome: { status: 'completed', result: null } }),
    task(2, { status: 'sleeping', checkpoint: { phase: 'later' }, until: 1000 }),
  )
  publish(
    task(high + 65, { status: 'terminal', outcome: { status: 'completed', result: null } }),
    task(high + 129),
    task(high + 65),
  )
  expect(calls).toHaveLength(8)
  for (let index = calls.length - 1; index >= 0; index--) {
    expect(calls[index].value).toEqual(expected[index])
    expect(Object.keys(calls[index].value.tasks)).toEqual(Object.keys(expected[index].tasks))
    expect(JSON.stringify(calls[index].value)).toBe(JSON.stringify(expected[index]))
    expect(calls[index].value).toBe(calls[index].value)
  }
  expect(heldWatch).toEqual(expected[5])
  expect(held.tasks[1].state).toEqual({ status: 'pending', phase: 'first' })
  expect(held.tasks[1].conversations).toEqual([])
  expect(expected[1].tasks[1].conversations).toEqual([99, 100])
  expect(calls.at(-1)!.value.tasks[3]).toBe(held.tasks[3])
  expect(Object.keys(calls.at(-1)!.value.tasks)).toEqual([
    '2',
    '3',
    String(high + 1),
    String(high + 129),
    String(high + 65),
  ])
  expect(errors).toEqual([])
  observation.detach()
})

it('does no flat-map work for operations-only publications and one copy per value read', async () => {
  const initial = Array.from({ length: 1600 }, (_, index) => ({
    id: 100000 + index * 641,
    kind: 'sample',
    version: 1,
    conversationId: 1,
    background: true,
    abortRequested: false,
    state: { status: 'pending', checkpoint: { phase: 'first' } },
  }))
  let commit!: (publication: unknown, ctx: typeof context) => void
  const session = {
    followCommits: (listener: typeof commit) => {
      commit = listener
    },
    subscribeClose: () => {},
    readOnLine: async (read: (storage: unknown) => unknown) =>
      read({
        scanTasks: async (query: { status: string }) => ({
          items: query.status === 'pending' ? initial : [],
        }),
        scanConversations: async () => ({ items: [] }),
      }),
    report: (error: unknown) => {
      throw error
    },
  }
  const view = new TaskGraphView(
    session as unknown as ConstructorParameters<typeof TaskGraphView>[0],
    {
      blocked: () => undefined,
      subscribeBlocked: () => () => {},
    },
  )
  let latest!: { readonly value: TaskGraph }
  const observation = await view.observe(
    {
      advance: (call) => {
        if (call.kind === 'value') latest = call
      },
      end: () => {},
    },
    context,
  )
  const definitions = vi.spyOn(Object, 'defineProperty')
  const maps = vi.spyOn(Object, 'fromEntries')
  const flatWork = () => {
    const copies = new Set<TaskGraph['tasks']>()
    for (const [, key, descriptor] of definitions.mock.calls) {
      const value = descriptor.value as TaskGraph['tasks'] | undefined
      if (key === 'tasks' && value?.[100000]?.kind === 'sample') copies.add(value)
    }
    for (const result of maps.mock.results) {
      const value = result.value as TaskGraph['tasks'] | undefined
      if (result.type === 'return' && value?.[100000]?.kind === 'sample') copies.add(value)
    }
    copies.delete(observation.value.tasks)
    return copies.size
  }
  let phase = 0
  const publish = () =>
    commit(
      {
        kind: 'stored',
        changes: [
          {
            type: 'task',
            value: {
              ...initial[0],
              state: { status: 'running', checkpoint: { phase: String(++phase) } },
            },
          },
        ],
      },
      context,
    )
  let reader: Awaited<ReturnType<typeof view.observe>> | undefined
  try {
    for (let index = 0; index < 12; index++) publish()
    expect(flatWork()).toBe(0)
    expect(latest.value.tasks[100000].state).toEqual({ status: 'running', phase: '12' })
    expect(flatWork()).toBe(1)
    for (let index = 0; index < 3; index++) publish()
    expect(flatWork()).toBe(1)
    expect(latest.value.tasks[100000].state).toEqual({ status: 'running', phase: '15' })
    expect(flatWork()).toBe(2)
    reader = await view.observe(
      {
        advance: (call) => {
          if (call.kind === 'value') void call.value
        },
        end: () => {},
      },
      context,
    )
    for (let index = 0; index < 3; index++) publish()
    expect(flatWork()).toBe(5)
    reader.detach()
    reader = undefined
    for (let index = 0; index < 4; index++) publish()
    expect(flatWork()).toBe(5)
    expect(latest.value.tasks[100000].state).toEqual({ status: 'running', phase: '22' })
    expect(flatWork()).toBe(6)
  } finally {
    definitions.mockRestore()
    maps.mockRestore()
    reader?.detach()
    observation.detach()
  }
})
