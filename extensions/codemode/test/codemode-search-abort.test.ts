import { once } from 'node:events'
import { expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import codemode, { actions } from '../server.ts'
import { historyReads } from '../history-reads.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { historyFixture } from './history-fixture.ts'

it('stops a store-wide search on abort and waits for its worker to exit', async () => {
  const store = await historyFixture()
  const controller = new AbortController()
  const reason = new Error('Read cancelled')
  try {
    const result = actions
      .read({ op: 'search', args: ['absent-search-needle'] }, {
        host: store.host,
        signal: controller.signal,
      } as ActionContext)
      .catch((error: unknown) => error)
    await store.workerRegistered
    const reader = historyReads(store.host)
    const worker = [...reader.workers.keys()][0]
    const messages: string[] = []
    worker.on('message', (message: { kind: string }) => messages.push(message.kind))
    await once(worker, 'online')
    const abortedAt = performance.now()
    controller.abort(reason)
    expect(await result).toBe(reason)
    expect(performance.now() - abortedAt).toBeLessThan(1000)
    expect(messages).toContain('aborted')
    expect(messages).not.toContain('result')
    expect(reader.workers.size).toBe(0)
    expect(store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0)
  } finally {
    await store.close()
  }
})

it('stops entries within one page of an abort', async () => {
  const controller = new AbortController()
  const reason = new Error('Read cancelled')
  let pagesAtAbort = 0
  const store = await historyFixture((pages) => {
    if (pages === 2)
      queueMicrotask(() => {
        pagesAtAbort = store.pages()
        controller.abort(reason)
      })
  })
  try {
    await expect(
      actions.read({ op: 'entries', args: [1, { kinds: ['missing'] }] }, {
        host: store.host,
        signal: controller.signal,
      } as ActionContext),
    ).rejects.toBe(reason)
    expect(pagesAtAbort).toBeGreaterThan(0)
    expect(store.pages()).toBeLessThanOrEqual(pagesAtAbort + 1)
    expect(store.pages()).toBeLessThan(4)
  } finally {
    await store.close()
  }
})

it('stops an unawaited sandbox search when its call signal is cancelled', async () => {
  const store = await historyFixture()
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
  try {
    const tool = codemode(store.host).tools![0]
    const result = await tool.execute(
      { code: "ultimate.search('absent-search-needle'); return 'finished';" },
      api,
      BACKGROUND_CONTEXT,
    )
    await searchSettled
    expect(result.isError).not.toBe(true)
    expect(cancelled).toBe(true)
    expect(historyReads(store.host).workers.size).toBe(0)
  } finally {
    await store.close()
  }
})
