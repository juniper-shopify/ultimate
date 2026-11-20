import { Worker } from 'node:worker_threads'
import type { ConversationId, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { limit, searchHit, yieldTurn } from './chapters.ts'
import type { SearchOptions } from './chapters.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

export interface HistorySearch {
  database: string
  args: unknown[]
  conversations?: readonly { id: ConversationId; before?: EntryId }[]
}
type Reply =
  | { kind: 'result'; value: unknown }
  | { kind: 'error'; error: unknown }
  | { kind: 'aborted' }
interface QueuedSearch {
  request: HistorySearch
  signal?: AbortSignal
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  cancel: () => void
}

export class HistoryReads {
  readonly workers = new Map<Worker, { stop: (reason: unknown) => void; exited: Promise<void> }>()
  private readonly queued: QueuedSearch[] = []
  private closed = false

  search(request: HistorySearch, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('History reader is closed')
    return new Promise((resolve, reject) => {
      const job: QueuedSearch = {
        request,
        signal,
        resolve,
        reject,
        cancel: () => {
          const index = this.queued.indexOf(job)
          if (index < 0) return
          this.queued.splice(index, 1)
          reject(signal!.reason)
        },
      }
      this.queued.push(job)
      signal?.addEventListener('abort', job.cancel, { once: true })
      this.drain()
    })
  }

  private drain() {
    while (!this.closed && this.workers.size === 0) {
      const job = this.queued.shift()
      if (!job) return
      job.signal?.removeEventListener('abort', job.cancel)
      try {
        this.start(job)
      } catch (error) {
        job.reject(error)
      }
    }
  }

  private start(job: QueuedSearch) {
    const { request, signal } = job
    signal?.throwIfAborted()
    const worker = new Worker(new URL('./history-worker.ts', import.meta.url), {
      workerData: request,
      execArgv: [],
    })
    let value: unknown
    let failure: { reason: unknown } | undefined
    let received = false
    const stop = (reason: unknown) => {
      failure ??= { reason }
      worker.postMessage('abort', [])
    }
    const cancel = () => stop(signal!.reason)
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
    worker.on('message', (message: Reply) => {
      if (message.kind === 'result') {
        value = message.value
        received = true
      } else if (message.kind === 'error') failure ??= { reason: message.error }
      else if (message.kind === 'aborted')
        failure ??= { reason: new Error('History search was aborted') }
    })
    worker.on('error', (error) => (failure ??= { reason: error }))
    worker.once('exit', (code) => {
      this.workers.delete(worker)
      signal?.removeEventListener('abort', cancel)
      if (failure) job.reject(failure.reason)
      else if (received) job.resolve(value)
      else
        job.reject(new Error(`History worker exited with code ${code} before returning a result`))
      this.drain()
    })
    this.workers.set(worker, { stop, exited })
    signal?.addEventListener('abort', cancel, { once: true })
  }

  async close() {
    this.closed = true
    const reason = new Error('History reader is closed')
    for (const job of this.queued.splice(0)) {
      job.signal?.removeEventListener('abort', job.cancel)
      job.reject(reason)
    }
    const running = [...this.workers.values()]
    for (const worker of running) worker.stop(reason)
    await Promise.all(running.map((worker) => worker.exited))
  }
}

export async function searchHistory(
  host: ExtensionHost,
  request: HistorySearch,
  signal?: AbortSignal,
  firstPage?: { items: readonly EntryRecord[]; more: boolean },
): Promise<unknown[]> {
  signal?.throwIfAborted()
  const [text, rawOptions] = request.args
  if (typeof text !== 'string' || !text) throw new Error('search text must be nonempty')
  const options = (rawOptions ?? {}) as SearchOptions
  const count = limit(options.limit)
  const hits: unknown[] = []
  if (firstPage) {
    let slice = performance.now()
    for (const entry of firstPage.items) {
      if (performance.now() - slice >= 4) {
        await yieldTurn(signal)
        slice = performance.now()
      }
      const hit = searchHit(entry, text, options)
      if (hit) hits.push(hit)
      if (hits.length === count) return hits
    }
    if (!firstPage.more) return hits
    request = {
      ...request,
      args: [text, { ...options, limit: count - hits.length }],
      conversations: [{ id: request.conversations![0].id, before: firstPage.items.at(-1)!.id }],
    }
  }
  const rest = (await historyReads(host).search(request, signal)) as unknown[]
  return [...hits, ...rest]
}

const readers = new WeakMap<ExtensionHost, HistoryReads>()
export function historyReads(host: ExtensionHost) {
  const existing = readers.get(host)
  if (existing) return existing
  const reader = new HistoryReads()
  readers.set(host, reader)
  host.onClose(() => reader.close())
  return reader
}
