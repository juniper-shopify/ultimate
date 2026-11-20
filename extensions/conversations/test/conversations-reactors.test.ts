import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineDoc, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { activityBehavior } from '../activity.ts'
import { contextBehavior } from '../context.ts'
import { ContextUsageDoc } from '../api.ts'
import { contextUsage, lastAssistant, promptTokens } from '../../../lib/context-usage.ts'
import { isInput } from '../../../lib/entries.ts'
import { until } from '../../../test/helpers.ts'

const Metadata = defineDoc({
  checkpointWhen: () => false,
  kind: 'test.reactor-metadata',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: (): { inputTitle?: string; inputAt?: number; answerAt?: number } => ({}),
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0)) await close()
})

async function fixture() {
  const models = createModels()
  models.setProvider(fauxProvider({ models: [{ id: 'large', contextWindow: 1000000 }] }).provider)
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    context,
  )
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'large' } },
  })
  await harness.commit(async (tx) => {
    await tx.appendEntry(root.id, {
      kind: 'pi.user',
      model: [{ role: 'user', content: 'Inspect code', timestamp: 1 }],
    })
    for (let index = 0; index < 300; index++) {
      const message = fauxAssistantMessage('Inspect the next slice')
      message.timestamp = index + 2
      await tx.appendEntry(root.id, { kind: 'pi.assistant', model: [message] })
      await tx.appendEntry(root.id, {
        kind: 'pi.tool',
        model: [
          {
            role: 'toolResult',
            toolCallId: `call_${index}`,
            toolName: 'read',
            content: [{ type: 'text', text: 'code\n'.repeat(1000) }],
            isError: false,
            timestamp: index + 2,
          },
        ],
      })
    }
  }, context)
  const opens: (() => Promise<void>)[] = [],
    closes: (() => Promise<void>)[] = [],
    notices: string[] = []
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
  for (const open of opens) await open()
  const usage = () => harness.snapshot(ContextUsageDoc, root.id, context)
  const metadata = () => harness.snapshot(Metadata, root.id, context)
  await until(
    async () =>
      (await usage())?.entry !== undefined && (await metadata())?.inputTitle === 'Inspect code',
  )
  cleanups.push(async () => {
    for (const close of closes) await close()
    await harness.close(context)
    expect(notices).toEqual([])
  })
  const reads = vi.spyOn(Object.getPrototypeOf(root), 'context')
  return { harness, root, usage, metadata, reads }
}

it('does no full context read from either reactor on a plain assistant commit in a long conversation', async () => {
  const f = await fixture()
  const message = fauxAssistantMessage('Next tool')
  message.timestamp = 1000
  message.usage.input = 400000
  const entry = await f.harness.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: 'pi.assistant', model: [message] }),
    context,
  )
  await until(
    async () => (await f.usage())?.entry === entry.id && (await f.metadata())?.answerAt === 1000,
  )
  expect(f.reads).not.toHaveBeenCalled()
})

it('projects a plain tool loop exactly as the full context read, including error and aborted answers', async () => {
  const f = await fixture()
  for (const [index, stopReason] of ['toolUse', 'error', 'aborted', 'toolUse'].entries()) {
    const message = fauxAssistantMessage('Next tool')
    message.timestamp = 1000 + index
    message.stopReason = stopReason as typeof message.stopReason
    message.usage.input = 400000 + index
    const entry = await f.harness.commit(
      (tx) => tx.appendEntry(f.root.id, { kind: 'pi.assistant', model: [message] }),
      context,
    )
    await until(
      async () =>
        (await f.usage())?.entry === entry.id &&
        (await f.metadata())?.answerAt === message.timestamp,
    )
    expect(f.reads).not.toHaveBeenCalled()
    const view = await f.root.context(context)
    const source = lastAssistant(
      view.entries.filter((item) => item.conversationId === f.root.id),
    ).message!
    expect(await f.usage()).toEqual({
      ...contextUsage(
        { tokens: promptTokens(source.usage), window: 1000000, estimated: false },
        source.timestamp,
      ),
      entry: entry.id,
    })
    const input = view.entries.find(isInput)?.model?.[0]
    expect(await f.metadata()).toEqual({
      inputTitle: input?.role === 'user' ? input.content : undefined,
      inputAt: view.entries.findLast(isInput)?.model?.[0]?.timestamp,
      answerAt: view.entries.findLast((item) => item.model?.[0]?.role === 'assistant')?.model?.[0]
        ?.timestamp,
    })
    f.reads.mockClear()
    await f.harness.commit(
      (tx) =>
        tx.appendEntry(f.root.id, {
          kind: 'pi.tool',
          model: [
            {
              role: 'toolResult',
              toolCallId: `loop_${index}`,
              toolName: 'read',
              content: [{ type: 'text', text: 'Tool output' }],
              isError: false,
              timestamp: message.timestamp,
            },
          ],
        }),
      context,
    )
  }
})

it('keeps the full read for a publication mixing input and assistant entries', async () => {
  const f = await fixture()
  const message = fauxAssistantMessage('Answer')
  message.timestamp = 2000
  const entry = await f.harness.commit(async (tx) => {
    await tx.appendEntry(f.root.id, {
      kind: 'pi.user',
      model: [{ role: 'user', content: 'New input', timestamp: 1999 }],
    })
    return tx.appendEntry(f.root.id, { kind: 'pi.assistant', model: [message] })
  }, context)
  await until(
    async () => (await f.usage())?.entry === entry.id && (await f.metadata())?.inputAt === 1999,
  )
  expect(f.reads.mock.calls.length).toBeGreaterThanOrEqual(2)
})
