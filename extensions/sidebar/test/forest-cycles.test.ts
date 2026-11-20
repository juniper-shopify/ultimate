import { expect, it } from 'vitest'
import { sidebarForest } from '../forest.ts'

it('leaves parent cycles and their descendants without a top or working badge', () => {
  const rows = [
    { id: 1, parentConversationId: 2, busy: true, ownerTaskId: 1 },
    { id: 2, parentConversationId: 1, busy: false },
    { id: 3, parentConversationId: 3, busy: true, ownerTaskId: 2 },
    { id: 4, parentConversationId: 1, busy: true, ownerTaskId: 3 },
    { id: 5, busy: true },
  ]
  const forest = sidebarForest(rows, new Set<number>())
  expect(rows.map((row) => forest.tops.get(row.id)?.id)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    5,
  ])
  expect([...forest.working]).toEqual([[5, 'self']])
})
