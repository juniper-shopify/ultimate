import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { actions } from '../server.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { HistoryReads } from '../history-reads.ts'
import { historyFixture } from './history-fixture.ts'

it('searches fork ancestors at their cutoff, including history before resets and compactions', async () => {
  const fixture = await historyFixture()
  const reads = new HistoryReads()
  try {
    fixture.db
      .prepare('INSERT INTO conversations VALUES (?, ?)')
      .run(21, JSON.stringify({ id: 21, parent: { conversationId: 1, at: 1200 } }))
    const insert = fixture.db.prepare('INSERT INTO entries VALUES (?, ?, ?)')
    for (const entry of [
      { id: 21000, conversationId: 21, kind: 'test.note', data: { text: 'source child' } },
      { id: 21001, conversationId: 21, kind: 'pi.reset', head: 'self' },
      {
        id: 21002,
        conversationId: 21,
        kind: 'pi.compaction',
        head: 'self',
        data: { text: 'source summary' },
      },
    ])
      insert.run(entry.id, 21, JSON.stringify(entry))
    const result = (await reads.search({
      database: fixture.host.chapter.database,
      args: ['source', { conversationId: 21, limit: 1000, full: true }],
    })) as { id: number }[]
    expect(result.map((entry) => entry.id)).toEqual([
      21002,
      21000,
      ...Array.from({ length: 200 }, (_, i) => 1200 - i),
    ])
    expect(reads.workers.size).toBe(0)
  } finally {
    await reads.close()
    await fixture.close()
  }
})

it('keeps early scoped hits on the host and continues larger reads below the first page', async () => {
  const fixture = await historyFixture()
  const registered = vi.spyOn(fixture.host, 'onClose')
  const read = (limit: number) =>
    actions.read({ op: 'search', args: ['source', { conversationId: 1, limit, full: true }] }, {
      host: fixture.host,
      signal: new AbortController().signal,
    } as ActionContext)
  try {
    expect(((await read(7)) as { id: number }[]).map((entry) => entry.id)).toEqual(
      Array.from({ length: 7 }, (_, i) => 1400 - i),
    )
    expect(registered).not.toHaveBeenCalled()
    expect(((await read(137)) as { id: number }[]).map((entry) => entry.id)).toEqual(
      Array.from({ length: 137 }, (_, i) => 1400 - i),
    )
    expect(registered).toHaveBeenCalledOnce()
    expect(fixture.pages()).toBe(2)
  } finally {
    await fixture.close()
  }
})

it('runs offloaded searches in arrival order with one live worker and never starts a queued abort', async () => {
  const fixture = await historyFixture()
  const reads = new HistoryReads()
  const originalSet = reads.workers.set.bind(reads.workers)
  let maximumLive = 0
  const starts = vi.spyOn(reads.workers, 'set').mockImplementation((worker, state) => {
    maximumLive = Math.max(maximumLive, reads.workers.size + 1)
    return originalSet(worker, state)
  })
  const controller = new AbortController()
  const reason = new Error('Queued search cancelled')
  const completed: number[] = []
  const jobs = Array.from({ length: 5 }, (_, index) =>
    reads
      .search(
        { database: fixture.host.chapter.database, args: ['absent-needle'] },
        index === 2 ? controller.signal : undefined,
      )
      .then(
        (value) => {
          completed.push(index)
          return { value, error: undefined }
        },
        (error: unknown) => ({ value: undefined, error }),
      ),
  )
  try {
    expect(reads.workers.size).toBe(1)
    controller.abort(reason)
    const results = await Promise.all(jobs)
    expect(completed).toEqual([0, 1, 3, 4])
    expect(results[2].error).toBe(reason)
    for (const index of [0, 1, 3, 4]) expect(results[index].value).toEqual([])
    expect(starts).toHaveBeenCalledTimes(4)
    expect(maximumLive).toBe(1)
    expect(reads.workers.size).toBe(0)
  } finally {
    await reads.close()
    await Promise.all(jobs)
    starts.mockRestore()
    await fixture.close()
  }
})

it('awaits worker exit on abort and close, releasing its read-only connection', async () => {
  const fixture = await historyFixture()
  const reads = new HistoryReads()
  try {
    const controller = new AbortController()
    const reason = new Error('Search cancelled')
    const result = reads
      .search(
        { database: fixture.host.chapter.database, args: ['absent-needle'] },
        controller.signal,
      )
      .catch((error: unknown) => error)
    await once([...reads.workers.keys()][0], 'online')
    controller.abort(reason)
    expect(await result).toBe(reason)
    expect(reads.workers.size).toBe(0)
    expect(fixture.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0)
    const closing = reads
      .search({ database: fixture.host.chapter.database, args: ['absent-needle'] })
      .catch((error: unknown) => error)
    await once([...reads.workers.keys()][0], 'online')
    const queued = reads
      .search({ database: fixture.host.chapter.database, args: ['absent-needle'] })
      .catch((error: unknown) => error)
    expect(reads.workers.size).toBe(1)
    await reads.close()
    expect(await closing).toMatchObject({ message: 'History reader is closed' })
    expect(await queued).toMatchObject({ message: 'History reader is closed' })
    expect(reads.workers.size).toBe(0)
    expect(fixture.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0)
  } finally {
    await reads.close()
    await fixture.close()
  }
})
