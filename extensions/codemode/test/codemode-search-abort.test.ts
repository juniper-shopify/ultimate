import { expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import codemode, { actions } from '../server.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

function fixture(onPage: (pages: number) => void = () => {}) {
  const text = 'Synthetic search content with quotes "source".\n'.repeat(80)
  const records = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }))
  const entries = records.map((record) =>
    Array.from({ length: 400 }, (_, i) => ({
      id: record.id * 1000 + 400 - i,
      conversationId: record.id,
      kind: 'test.note',
      data: { text },
    })),
  )
  let pages = 0
  const host = {
    home: '',
    chapter: { name: 'active' },
    harness: () => ({
      commit: async (fn: (tx: unknown) => unknown) =>
        fn({ scanConversations: async () => ({ items: records }) }),
      conversation: async (id: number) => ({
        entries: async (_query: unknown, count: number, cursor = 0) => {
          onPage(++pages)
          return {
            items: entries[id - 1].slice(cursor, cursor + count),
            ...(cursor + count < entries[id - 1].length ? { next: cursor + count } : {}),
          }
        },
      }),
    }),
  } as unknown as ExtensionHost
  return { host, pages: () => pages }
}

it.each([
  ['search', ['absent-search-needle']],
  ['entries', [1, { kinds: ['missing'] }]],
])('stops %s within one page of an abort', async (op, args) => {
  const controller = new AbortController()
  const reason = new Error('Read cancelled')
  let pagesAtAbort = 0
  const store = fixture((pages) => {
    if (pages === (op === 'search' ? 40 : 2))
      queueMicrotask(() => {
        pagesAtAbort = store.pages()
        controller.abort(reason)
      })
  })
  await expect(
    actions.read({ op, args }, {
      host: store.host,
      signal: controller.signal,
    } as ActionContext),
  ).rejects.toBe(reason)
  expect(pagesAtAbort).toBeGreaterThan(0)
  expect(store.pages()).toBeLessThanOrEqual(pagesAtAbort + 1)
  expect(store.pages()).toBeLessThan(op === 'search' ? 80 : 4)
})

it('stops an unawaited sandbox search when its call signal is cancelled', async () => {
  const store = fixture()
  let settled!: () => void
  let cancelled = false
  const searchSettled = new Promise<void>((resolve) => {
    settled = resolve
  })
  const api = {
    conversationId: 1,
    callId: 'test-search',
    agent: async () => ({ tools: [] }),
    snapshot: async () => ({}),
    commit: async () => {},
    output: (text: string) => {
      if (text.includes(' ultimate.search ')) {
        cancelled = text.startsWith('✗')
        settled()
      }
    },
  } as unknown as ToolExecutionApi
  const tool = codemode(store.host).tools![0]
  const result = await tool.execute(
    { code: "ultimate.search('absent-search-needle'); return 'finished';" },
    api,
    BACKGROUND_CONTEXT,
  )
  const pagesAtFinish = store.pages()
  await searchSettled
  expect(result.isError).not.toBe(true)
  expect(cancelled).toBe(true)
  expect(pagesAtFinish).toBeGreaterThan(0)
  expect(store.pages()).toBeLessThanOrEqual(pagesAtFinish + 1)
  expect(store.pages()).toBeLessThan(80)
})
