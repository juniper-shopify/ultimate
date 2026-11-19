import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'

export const subagentLineHeightRem = 1.75

const overscan = 6

const tabStops = (row: Element) =>
  [
    ...row.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable]',
    ),
  ].filter(
    (node) =>
      (node.tabIndex >= 0 || (node.isContentEditable && !node.hasAttribute('tabindex'))) &&
      !node.matches(':disabled') &&
      node.getClientRects().length > 0,
  )

export function SubagentWindow({
  rows,
  shownId,
}: {
  rows: readonly { id: number; content: ReactNode }[]
  shownId?: number
}) {
  const element = useRef<HTMLDivElement>(null)
  const measure = useRef<(() => void) | undefined>(undefined)
  const selection = useRef<{ id?: number; scrolled: boolean }>({ scrolled: false })
  const [range, setRange] = useState({ start: 0, end: overscan })
  const [focused, setFocused] = useState<number>()
  const selected = rows.findIndex((row) => row.id === shownId)
  const focusedIndex = rows.findIndex((row) => row.id === focused)
  const count = rows.length
  useLayoutEffect(() => {
    const node = element.current
    if (!node) return undefined
    let scroller = node.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement
    if (!scroller) return undefined
    const viewport = scroller
    const update = () => {
      const height =
        subagentLineHeightRem * parseFloat(getComputedStyle(document.documentElement).fontSize)
      const top = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      const start = Math.min(count, Math.max(0, Math.floor(-top / height) - overscan))
      const end = Math.min(
        count,
        Math.max(start, Math.ceil((viewport.clientHeight - top) / height) + overscan),
      )
      setRange((previous) =>
        previous.start === start && previous.end === end ? previous : { start, end },
      )
    }
    measure.current = update
    update()
    viewport.addEventListener('scroll', update, { passive: true })
    const resize = new ResizeObserver(update)
    resize.observe(viewport)
    resize.observe(node)
    return () => {
      viewport.removeEventListener('scroll', update)
      resize.disconnect()
      measure.current = undefined
    }
  }, [count])
  useLayoutEffect(() => measure.current?.(), [rows])
  useLayoutEffect(() => {
    if (selection.current.id !== shownId) selection.current = { id: shownId, scrolled: false }
    if (selected < 0 || selection.current.scrolled) return
    const row = element.current?.querySelector<HTMLElement>(`[data-subagent-index="${selected}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'nearest' })
    selection.current.scrolled = true
  }, [shownId, selected])
  const indexes = new Set<number>([0, count - 1])
  for (let index = range.start; index < Math.min(count, range.end); index++) indexes.add(index)
  if (selected >= 0) indexes.add(selected)
  if (focusedIndex >= 0) indexes.add(focusedIndex)
  const mounted = [...indexes]
    .filter((index) => index >= 0 && index < count)
    .toSorted((a, b) => a - b)
  return (
    <div
      ref={element}
      data-subagent-window
      role="list"
      aria-label="Subagents"
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-subagent-index]')
        if (row) setFocused(Number(row.dataset.subagentId))
      }}
      onKeyDown={(event) => {
        if (
          event.key !== 'Tab' ||
          event.shiftKey ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.defaultPrevented
        )
          return
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-subagent-index]')
        if (!row) return
        const stops = tabStops(row)
        if (event.target !== stops.at(-1)) return
        const next = Number(row.dataset.subagentIndex) + 1
        if (next < 0 || next >= count) return
        flushSync(() => setFocused(rows[next].id))
        const nextRow = element.current?.querySelector<HTMLElement>(
          `[data-subagent-id="${rows[next].id}"]`,
        )
        const target = nextRow && tabStops(nextRow)[0]
        if (!target) return
        event.preventDefault()
        target.focus()
      }}
    >
      {mounted.map((index, position) => {
        const gap = index - (mounted[position - 1] ?? -1) - 1
        return (
          <div key={rows[index].id}>
            {gap > 0 && <div aria-hidden style={{ height: `${gap * subagentLineHeightRem}rem` }} />}
            <div
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={count}
              data-subagent-index={index}
              data-subagent-id={rows[index].id}
            >
              {rows[index].content}
            </div>
          </div>
        )
      })}
    </div>
  )
}
