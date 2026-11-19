import { parentPort, workerData } from 'node:worker_threads'
import { readChapter } from './chapters.ts'
import type { HistorySearch } from './history-reads.ts'

const port = parentPort!
const request = workerData as HistorySearch
const controller = new AbortController()
port.on('message', () => controller.abort())
try {
  const value = await readChapter(
    request.database,
    'search',
    request.args,
    controller.signal,
    request.conversations,
  )
  port.postMessage({ kind: 'result', value })
} catch (error) {
  if (controller.signal.aborted) port.postMessage({ kind: 'aborted' })
  else port.postMessage({ kind: 'error', error })
} finally {
  port.close()
}
