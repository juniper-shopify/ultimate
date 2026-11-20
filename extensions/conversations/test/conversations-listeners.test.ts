import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { createRegistry, Harness, LiveDoc, MemoryStorage } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { parseTaskId } from '../../../lib/ids.ts'
import { until } from '../../../test/helpers.ts'
import { Overview, overviewBehavior } from '../overview.ts'
import { Summaries } from '../summary.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function fixture() {
  const storage = new MemoryStorage()
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  )
  const root = await harness.root(context)
  await harness.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, root.id)
    live.run = { taskId: parseTaskId(1000), inputs: [], turns: 0 }
  }, context)
  const scanSubmissions = vi.fn<typeof storage.scanSubmissions>(
    storage.scanSubmissions.bind(storage),
  )
  const notices: string[] = []
  let open!: () => Promise<void>
  let close!: () => Promise<void>
  overviewBehavior({
    harness: () => harness,
    scanSubmissions,
    onOpen: (callback) => {
      open = callback
    },
    onClose: (callback) => {
      close = callback
    },
    notice: (message) => {
      notices.push(message)
    },
  })
  await open()
  scanSubmissions.mockClear()
  cleanups.push(async () => {
    await close()
    await harness.close(context)
    expect(notices).toEqual([])
  })
  const row = async () =>
    (await harness.snapshot(Overview, root.id, context))?.conversations[root.id]
  const nextTurn = () =>
    harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, root.id)
      live.run!.turns++
    }, context)
  return { harness, root, row, nextTurn, scanSubmissions, notices }
}

it('does not re-read overview sources for progress or summary bookkeeping that leaves the row unchanged', async () => {
  const f = await fixture()
  await f.nextTurn()
  await f.harness.commit(async (tx) => {
    const summaries = await tx.doc(Summaries, f.root.id)
    summaries.automatic = false
  }, context)
  expect(await f.row()).toEqual({ runState: 'working' })
  expect(f.scanSubmissions).not.toHaveBeenCalled()
})

it('keeps other rows remembered and re-derives a real run change while that memory is present', async () => {
  const f = await fixture()
  const other = await f.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  await until(
    async () =>
      (await f.harness.snapshot(Overview, f.root.id, context))?.conversations[other.id]
        ?.runState === 'idle',
  )
  f.scanSubmissions.mockClear()
  await f.nextTurn()
  expect(await f.row()).toEqual({ runState: 'working' })
  expect(f.scanSubmissions).not.toHaveBeenCalled()
  await f.harness.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, f.root.id)
    delete live.run
  }, context)
  await until(async () => (await f.row())?.runState === 'idle')
  expect(f.scanSubmissions).toHaveBeenCalledTimes(1)
})

it('retries a failed overview repair on the next original trigger even when its run state is unchanged', async () => {
  const f = await fixture()
  f.scanSubmissions.mockRejectedValueOnce(new Error('Injected overview read failure'))
  await f.harness.commit(async (tx) => {
    const summaries = await tx.doc(Summaries, f.root.id)
    summaries.summary = 'New summary'
  }, context)
  await until(() => f.notices.length === 1)
  expect(f.notices.splice(0)).toEqual([
    'Conversation overview: Error: Injected overview read failure',
  ])
  expect(await f.row()).toEqual({ runState: 'working' })
  await f.nextTurn()
  await until(async () => (await f.row())?.summary === 'New summary')
  expect(await f.row()).toEqual({ runState: 'working', summary: 'New summary' })
  expect(f.scanSubmissions).toHaveBeenCalledTimes(2)
})
