import { expect, it, vi } from 'vitest'
import { conflictSample, landingRecord } from '../lander.ts'
import { needsRestart } from '../../../lib/layers.ts'
import type { git } from '../../../lib/git.ts'

const fixture = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock('../../../lib/git.ts', () => ({
  git: vi.fn<typeof git>(async (_source, ...args) => {
    if (args[0] === 'log') return 'abc1234 Synthetic change'
    if (args[0] === 'rev-list') return '1'
    if (args[0] === 'diff') return fixture.paths.join('\n')
    throw new Error('Unexpected synthetic Git operation')
  }),
}))

it('retains short conflict output and bounds a large UTF-8 conflict sample', () => {
  expect(conflictSample('one.ts\ntwo.ts')).toBe('one.ts\ntwo.ts')
  const paths = Array.from({ length: 1000 }, (_, index) => `path/${index}-${'é'.repeat(20)}.ts`)
  const sample = conflictSample(paths.join('\n'))
  expect(Buffer.byteLength(sample)).toBeLessThanOrEqual(4096)
  expect(sample).toContain('1000 conflicting paths')
  expect(sample).not.toContain('\ufffd')
})

it('keeps a restart-sensitive late path in the bounded landing record', async () => {
  fixture.paths = [
    ...Array.from({ length: 250 }, (_, index) => `docs/file-${index}.md`),
    'server/late.ts',
  ]
  const record = await landingRecord(
    '/synthetic/source',
    'before',
    'after',
    [],
    new AbortController().signal,
  )
  expect(record.paths).toHaveLength(200)
  expect(record.pathCount).toBe(251)
  expect(record.commitCount).toBe(1)
  expect(record.paths).toContain('server/late.ts')
  expect(needsRestart(record.paths)).toBe(true)
})
