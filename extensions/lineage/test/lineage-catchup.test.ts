import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { expect, it, vi } from 'vitest'
import { git } from '../../../lib/git.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { Standing } from '../../subagents/api.ts'
import { WorkspacesApi } from '../../workspaces/api.ts'
import { catchup, Seen } from '../catchup.ts'

vi.mock('../../../lib/git.ts', () => ({ git: vi.fn<typeof git>() }))

it('catches up a ready workspace using only target lookup, landed count and recent log', async () => {
  const tip = 'a'.repeat(40)
  const previous = 'b'.repeat(40)
  const range = `${previous}..${tip}`
  const recent = `\x1e${tip}\0Newest landing\0\0\n\x1e${'c'.repeat(40)}\0Earlier landing\0\0`
  vi.mocked(git).mockImplementation(async (_cwd, command) => {
    if (command === 'rev-parse') return tip
    if (command === 'rev-list') return '2'
    if (command === 'log') return recent
    throw new Error(`Unexpected git command: ${command}`)
  })
  const seen = { main: previous, at: 42 }
  const workspaces = {}
  const scanEntries = vi.fn<Tx['scanEntries']>()
  const tx = {
    conversation: async () => ({ id: 42 }),
    doc: async (doc: unknown) => {
      if (doc === Standing) return {}
      if (doc === Seen) return seen
      if (doc === workspaces)
        return {
          items: {
            42: { source: '/source', target: 'main', path: '/workspace', state: 'ready' },
          },
        }
      throw new Error('Unexpected document')
    },
    scanEntries,
  } as unknown as Tx
  const host = {
    projectRoot: '/source',
    need: (api: unknown) => {
      expect(api).toBe(WorkspacesApi)
      return { doc: workspaces }
    },
    conversations: () => [],
    notice: vi.fn<ExtensionHost['notice']>(),
  } as unknown as ExtensionHost
  const result = await catchup(
    host,
    { kind: 'pi.user' },
    { conversationId: 42 as ConversationId, tx },
    context,
    async () => undefined,
  )
  expect(vi.mocked(git).mock.calls).toEqual([
    ['/source', 'rev-parse', '--verify', 'refs/heads/main'],
    ['/source', 'rev-list', '--first-parent', '--count', range],
    [
      '/source',
      'log',
      '--first-parent',
      '--max-count=30',
      '--format=%x1e%H%x00%s%x00%(trailers:key=Ultimate-Conversation,valueonly)%x00',
      range,
    ],
  ])
  expect(scanEntries).not.toHaveBeenCalled()
  expect(result?.entries[0].data?.text).toBe(
    [
      'Since you last worked (1970-01-01T00:00:00.042Z), 2 commits landed on main:',
      '- `aaaaaaa` Newest landing',
      '- `ccccccc` Earlier landing',
      'Check whether any of this already covers or changes what you are about to do.',
    ].join('\n\n'),
  )
  expect(seen.main).toBe(tip)
})
