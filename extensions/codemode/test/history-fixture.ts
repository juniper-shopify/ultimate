import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ExtensionHost } from '../../../server/extensions.ts'

export async function historyFixture(onPage: (pages: number) => void = () => {}) {
  const home = await mkdtemp(join(tmpdir(), 'history-worker-'))
  const database = join(home, 'state.sqlite')
  const db = new DatabaseSync(database)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE conversations (id INTEGER PRIMARY KEY, record TEXT NOT NULL)')
  db.exec(
    'CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER, record TEXT NOT NULL)',
  )
  db.exec('CREATE INDEX entry_conversation ON entries(conversation_id, id DESC)')
  const records = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }))
  const text = 'Synthetic search content with quotes "source".\n'.repeat(80)
  const entries = records.map((record) =>
    Array.from({ length: 400 }, (_, i) => ({
      id: record.id * 1000 + 400 - i,
      conversationId: record.id,
      kind: i % 2 ? 'test.note' : 'test.other',
      data: { text },
    })),
  )
  const conversationInsert = db.prepare('INSERT INTO conversations VALUES (?, ?)')
  const entryInsert = db.prepare('INSERT INTO entries VALUES (?, ?, ?)')
  db.exec('BEGIN')
  for (const record of records) conversationInsert.run(record.id, JSON.stringify(record))
  for (const entry of entries.flat())
    entryInsert.run(entry.id, entry.conversationId, JSON.stringify(entry))
  db.exec('COMMIT')
  let pages = 0
  const cleanups: (() => Promise<void>)[] = []
  let registered!: () => void
  const workerRegistered = new Promise<void>((resolve) => (registered = resolve))
  const host = {
    home,
    chapter: { name: 'active', database },
    onClose: (cleanup: () => Promise<void>) => {
      cleanups.push(cleanup)
      registered()
    },
    harness: () => ({
      commit: async (fn: (tx: unknown) => unknown) =>
        fn({ scanConversations: async () => ({ items: records }) }),
      conversation: async (id: number) => ({
        entries: async (query: { maxEntryId?: number }, count: number, cursor = 0) => {
          onPage(++pages)
          const rows = entries[id - 1].filter(
            (entry) => query.maxEntryId === undefined || entry.id <= query.maxEntryId,
          )
          return {
            items: rows.slice(cursor, cursor + count),
            ...(cursor + count < rows.length ? { next: cursor + count } : {}),
          }
        },
      }),
    }),
  } as unknown as ExtensionHost
  return {
    host,
    db,
    workerRegistered,
    pages: () => pages,
    close: async () => {
      for (const cleanup of cleanups) await cleanup()
      db.close()
      await rm(home, { recursive: true, force: true })
    },
  }
}
