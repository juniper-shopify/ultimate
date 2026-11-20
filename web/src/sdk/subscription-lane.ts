interface Waiting {
  work: () => Promise<void>
  interactive: () => boolean
  signal: AbortSignal
  resolve: () => void
  reject: (error: unknown) => void
  aborted: () => void
}

export function createSubscriptionLane(limit: number) {
  const waiting = new Set<Waiting>()
  let running = 0

  function start(entry: Waiting, background: boolean) {
    waiting.delete(entry)
    entry.signal.removeEventListener('abort', entry.aborted)
    if (entry.signal.aborted) {
      entry.reject(entry.signal.reason)
      return
    }
    if (background) running++
    const finished = () => {
      if (background) running--
      drain()
    }
    try {
      void entry.work().then(entry.resolve, entry.reject).finally(finished)
    } catch (error) {
      entry.reject(error)
      finished()
    }
  }
  function drain() {
    while (running < limit && waiting.size) {
      const entry = waiting.values().next().value!
      start(entry, !entry.interactive())
    }
  }

  return {
    run(work: () => Promise<void>, interactive: () => boolean, signal: AbortSignal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        const entry: Waiting = {
          work,
          interactive,
          signal,
          resolve,
          reject,
          aborted: () => {
            waiting.delete(entry)
            reject(signal.reason)
            drain()
          },
        }
        if (interactive()) start(entry, false)
        else {
          waiting.add(entry)
          signal.addEventListener('abort', entry.aborted, { once: true })
          drain()
        }
      })
    },
    promote() {
      for (const entry of waiting) if (entry.interactive()) start(entry, false)
      drain()
    },
  }
}
