import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { defineDoc, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  JsonObject,
  SubmissionRecord,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { resetAfter, Summaries } from './summary.ts'
import { isInput } from '../../lib/entries.ts'
import { OverviewDoc } from './refs.ts'
import type { OverviewRow, OverviewState } from './types.ts'
import { parseConversationId } from '../../lib/ids.ts'

export const Overview = defineDoc<OverviewState>({
  kind: OverviewDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ conversations: {} }),
})

const nonFailureSettlements = new Set(['aborted', 'reset', 'stale'])
const queuedFollowUpLookback = 32

const summaryFields = (value: Readonly<JsonObject> | undefined) =>
  JSON.stringify([
    value?.summary || null,
    value?.feature || null,
    value?.status || null,
    value?.activity || null,
    value?.assessmentStatus || null,
  ])

const queuedInput = (value: Readonly<JsonObject>) => {
  const items = value.items
  if (!Array.isArray(items)) return undefined
  let queued = false
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    queued ||= item.mode !== 'write'
  }
  return queued
}

async function lastPlacedInput(
  host: Pick<ExtensionHost, 'scanSubmissions'>,
  id: ConversationId,
): Promise<SubmissionRecord | undefined> {
  let latest: SubmissionRecord | undefined
  let remaining = queuedFollowUpLookback
  let cursor: Cursor | undefined
  do {
    const page = await host.scanSubmissions(
      { conversationId: id, order: 'descending' },
      16,
      cursor,
      context,
    )
    for (const item of page.items) {
      if (latest) remaining--
      if (item.type === 'input' && item.entry !== undefined && item.entry > (latest?.entry ?? -1))
        latest = item
    }
    cursor = page.next
  } while (cursor !== undefined && remaining > 0)
  return latest
}

export function overviewBehavior(
  host: Pick<ExtensionHost, 'harness' | 'scanSubmissions' | 'onOpen' | 'onClose' | 'notice'>,
) {
  let stop: (() => void) | undefined
  let closed = false
  let draining: Promise<void> | undefined
  const pending = new Set<ConversationId>()
  const current = new Map<ConversationId, { summary: string; working: boolean; queued: boolean }>()
  const invalidate = (id: ConversationId) => {
    current.delete(id)
    pending.add(id)
  }
  const reconcileFromCommittedRecords = async (ids: ConversationId[]) => {
    const harness = host.harness()
    const [states, inputs] = await Promise.all([
      Promise.all(ids.map((id) => harness.snapshot(Summaries, id, context))),
      Promise.all(ids.map((id) => lastPlacedInput(host, id))),
    ])
    const reconciled = new Map<
      ConversationId,
      { summary: string; working: boolean; queued: boolean }
    >()
    await harness.commit(async (tx) => {
      const index = await tx.doc(Overview, ROOT_CONVERSATION_ID)
      for (const [position, id] of ids.entries()) {
        if (!(await tx.conversation(id))) continue
        const state = states[position]
        const input = inputs[position]
        const live = await tx.doc(LiveDoc, id)
        const inbox = await tx.doc(InboxDoc, id)
        reconciled.set(id, {
          summary: summaryFields(state),
          working: Boolean(live.run),
          queued: inbox.items.some((item) => item.mode !== 'write'),
        })
        const active = input !== undefined && !(await resetAfter(tx, id, input.entry!))
        const answerId = active && input.status === 'done' ? input.answer : undefined
        const failed =
          active && input.status === 'unanswered' && !nonFailureSettlements.has(input.reason)
        const row: OverviewRow = {
          runState: live.run
            ? 'working'
            : inbox.items.some((item) => item.mode !== 'write')
              ? 'queued'
              : answerId !== undefined
                ? 'answered'
                : failed
                  ? 'error'
                  : 'idle',
          ...(active ? { inputId: input.entry } : {}),
          ...(active && (await tx.entry(input.entry!))?.kind !== 'pi.user'
            ? { internalInput: true as const }
            : {}),
          ...(answerId !== undefined ? { answerId } : {}),
          ...(state?.summary ? { summary: state.summary } : {}),
          ...(state?.feature ? { feature: state.feature } : {}),
          ...(state?.status ? { summaryStatus: state.status } : {}),
          ...(state?.activity ? { activity: state.activity } : {}),
          ...(state?.assessmentStatus ? { assessmentStatus: state.assessmentStatus } : {}),
        }
        if (JSON.stringify(index.conversations[id]) !== JSON.stringify(row))
          index.conversations[id] = row
      }
    }, context)
    for (const [id, source] of reconciled) if (!pending.has(id)) current.set(id, source)
  }
  const schedule = () => {
    if (draining || closed) return
    draining = (async () => {
      while (pending.size) {
        if (closed) break
        const ids = [...pending]
        pending.clear()
        await reconcileFromCommittedRecords(ids)
      }
    })()
      .catch((error: unknown) => {
        if (!closed) host.notice(`Conversation overview: ${String(error)}`)
      })
      .finally(() => {
        draining = undefined
        if (pending.size && !closed) schedule()
      })
  }
  host.onOpen(async () => {
    closed = false
    current.clear()
    stop = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'document.copy') {
          if (change.record.kind === Overview.definition.kind) current.clear()
          else if (
            change.record.kind === Summaries.definition.kind ||
            change.record.kind === LiveDoc.definition.kind ||
            change.record.kind === InboxDoc.definition.kind
          )
            current.delete(change.conversationId)
        }
        if (change.type === 'document' && change.record.kind === Overview.definition.kind) {
          if (change.kind === 'retire' || change.ops.length === 0) current.clear()
          else
            for (const op of change.ops) {
              if (op[0] === 'r' || op[1][0] !== 'conversations' || op[1].length < 2) {
                current.clear()
                break
              }
              current.delete(parseConversationId(Number(op[1][1])))
            }
        }
        if (change.type === 'conversation') invalidate(change.value.id)
        if (change.type === 'submission') invalidate(change.value.conversationId)
        if (
          change.type === 'entry' &&
          (isInput(change.value) || ['pi.reset', 'pi.compaction'].includes(change.value.kind))
        )
          invalidate(change.value.conversationId)
        if (
          change.type === 'document' &&
          change.conversationId !== undefined &&
          (change.record.kind === Summaries.definition.kind ||
            (change.record.kind === LiveDoc.definition.kind &&
              (change.kind === 'retire' ||
                change.ops.some((op) => op[0] === 'r' || op[1][0] === 'run'))) ||
            change.record.kind === InboxDoc.definition.kind)
        ) {
          const source = current.get(change.conversationId)
          if (source && change.kind === 'change') {
            if (
              (change.record.kind === LiveDoc.definition.kind &&
                source.working === Boolean(change.value.run)) ||
              (change.record.kind === InboxDoc.definition.kind &&
                source.queued === queuedInput(change.value)) ||
              (change.record.kind === Summaries.definition.kind &&
                source.summary === summaryFields(change.value))
            )
              continue
          }
          invalidate(change.conversationId)
        }
      }
      if (pending.size) schedule()
    })
    await host.harness().commit(async (tx) => {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        for (const own of page.items) pending.add(own.id)
        cursor = page.next
      } while (cursor !== undefined)
    }, context)
    schedule()
    await draining
  })
  host.onClose(async () => {
    closed = true
    stop?.()
    await draining
  })
}
