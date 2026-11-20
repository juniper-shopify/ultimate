import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineDoc, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { until } from '../../../test/helpers.ts'
import { activityBehavior } from '../activity.ts'
import { ContextUsageDoc } from '../api.ts'
import { BackfillDoc } from '../backfill.ts'
import { contextBehavior } from '../context.ts'

const Metadata = defineDoc({
  kind: 'test.backfill-metadata',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: (): { inputTitle?: string; inputAt?: number; answerAt?: number } => ({}),
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0)) await close()
})

async function fixture() {
  const models = createModels()
  models.setProvider(fauxProvider({ models: [{ id: 'small', contextWindow: 10000 }] }).provider)
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    context,
  )
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'small' } },
  })
  const answer = fauxAssistantMessage('Answer')
  answer.timestamp = 2
  answer.usage.input = 100
  await harness.commit(async (tx) => {
    await tx.appendEntry(root.id, {
      kind: 'pi.user',
      model: [{ role: 'user', content: 'Initial input', timestamp: 1 }],
    })
    await tx.appendEntry(root.id, { kind: 'pi.assistant', model: [answer] })
  }, context)
  const opens: (() => Promise<void>)[] = []
  const closes: (() => Promise<void>)[] = []
  const notices: string[] = []
  const host = {
    harness: () => harness,
    metadata: Metadata,
    modelRuntime: models,
    onOpen: (callback: () => Promise<void>) => {
      opens.push(callback)
    },
    onClose: (callback: () => Promise<void>) => {
      closes.push(callback)
    },
    notice: (message: string) => {
      notices.push(message)
    },
  }
  contextBehavior(host)
  activityBehavior(host)
  const open = async () => {
    for (const callback of opens) await callback()
    await until(async () => !!(await harness.snapshot(BackfillDoc, root.id, context))?.context)
  }
  const close = async () => {
    for (const callback of closes) await callback()
  }
  cleanups.push(async () => {
    await close()
    await harness.close(context)
    expect(notices).toEqual([])
  })
  await open()
  await close()
  const reads = vi.spyOn(Object.getPrototypeOf(root), 'context')
  return { harness, root, open, close, reads, notices }
}

it('skips both full reads when reopening an unchanged conversation', async () => {
  const f = await fixture()
  const usage = await f.harness.snapshot(ContextUsageDoc, f.root.id, context)
  const metadata = await f.harness.snapshot(Metadata, f.root.id, context)
  await f.open()
  await f.close()
  expect(f.reads).not.toHaveBeenCalled()
  expect(await f.harness.snapshot(ContextUsageDoc, f.root.id, context)).toEqual(usage)
  expect(await f.harness.snapshot(Metadata, f.root.id, context)).toEqual(metadata)
})

it('keeps checkpoints current after an assistant fast path', async () => {
  const f = await fixture()
  await f.open()
  const answer = fauxAssistantMessage('Next answer')
  answer.timestamp = 5
  answer.usage.input = 700
  const entry = await f.harness.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: 'pi.assistant', model: [answer] }),
    context,
  )
  await until(
    async () =>
      (await f.harness.snapshot(ContextUsageDoc, f.root.id, context))?.entry === entry.id &&
      (await f.harness.snapshot(Metadata, f.root.id, context))?.answerAt === 5,
  )
  await f.close()
  expect(f.reads).not.toHaveBeenCalled()
  await f.open()
  await f.close()
  expect(f.reads).not.toHaveBeenCalled()
})

it('repairs input fields on reopen after a failed full repair followed by a fast answer', async () => {
  const f = await fixture()
  await f.open()
  f.reads.mockRejectedValueOnce(new Error('Injected activity read failure'))
  await f.harness.commit(
    (tx) =>
      tx.appendEntry(f.root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'New input', timestamp: 3 }],
      }),
    context,
  )
  await until(() => f.notices.length === 1)
  expect(f.notices.splice(0)).toEqual([
    'Conversation activity: Error: Injected activity read failure',
  ])
  const answer = fauxAssistantMessage('New answer')
  answer.timestamp = 4
  await f.harness.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: 'pi.assistant', model: [answer] }),
    context,
  )
  await until(async () => (await f.harness.snapshot(Metadata, f.root.id, context))?.answerAt === 4)
  await f.close()
  expect(await f.harness.snapshot(Metadata, f.root.id, context)).toEqual({
    inputTitle: 'Initial input',
    inputAt: 1,
    answerAt: 4,
  })
  await f.open()
  await f.close()
  expect(await f.harness.snapshot(Metadata, f.root.id, context)).toEqual({
    inputTitle: 'Initial input',
    inputAt: 3,
    answerAt: 4,
  })
})

it('does not create public metadata for an empty conversation during the currentness check', async () => {
  const f = await fixture()
  const empty = await f.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  await f.open()
  await until(async () => !!(await f.harness.snapshot(BackfillDoc, empty.id, context))?.context)
  await f.close()
  expect(await f.harness.snapshot(Metadata, empty.id, context)).toBeUndefined()
  f.reads.mockClear()
  await f.open()
  await f.close()
  expect(f.reads).not.toHaveBeenCalled()
  expect(await f.harness.snapshot(Metadata, empty.id, context)).toBeUndefined()
})

it('repairs input and usage committed while closed before skipping the next open', async () => {
  const f = await fixture()
  const answer = fauxAssistantMessage('New answer')
  answer.timestamp = 4
  answer.usage.input = 500
  const entry = await f.harness.commit(async (tx) => {
    await tx.appendEntry(f.root.id, {
      kind: 'pi.user',
      model: [{ role: 'user', content: 'New input', timestamp: 3 }],
    })
    return tx.appendEntry(f.root.id, { kind: 'pi.assistant', model: [answer] })
  }, context)
  await f.open()
  await f.close()
  expect(f.reads).toHaveBeenCalledTimes(2)
  expect(await f.harness.snapshot(ContextUsageDoc, f.root.id, context)).toMatchObject({
    entry: entry.id,
    tokens: 500,
    at: 4,
  })
  expect(await f.harness.snapshot(Metadata, f.root.id, context)).toEqual({
    inputTitle: 'Initial input',
    inputAt: 3,
    answerAt: 4,
  })
  f.reads.mockClear()
  await f.open()
  await f.close()
  expect(f.reads).not.toHaveBeenCalled()
})
