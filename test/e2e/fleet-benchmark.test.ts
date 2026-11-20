import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'
import { temp } from '../helpers.ts'

it.each(['flat', 'tree'])(
  'replays a %s synthetic tool fleet and verifies the stream replicas',
  async (shape) => {
    const directory = await temp()
    const output = join(directory, 'result.json')
    await promisify(execFile)(
      process.execPath,
      [
        resolve('scripts/fleet-benchmark.ts'),
        '--conversations',
        '8',
        '--tasks',
        '12',
        '--active',
        '2',
        '--seconds',
        '1',
        '--shape',
        shape,
        '--think-ms',
        shape === 'tree' ? '50' : '0',
        '--no-browser',
        '--output',
        output,
      ],
      { timeout: 45_000 },
    )
    const result = JSON.parse(await readFile(output, 'utf8'))
    expect(result.fleet).toMatchObject({ conversations: 8, active: 2, clients: 1 })
    expect(result.fleet.shape).toBe(shape)
    expect(result.fleet.thinkMs).toBe(shape === 'tree' ? 50 : 0)
    expect(result.fleet.ownedConversations).toBe(shape === 'tree' ? 2 : 0)
    expect(result.fleet.forkedConversations).toBe(shape === 'tree' ? 4 : 0)
    expect(result.fleet.backgroundTasksParked).toBe(true)
    expect(result.fleet.tasks).toBeGreaterThanOrEqual(12)
    expect(result.providerToolCalls).toBeGreaterThan(0)
    expect(result.host.mainThreadMs).toBeGreaterThan(0)
    expect(result.streams[0].finalStateEqual).toBe(true)
    expect(result.streams[0].events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'doc', document: 'fleet.progress', delivery: 'snapshot' }),
        expect.objectContaining({
          event: 'docOps',
          document: 'fleet.progress',
          delivery: 'operations',
        }),
      ]),
    )
    expect((await readdir(directory)).some((name) => name.startsWith('fleet-'))).toBe(false)
  },
  60000,
)

it('cleans scratch state and the stand-in when setup fails before the host is forked', async () => {
  const directory = await temp()
  const output = join(directory, 'result.json')
  await writeFile(join(directory, 'result.host.log'), '', { mode: 0o400 })
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        resolve('scripts/fleet-benchmark.ts'),
        '--conversations',
        '8',
        '--tasks',
        '12',
        '--active',
        '2',
        '--seconds',
        '1',
        '--no-browser',
        '--output',
        output,
      ],
      { timeout: 10000, env: { ...process.env, TMPDIR: directory } },
    ),
  ).rejects.toMatchObject({ code: 1 })
  expect(JSON.parse(await readFile(output, 'utf8')).status).toBe('failed')
  expect(
    (await readdir(directory)).filter(
      (name) => name.startsWith('fleet-') || name.startsWith('ultimate-scripted-pi-'),
    ),
  ).toEqual([])
})
