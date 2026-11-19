import { afterEach, expect, it, vi } from 'vitest'
import * as json from '../../../lib/json-file.ts'
import { removeTemps, temp, until } from '../../../test/helpers.ts'
import {
  apply,
  healthRecorder,
  readFileHealth,
  readHealth,
  toHealth,
  WRITE_INTERVAL,
} from '../store.ts'
import type { HealthEntry, HealthFile } from '../store.ts'

const recorders: ReturnType<typeof healthRecorder>[] = []
afterEach(async () => {
  for (const recorder of recorders.splice(0)) await recorder.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await removeTemps()
})

async function fixture() {
  const home = await temp('health-writes-')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(1_000_000)
  const recorder = healthRecorder(home)
  recorders.push(recorder)
  const writes = vi.spyOn(json, 'writeJson')
  return { home, recorder, writes }
}

it('coalesces successes per provider for five seconds and flushes the trailing sample on close', async () => {
  const { home, recorder, writes } = await fixture()
  for (let i = 0; i < 100; i++)
    await recorder.record('p', { lastOk: Date.now() + i, lastUsed: Date.now() + i })
  expect(writes).toHaveBeenCalledTimes(1)
  await recorder.record('q', { lastOk: Date.now() })
  expect(writes).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(WRITE_INTERVAL)
  await until(async () => (await readFileHealth(home)).providers.p.lastOk === 1_000_099)
  expect(writes).toHaveBeenCalledTimes(3)

  await recorder.record('p', { lastOk: Date.now(), lastUsed: Date.now() })
  expect(writes).toHaveBeenCalledTimes(3)
  await recorder.close()
  expect((await readFileHealth(home)).providers.p).toEqual({
    lastOk: Date.now(),
    lastUsed: Date.now(),
  })
  expect(writes).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(WRITE_INTERVAL)
  expect(writes).toHaveBeenCalledTimes(4)
})

it('persists failures and recoveries immediately, matching unthrottled states, and does not revive a reset', async () => {
  const { home, recorder, writes } = await fixture()
  const oracle: HealthFile = { providers: {} }
  const samples: HealthEntry[] = [
    { lastOk: 1, lastUsed: 1 },
    { lastOk: 2, lastUsed: 2 },
    { lastFail: 3, lastUsed: 3, error: 'ETIMEDOUT' },
    { lastFail: 4, lastUsed: 4, error: 'ETIMEDOUT' },
    { lastFail: 5, lastUsed: 5, error: 'ETIMEDOUT' },
    { lastOk: 6, lastUsed: 6 },
    { lastOk: 7, lastUsed: 7 },
    { lastFail: 8, lastUsed: 8, error: '401 invalid_grant' },
    { lastOk: 9, lastUsed: 9 },
    { lastFail: 10, lastUsed: 10, error: '429 rate_limit_error' },
    { lastOk: 11, lastUsed: 11 },
    { lastFail: 12, lastUsed: 12, error: '402' },
    { lastFail: 13, lastUsed: 13, error: '402' },
    { lastFail: 14, lastUsed: 14, error: '402' },
    { lastOk: 15, lastUsed: 15 },
  ]
  const withoutSuccessTimes = (entries: Awaited<ReturnType<typeof readHealth>>) =>
    entries.map(({ lastOk: _ok, lastUsed: _used, ...entry }) => entry)
  const expectedWrites = [1, 1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 10, 11, 12, 13]
  for (const [index, sample] of samples.entries()) {
    oracle.providers.p = apply(oracle.providers.p ?? {}, sample)
    await recorder.record('p', sample)
    expect(withoutSuccessTimes(await readHealth(home))).toEqual(
      withoutSuccessTimes(toHealth(oracle, Date.now())),
    )
    expect(writes).toHaveBeenCalledTimes(expectedWrites[index])
  }
  await recorder.close()
  expect(await readFileHealth(home)).toEqual(oracle)

  const next = healthRecorder(home)
  recorders.push(next)
  await next.record('p', { lastOk: 16 })
  await next.record('p', { lastOk: 17 })
  await next.reset(['p'])
  await vi.advanceTimersByTimeAsync(WRITE_INTERVAL)
  await next.close()
  expect(await readHealth(home)).toEqual([])
})
