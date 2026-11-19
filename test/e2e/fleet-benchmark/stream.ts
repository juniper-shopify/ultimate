import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import type { ConversationSummary } from '../../../shared/protocol.ts'

export async function streamClient(url: string, conversation: number) {
  const controller = new AbortController()
  const response = await fetch(`${url}/api/events`, { signal: controller.signal })
  if (!response.ok || !response.body) throw new Error(`Stream: HTTP ${response.status}`)
  const counts: Record<
    string,
    {
      event: string
      document: string
      subscription: string
      delivery: string
      count: number
      bytes: number
      largestPayload: number
    }
  > = {}
  const windowCounts: typeof counts = {}
  let measuring = false
  const docs: Record<string, unknown> = {}
  let ui: unknown
  let tasks: unknown
  let conversations: ConversationSummary[] | undefined
  let connection: string | undefined
  let failure: unknown
  const reader = (async () => {
    let buffer = ''
    const decoder = new TextDecoder()
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = /^event: (.+)$/m.exec(frame)?.[1]
        if (!event) continue
        const lines = frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
        const subscription = lines.length > 1 ? lines.shift()! : 'global'
        const payload = lines.join('\n')
        const data = JSON.parse(payload)
        const document =
          data?.kind ??
          (event === 'view' || event === 'ops'
            ? 'view'
            : event === 'ui' || event === 'uiOps'
              ? 'ui'
              : '-')
        const delivery = ['docOps', 'ops', 'uiOps', 'tasksOps', 'conversationsUpsert'].includes(
          event,
        )
          ? 'operations'
          : ['doc', 'view', 'ui', 'tasks', 'conversations'].includes(event)
            ? 'snapshot'
            : 'event'
        const key = JSON.stringify([event, document, subscription, delivery])
        for (const table of measuring ? [counts, windowCounts] : [counts]) {
          const row = (table[key] ??= {
            event,
            document,
            subscription,
            delivery,
            count: 0,
            bytes: 0,
            largestPayload: 0,
          })
          row.count++
          row.bytes += Buffer.byteLength(frame + '\n\n')
          row.largestPayload = Math.max(row.largestPayload, Buffer.byteLength(payload))
        }
        if (event === 'stream') connection = data.id
        if (event === 'ui') ui = data.value
        if (event === 'uiOps') ui = applyImmutable(ui, data.ops as Op[])
        if (event === 'tasks') tasks = data
        if (event === 'tasksOps') tasks = applyImmutable(tasks, data.ops as Op[])
        if (event === 'conversations') conversations = data
        if (event === 'conversationsUpsert') {
          const rows = new Map(conversations?.map((row) => [row.id, row]))
          for (const row of data as ConversationSummary[]) rows.set(row.id, row)
          conversations = [...rows.values()]
        }
        if (event === 'doc') docs[data.kind] = data.value
        if (event === 'docOps') docs[data.kind] = applyImmutable(docs[data.kind], data.ops as Op[])
      }
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) failure = error
  })
  return {
    ready: () => {
      if (failure) throw failure
      return connection !== undefined && tasks !== undefined
    },
    subscribe: async () => {
      const result = await fetch(`${url}/api/events/${connection}/1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url },
        body: JSON.stringify({ conversation, docs: ['pi.live', 'fleet.progress'], view: true }),
      })
      if (!result.ok) throw new Error(`Subscribe: HTTP ${result.status}`)
    },
    state: () => {
      if (failure) throw failure
      return { tasks, conversations, docs, ui }
    },
    measure: (enabled: boolean) => {
      measuring = enabled
    },
    counts: () => Object.values(counts),
    windowCounts: () => Object.values(windowCounts),
    close: async () => {
      controller.abort()
      await reader
    },
  }
}
