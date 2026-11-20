import { expect, it } from 'vitest'
import { actions } from '../server.ts'
import { deadline } from '../../../lib/timers.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

it('lets a timer run before a store-wide search finishes', async () => {
  const records = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }))
  const text = 'Synthetic code with quotes "source" and a newline.\n'.repeat(80)
  const entries = records.map((record) =>
    Array.from({ length: 400 }, (_, i) => ({
      id: record.id * 1000 + 400 - i,
      conversationId: record.id,
      kind: 'pi.tool-result',
      model: [{ role: 'toolResult', content: [{ type: 'text', text }], timestamp: 1 }],
    })),
  )
  const host = {
    home: '',
    chapter: { name: 'active' },
    harness: () => ({
      commit: async (fn: (tx: unknown) => unknown) =>
        fn({ scanConversations: async () => ({ items: records }) }),
      conversation: async (id: number) => ({
        entries: async (_query: unknown, count: number, cursor = 0) => ({
          items: entries[id - 1].slice(cursor, cursor + count),
          ...(cursor + count < entries[id - 1].length ? { next: cursor + count } : {}),
        }),
      }),
    }),
  } as unknown as ExtensionHost
  let done = false,
    timerDuringSearch = false
  const cancel = deadline(0, () => {
    timerDuringSearch = !done
  })
  try {
    expect(
      await actions.read({ op: 'search', args: ['absent-search-needle'] }, {
        host,
        signal: new AbortController().signal,
      } as ActionContext),
    ).toEqual([])
    done = true
    expect(timerDuringSearch).toBe(true)
  } finally {
    done = true
    cancel()
  }
})
