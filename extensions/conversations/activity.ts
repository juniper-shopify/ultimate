import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import type { ConversationId, Cursor, EntryRecord } from '@earendil-works/pi-durable'
import { isInput } from '../../lib/entries.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

export function activityBehavior(
  host: Pick<ExtensionHost, 'harness' | 'metadata' | 'onOpen' | 'onClose' | 'notice'>,
) {
  let stop: (() => void) | undefined
  let closed = false
  let draining: Promise<void> | undefined
  const pending = new Map<ConversationId, EntryRecord | undefined>()
  const reconcile = async (id: ConversationId, assistant?: EntryRecord) => {
    const message = assistant?.model?.[0]
    if (message?.role === 'assistant' && typeof message.timestamp === 'number') {
      await host.harness().commit(async (tx) => {
        if (pending.has(id) || !(await tx.conversation(id))) return
        const metadata = await tx.doc(host.metadata, id)
        if (metadata.answerAt !== message.timestamp) metadata.answerAt = message.timestamp
      }, context)
      return
    }
    const conversation = await host.harness().conversation(id, context)
    if (!conversation) return
    const { entries } = await conversation.context(context)
    const input = entries.find(isInput)?.model?.[0]
    const title =
      input?.role === 'user'
        ? typeof input.content === 'string'
          ? input.content
          : input.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ')
        : undefined
    let inputAt = entries.findLast(isInput)?.model?.[0]?.timestamp
    let answerAt = entries.findLast((entry) => entry.model?.[0]?.role === 'assistant')?.model?.[0]
      ?.timestamp
    const head = entries[0]?.head
    const needsActivityBeforeContextHead =
      head !== undefined && (inputAt === undefined || answerAt === undefined)
    if (needsActivityBeforeContextHead) {
      let cursor: Cursor | undefined
      do {
        const page = await conversation.entries({ maxEntryId: head }, 64, cursor, context)
        for (const entry of page.items) {
          if (isInput(entry)) inputAt ??= entry.model?.[0]?.timestamp
          if (entry.model?.[0]?.role === 'assistant') answerAt ??= entry.model[0].timestamp
        }
        cursor = page.next
      } while (cursor !== undefined && (inputAt === undefined || answerAt === undefined))
    }
    const inputTitle = title ? title.replace(/\s+/g, ' ').slice(0, 160) : undefined
    const previous = await host.harness().snapshot(host.metadata, id, context)
    const inheritedInputIsOlder =
      previous?.inputAt !== undefined && (inputAt === undefined || inputAt < previous.inputAt)
    if (inheritedInputIsOlder) inputAt = previous.inputAt
    if (
      previous?.inputTitle === inputTitle &&
      previous?.inputAt === inputAt &&
      previous?.answerAt === answerAt
    )
      return
    await host.harness().commit(async (tx) => {
      const metadata = await tx.doc(host.metadata, id)
      if (inputTitle !== undefined) metadata.inputTitle = inputTitle
      else delete metadata.inputTitle
      if (inputAt !== undefined) metadata.inputAt = inputAt
      else delete metadata.inputAt
      if (answerAt !== undefined) metadata.answerAt = answerAt
      else delete metadata.answerAt
    }, context)
  }
  const schedule = () => {
    if (draining || closed) return
    draining = (async () => {
      while (pending.size) {
        if (closed) break
        const ids = [...pending]
        pending.clear()
        for (const [id, assistant] of ids) await reconcile(id, assistant)
      }
    })()
      .catch((error: unknown) => {
        if (!closed) host.notice(`Conversation activity: ${String(error)}`)
      })
      .finally(() => {
        draining = undefined
        if (pending.size && !closed) schedule()
      })
  }
  host.onOpen(async () => {
    closed = false
    stop = onCommit(host.harness(), (publication) => {
      const candidates = new Map<ConversationId, EntryRecord | undefined>()
      const full = new Set<ConversationId>()
      for (const change of publication.changes) {
        if (change.type === 'conversation') full.add(change.value.id)
        if (change.type !== 'entry') continue
        const entry = change.value
        if (isInput(entry) || entry.head !== undefined) full.add(entry.conversationId)
        if (entry.model?.[0]?.role !== 'assistant') continue
        if (entry.kind !== 'pi.assistant' || typeof entry.model[0].timestamp !== 'number')
          full.add(entry.conversationId)
        const previous = candidates.get(entry.conversationId)
        if (!previous || entry.id > previous.id) candidates.set(entry.conversationId, entry)
      }
      for (const id of full) candidates.set(id, undefined)
      for (const [id, assistant] of candidates) {
        if (pending.has(id) && pending.get(id) === undefined) continue
        const previous = pending.get(id)
        pending.set(id, assistant && previous && previous.id > assistant.id ? previous : assistant)
      }
      if (pending.size) schedule()
    })
    await host.harness().commit(async (tx) => {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        for (const own of page.items) pending.set(own.id, undefined)
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
