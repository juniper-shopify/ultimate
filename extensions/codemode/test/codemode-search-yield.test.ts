import { expect, it } from 'vitest'
import { actions } from '../server.ts'
import { deadline } from '../../../lib/timers.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { historyFixture } from './history-fixture.ts'

it('lets a timer run before a store-wide search finishes', async () => {
  const fixture = await historyFixture()
  let done = false,
    timerDuringSearch = false
  const cancel = deadline(0, () => {
    timerDuringSearch = !done
  })
  try {
    expect(
      await actions.read({ op: 'search', args: ['absent-search-needle'] }, {
        host: fixture.host,
        signal: new AbortController().signal,
      } as ActionContext),
    ).toEqual([])
    done = true
    expect(timerDuringSearch).toBe(true)
  } finally {
    done = true
    cancel()
    await fixture.close()
  }
})
