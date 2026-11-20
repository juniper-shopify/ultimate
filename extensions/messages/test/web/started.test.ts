import { createElement } from 'react'
import type { EffectCallback } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { StartedDoc } from '../../refs.ts'

const state = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  ref: { current: new Map<number, () => void>() },
  docsOf: {} as Record<number, Record<string, { by?: number }>>,
  active: new Set<number>(),
  starts: [] as number[],
}))
// Run the hook's commit effects explicitly with its ref retained across the simulated row-set changes.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: EffectCallback) => state.effects.push(effect),
  useRef: () => state.ref,
}))
vi.mock('@/sdk', () => ({
  useConversations: () => [],
  useStore: (select: (value: typeof state) => unknown) => select(state),
}))
vi.mock('@/sdk/client', () => ({
  store: {
    watchDocOf: (id: number) => {
      state.active.add(id)
      state.starts.push(id)
      return () => state.active.delete(id)
    },
  },
}))
vi.mock('../../../conversations/ui.tsx', () => ({ useOverview: () => ({}) }))
vi.mock('../../../workspaces/ui.tsx', () => ({ useWorkspaceIndex: () => ({ queue: [] }) }))
const { useStarters } = await import('../../started.tsx')

it('watches only mounted branch ids and retains shared watches while history expands and collapses', () => {
  const fleet = Array.from({ length: 1100 }, (_, index) => index + 1)
  const active = fleet.slice(1, 100)
  const history = fleet.slice(100)
  function Rows({ ids }: { ids: number[] }) {
    return String(useStarters(ids)(2))
  }
  const render = (ids: number[]) => {
    state.effects = []
    const html = renderToStaticMarkup(createElement(Rows, { ids }))
    state.effects[0]()
    return html
  }
  expect(render(active)).toBe('null')
  const unmount = state.effects[1]() as () => void
  expect(state.active.size).toBe(99)
  state.docsOf[2] = { [StartedDoc.kind]: { by: 1 } }
  expect(render([...active, ...history])).toBe('1')
  expect(state.active.size).toBe(1099)
  expect(state.starts.filter((id) => id === 2)).toHaveLength(1)
  render(active)
  expect([...state.active]).toEqual(active)
  state.docsOf[2] = { [StartedDoc.kind]: {} }
  expect(render(active)).toBe('undefined')
  unmount()
  expect(state.active.size).toBe(0)
})
