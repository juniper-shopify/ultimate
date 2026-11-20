import { useEffect, useMemo, useRef } from 'react'
import { useConversations, useStore } from '@/sdk'
import { store } from '@/sdk/client'
import { parseConversationId } from '../../lib/ids.ts'
import { useOverview } from '../conversations/ui.tsx'
import { useWorkspaceIndex } from '../workspaces/ui.tsx'
import { StartedDoc } from './refs.ts'

export function useStarters(branchIds: readonly number[]) {
  const ids = [...new Set(branchIds)].toSorted((a, b) => a - b).join(',')
  const watched = useRef(new Map<number, () => void>())
  useEffect(() => {
    const next = new Set(ids ? ids.split(',').map(Number) : [])
    for (const [id, stop] of watched.current) {
      if (next.has(id)) continue
      stop()
      watched.current.delete(id)
    }
    for (const id of next) {
      if (!watched.current.has(id))
        watched.current.set(id, store.watchDocOf(parseConversationId(id), StartedDoc.kind))
    }
  }, [ids])
  useEffect(
    () => () => {
      for (const stop of watched.current.values()) stop()
      watched.current.clear()
    },
    [],
  )
  const starters = useStore((state) =>
    (ids ? ids.split(',') : [])
      .map((id) => {
        const doc = state.docsOf[Number(id)]?.[StartedDoc.kind]
        const by = doc?.by
        return `${id}:${doc === undefined ? '?' : typeof by === 'number' ? by : ''}`
      })
      .join(','),
  )
  const by = useMemo(
    () =>
      new Map(
        starters
          ? starters.split(',').map((pair) => {
              const [id, starter] = pair.split(':')
              return [
                Number(id),
                starter === '?' ? null : starter ? Number(starter) : undefined,
              ] as const
            })
          : [],
      ),
    [starters],
  )
  return (id: number) => by.get(id)
}

export function useUnderway() {
  const conversations = useConversations()
  const overview = useOverview()
  const queue = useWorkspaceIndex().queue
  const topOf = (id: number) => {
    let top = conversations.find((c) => c.id === id)
    let topId = id
    while (top) {
      topId = top.id
      const parent = top.ownerTaskId === undefined ? undefined : top.parentConversationId
      top = parent === undefined ? undefined : conversations.find((c) => c.id === parent)
    }
    return topId
  }
  const busy = new Set(conversations.filter((c) => c.busy).map((c) => topOf(c.id)))
  const landing = new Set<number>(queue.map((item) => item.conversationId))
  return (id: number) =>
    busy.has(id) ||
    landing.has(id) ||
    overview[id]?.runState === 'working' ||
    overview[id]?.runState === 'queued'
}
