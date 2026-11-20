import { expect, it } from 'vitest'
import { parseConversationId } from '../../../lib/ids.ts'
import { automationsSection } from '../triggers.ts'
import type { Automation } from '../types.ts'

it('shows owned automations and omits unrelated ones from the prompt', () => {
  const owner = parseConversationId(1)
  const make = (id: string, createdBy: number): Automation => ({
    id,
    name: id,
    enabled: true,
    subscribers: [],
    createdBy: parseConversationId(createdBy),
    schedule: { kind: 'every', ms: 1000 },
    createdAt: 0,
    updatedAt: 0,
    runs: [],
    fires: 0,
  })
  const own = make('owned', 1),
    unrelated = make('unrelated', 2)
  const section = automationsSection([own, unrelated], {}, owner, true)
  expect(section).toContain('owned:')
  expect(section).not.toContain('unrelated:')
  expect(automationsSection([unrelated], {}, owner, false)).toBe('')
})
