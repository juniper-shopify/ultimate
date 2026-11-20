import { expect, it } from 'vitest'
import { instrument, assertSites, expectedSites } from '../scripts/fleet-profile/instrument.ts'
import { caveats, sampleFunctions, timingRows } from '../scripts/fleet-profile/report.ts'

it('keeps sampled elapsed weights separate from directly timed SQLite CPU', () => {
  const callFrame = (functionName: string, url = '', lineNumber = -1) => ({
    functionName,
    url,
    lineNumber,
    columnNumber: 0,
    scriptId: '1',
  })
  const sampled = sampleFunctions(
    {
      nodes: [
        { id: 1, callFrame: callFrame('(root)'), children: [2] },
        {
          id: 2,
          callFrame: callFrame(
            'commit',
            'file:///build/node_modules/@earendil-works/chord/dist/sqlite/node.js',
            136,
          ),
          children: [3],
        },
        { id: 3, callFrame: callFrame('exec') },
      ],
      samples: [3, 2, 3],
      timeDeltas: [1000, 2000, 3000],
      startTime: 0,
      endTime: 6000,
    },
    2,
    '/build',
  )
  expect(sampled.activeSampleMs).toBe(6)
  expect(sampled.sqliteNativeSampleMs).toBe(4)
  expect(sampled.rows.find((row) => row.name === 'commit')).toMatchObject({
    file: 'node_modules/@earendil-works/chord/dist/sqlite/node.js',
    line: 137,
    selfSampleMsPerRequest: 1,
    inclusiveSampleMsPerRequest: 3,
  })
  const direct = timingRows(
    {
      mode: 'sync',
      sites: {},
      smallestObservedCpuStepUs: 1000,
      threadMs: 2,
      wallMs: 6,
      rows: {
        'sqlite.exec:COMMIT': {
          calls: 2,
          inclusiveUs: 1000,
          exclusiveUs: 1000,
          file: 'node:sqlite (native)',
          line: 0,
        },
      },
    },
    2,
  )
  expect(direct[0].inclusiveThreadMsPerRequest).toBe(0.5)
  expect(caveats.join(' ')).toContain('not a CPU partition')
})

it('instruments pinned synchronous sites and rejects a changed target', () => {
  const source = 'const first = 1\nfunction copyContainers(value) { return value }'
  const result = instrument(
    source,
    'file:///build/node_modules/@earendil-works/chord/dist/delta/index.js',
    'sync',
    '/build',
  )
  expect(result.source).toContain('globalThis.fleetProfile.phase("delta.copyContainers"')
  expect(result.sites['delta.copyContainers']).toEqual({
    file: 'node_modules/@earendil-works/chord/dist/delta/index.js',
    line: 2,
  })
  expect(() =>
    instrument(
      'function renamed() {}',
      'file:///build/node_modules/@earendil-works/chord/dist/delta/index.js',
      'sync',
      '/build',
    ),
  ).toThrow('Unsupported profiling site')
})

it('rejects a moved file even though its function was never seen by the loader', () => {
  const sites = Object.fromEntries(
    expectedSites.sync
      .filter((label) => label !== 'delta.copyContainers')
      .map((label) => [label, { file: 'synthetic.js', line: 1 }]),
  )
  const moved = instrument(
    'function copyContainers(value) { return value }',
    'file:///build/node_modules/@earendil-works/chord/dist/delta/moved.js',
    'sync',
    '/build',
  )
  expect(() => assertSites('sync', { ...sites, ...moved.sites })).toThrow(
    'sites not found in this build: delta.copyContainers',
  )
})
