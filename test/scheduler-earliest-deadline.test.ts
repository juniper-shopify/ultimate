import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { createRegistry, defineTask, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import type { TaskId } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { until } from './helpers.ts'

// Pi upstream: @earendil-works/pi-durable@1.5.2 dist/harness/scheduler.js — skip sleeping scans while the cached earliest deadline is in the future. Drop with the matching pnpm patch when Pi indexes sleeping deadlines.
const harnesses = new Set<Harness>()
afterEach(async () => {
  for (const harness of harnesses) await harness.close(context)
  harnesses.clear()
})

async function fixture() {
  let time = 1_000
  const now = vi.fn<() => number>(() => time)
  const events: string[] = []
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const registry = createRegistry()
  const sleeper = defineTask<{ label: string; until: number }, { phase: 'park' | 'wake' }, null>({
    name: 'test.sleeper',
    version: 1,
    initial: () => ({ phase: 'park' }),
    phases: {
      park: (task, runtime, caller) =>
        runtime.sleepUntil(task.input.until, { phase: 'wake' }, caller),
      wake: async (task, runtime, caller) => {
        events.push(`wake:${task.input.label}`)
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          caller,
        )
      },
    },
    abort: async (task, runtime, caller) => {
      events.push(`abort:${task.input.label}`)
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller)
    },
  })
  registry.install({ name: 'sleepers', tasks: [sleeper] })
  const open = async () => {
    const harness = await Harness.open(
      storage,
      { registry, models: createModels(), now, onWake: () => {} },
      context,
    )
    harnesses.add(harness)
    return harness
  }
  let harness = await open()
  const conversation = await harness.root(context)
  const sleeping = async (label: string, at: number) => {
    const id = await harness.commit(
      (tx) =>
        tx.createTask(
          sleeper,
          { label, until: at },
          { conversationId: conversation.id, ownership: { kind: 'conversation' } },
        ),
      context,
    )
    harness.resume()
    await until(async () => (await harness.getTask(id, context))?.state.status === 'sleeping')
    await until(() => !harness.wake().active)
    return id
  }
  return {
    get harness() {
      return harness
    },
    now,
    events,
    sleeping,
    time: (at: number) => {
      time = at
    },
    settled: async (ids: TaskId[]) => {
      await Promise.all(ids.map((id) => harness.waitForTask(id, context)))
      await until(() => !harness.wake().active)
    },
    reopen: async () => {
      await harness.close(context)
      harnesses.delete(harness)
      harness = await open()
      await until(() => !harness.wake().active)
    },
  }
}

it('skips unchanged future sleeps and wakes equal deadlines in their original order', async () => {
  const subject = await fixture()
  const ids: TaskId[] = []
  for (let i = 0; i < 64; i++) ids.push(await subject.sleeping(String(i), 10_000))
  expect(subject.harness.wake()).toEqual({ active: false, at: 10_000 })
  subject.now.mockClear()
  for (let i = 0; i < 100; i++) {
    subject.harness.resume()
    subject.harness.wake()
  }
  expect(subject.now.mock.calls.length).toBeLessThan(300)
  subject.time(9_999)
  subject.harness.resume()
  await until(() => !subject.harness.wake().active)
  expect(subject.events).toEqual([])
  subject.time(10_000)
  subject.harness.resume()
  await subject.settled(ids)
  expect(subject.events).toEqual(ids.map((_, i) => `wake:${i}`))
  expect(subject.harness.wake()).toEqual({ active: false })
})

it('updates the minimum for earlier sleeps and cancellation, and restores it across clock jumps and reopen', async () => {
  const subject = await fixture()
  const later = await subject.sleeping('later', 10_000)
  const earlier = await subject.sleeping('earlier', 5_000)
  expect(subject.harness.wake()).toEqual({ active: false, at: 5_000 })
  await subject.harness.abortTask(earlier, context)
  await subject.settled([earlier])
  expect(subject.events).toEqual(['abort:earlier'])
  expect(subject.harness.wake()).toEqual({ active: false, at: 10_000 })
  await subject.reopen()
  expect(subject.harness.wake()).toEqual({ active: false, at: 10_000 })
  subject.time(12_000)
  expect(subject.harness.wake()).toEqual({ active: true })
  subject.time(500)
  expect(subject.harness.wake()).toEqual({ active: false, at: 10_000 })
  subject.time(10_000)
  subject.harness.resume()
  await subject.settled([later])
  expect(subject.events).toEqual(['abort:earlier', 'wake:later'])
})
