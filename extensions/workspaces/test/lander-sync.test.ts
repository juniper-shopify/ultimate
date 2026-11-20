import { expect, it, vi } from 'vitest'
import { context } from '../../../server/harness.ts'
import { git } from '../../../lib/git.ts'
import { Workspaces } from '../workspaces.ts'
import type { WorkspaceIndex } from '../types.ts'
import { createLander } from '../lander.ts'

vi.mock('../../../lib/git.ts', () => ({ git: vi.fn<typeof git>() }))
vi.mock('../tree.ts', () => ({
  treePath: async () => '/integration',
  addCheckout: async () => {},
}))

it('gives checkout synchronization a cancellable budget and reports a merge error as an error, not a conflict', async () => {
  vi.mocked(git).mockImplementation(async (_source, ...args) => {
    if (args[0] === 'worktree') return 'worktree /integration\n'
    if (args[0] === 'rev-parse') return 'base'
    if (args[0] === 'merge' && !args.includes('--abort')) throw new Error('merge hook refused')
    return ''
  })
  const index = {
    queue: [
      {
        id: 'submission',
        conversationId: 2,
        source: '/source',
        target: 'main',
        tip: 'branch-tip',
        at: 1,
        divergence: 'None',
        steps: [],
      },
    ],
    items: { '2': {} },
    results: {},
  } as unknown as WorkspaceIndex
  const task = createLander(
    {
      home: '/state',
      projectSettings: async () => ({}),
      emit: async () => {},
    } as unknown as Parameters<typeof createLander>[0],
    Workspaces,
    (_source, operation) => operation(),
    {} as Parameters<typeof createLander>[3],
  )
  const phase = task.definition.phases.land
  const controller = new AbortController()
  let committed: unknown
  const tx = { doc: async () => index, appendEntry: async () => {} }
  await phase(
    {
      input: { source: '/source' },
      state: { checkpoint: { id: 'submission', attempt: 1 } },
    } as Parameters<typeof phase>[0],
    {
      signal: controller.signal,
      conversationId: 3,
      snapshot: async () => index,
      memo: async () => undefined,
      commit: async (operation: (transaction: typeof tx) => Promise<unknown>) => {
        committed = await operation(tx)
      },
    } as unknown as Parameters<typeof phase>[1],
    context,
  )
  const calls = vi.mocked(git).mock.calls
  for (const command of ['reset', 'checkout', 'clean']) {
    const call = calls.find(([, ...args]) => args[0] === command)!
    expect(call[0]).toMatchObject({
      cwd: '/integration',
      signal: controller.signal,
      timeout: 300000,
    })
  }
  const merge = calls.find(([, ...args]) => args[0] === 'merge' && !args.includes('--abort'))!
  expect(merge[0]).toMatchObject({
    cwd: '/integration',
    signal: controller.signal,
    timeout: 300000,
  })
  expect(merge).toContain('--no-stat')
  expect(committed).toMatchObject({
    checkpoint: {
      outcome: { outcome: 'failed', reason: 'the merge failed', output: 'merge hook refused' },
    },
  })
})
