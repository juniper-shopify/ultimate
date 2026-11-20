import { expect, it } from 'vitest'
import { sidebarForest, withoutListedSource } from '../forest.ts'

it('keeps branch ordering, owned children, working badges and hidden descendants distinct', () => {
  const rows = [
    { id: 1, busy: false },
    { id: 2, busy: false, branchOf: { conversationId: 1 }, inputAt: 10 },
    { id: 3, busy: true, parentConversationId: 2, ownerTaskId: 1 },
    { id: 4, busy: true, parentConversationId: 2 },
    { id: 5, busy: true, branchOf: { conversationId: 2 }, inputAt: 20 },
    { id: 6, busy: false, branchOf: { conversationId: 1 }, inputAt: 30 },
  ]
  const forest = sidebarForest(rows, new Set([1]))
  expect(forest.tops.get(3)?.id).toBe(2)
  expect(forest.tops.get(5)?.id).toBe(5)
  expect(forest.childrenByParent.get(2)?.map((row) => row.id)).toEqual([3])
  expect(forest.branchesBySource.get(1)?.map((row) => row.id)).toEqual([6, 2])
  expect([...forest.working]).toEqual([
    [2, 'subagents'],
    [5, 'self'],
  ])
  expect([...forest.hiddenIds([2])].toSorted((a, b) => a - b)).toEqual([2, 3, 4, 5])
  expect(withoutListedSource(rows).map((row) => row.id)).toEqual([1, 3, 4])
})

it('follows every parent for badges but gives parent edges precedence over branch hiding', () => {
  const rows = [
    { id: 4, busy: true, parentConversationId: 3, ownerTaskId: 1 },
    { id: 3, busy: false, parentConversationId: 2, branchOf: { conversationId: 1 } },
    { id: 2, busy: false },
    { id: 1, busy: true, parentConversationId: 99, ownerTaskId: 2 },
  ]
  const forest = sidebarForest(rows, new Set<number>())
  expect([...forest.working]).toEqual([[2, 'subagents']])
  expect(forest.tops.get(1)).toBeUndefined()
  expect([...forest.hiddenIds([1])]).toEqual([1])
  expect([...forest.hiddenIds([2])].toSorted((a, b) => a - b)).toEqual([2, 3, 4])
})
