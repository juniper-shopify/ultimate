import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { temp } from '../helpers.ts'

it('profiles a small generated fleet with sampling, native CPU timers and perturbative actors', async () => {
  const directory = await temp()
  const output = join(directory, 'profile.json')
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      resolve('scripts/fleet-profile.ts'),
      '--conversations',
      '8',
      '--tasks',
      '12',
      '--active',
      '2',
      '--seconds',
      '1',
      '--output',
      output,
    ],
    { timeout: 110000, maxBuffer: 8 * 1024 * 1024 },
  )
  const result = JSON.parse(await readFile(output, 'utf8'))
  expect(result.status).toBe('passed')
  expect(Object.keys(result.runs)).toEqual(['plain', 'sample', 'sync', 'actors'])
  for (const mode of ['plain', 'sample', 'sync', 'actors']) {
    const run = result.runs[mode]
    expect(run.requests).toBeGreaterThan(0)
    expect(run.threadMsPerRequest).toBeGreaterThan(0)
    expect(run.finalStateEqual).toBe(true)
  }
  expect(result.sampled.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        line: expect.any(Number),
        file: expect.any(String),
        selfSampleMsPerRequest: expect.any(Number),
      }),
    ]),
  )
  expect(result.direct).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'delta.copyContainers', calls: expect.any(Number) }),
    ]),
  )
  expect(result.sqliteNative.some((row: { calls: number }) => row.calls > 0)).toBe(true)
  expect(Object.keys(result.instrumentedSites.sync)).toEqual(
    expect.arrayContaining(['scheduler.wake', 'scheduler.wakeDue', 'sqlite.exec']),
  )
  expect(Object.keys(result.instrumentedSites.actors)).toEqual(
    expect.arrayContaining([
      'session.observeCommits',
      'session.followCommits',
      'extension.install',
    ]),
  )
  expect(
    result.direct.find((row: { label: string }) => row.label === 'scheduler.wake')
      .inclusiveElapsedMsPerRequest,
  ).toBeGreaterThan(0)
  expect(result.actors.some((row: { label: string }) => row.label.startsWith('hook:'))).toBe(true)
  expect(result.actors.some((row: { calls: number }) => row.calls === 0)).toBe(true)
  expect(
    result.actors.some((row: { label: string }) => row.label.startsWith('listener:extensions/')),
  ).toBe(true)
  expect(stdout).toContain('PERTURBATIVE')
  expect(stdout).toContain('below resolution')
  expect(stdout).toContain('hrtime.bigint')
  expect(stdout).toContain('not a CPU partition')
  expect(stdout).toContain('does not spawn processes')
  expect((await readdir(directory)).some((name) => name.startsWith('fleet-'))).toBe(false)
}, 120000)
