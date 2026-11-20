import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SubagentWindow } from '../../subagent-window.tsx'

it('bounds the initial rows and keeps an offscreen selection mounted with spacer space', () => {
  const rows = Array.from({ length: 1100 }, (_, index) => ({
    id: index + 1,
    content: createElement('button', null, `Worker ${index + 1}`),
  }))
  const html = renderToStaticMarkup(createElement(SubagentWindow, { rows, shownId: 550 }))
  expect(html.match(/<button/g)!.length).toBeLessThan(12)
  expect(html).toContain('Worker 1<')
  expect(html).toContain('Worker 550<')
  expect(html).toContain('Worker 1100<')
  expect(html).not.toContain('Worker 900<')
  expect(html).toContain('aria-hidden="true" style="height:')
  expect(html).toContain('role="list"')
  expect(html).toContain('aria-posinset="550" aria-setsize="1100"')
})
