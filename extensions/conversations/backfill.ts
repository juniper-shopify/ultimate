import { defineDoc } from '@earendil-works/pi-durable'
import type { ContextUsage } from './api.ts'

const projectionVersion = 1

export const BackfillDoc = defineDoc({
  kind: 'conversations.backfill',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: (): { context?: string; activity?: string; activityTail?: number } => ({}),
})

export function contextCheckpoint(
  tail: number,
  value: ContextUsage,
  window?: number | 'inherited',
) {
  return JSON.stringify([
    projectionVersion,
    tail,
    value.at,
    value.entry,
    value.tokens,
    value.window,
    value.percent,
    value.estimated,
    window,
  ])
}

export function activityCheckpoint(
  tail: number,
  value: { inputTitle?: string; inputAt?: number; answerAt?: number },
) {
  return JSON.stringify([projectionVersion, tail, value.inputTitle, value.inputAt, value.answerAt])
}
