import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Roots } from '../../../lineage/api.ts'
import { TaskIndex } from '../../../plan/server.ts'
import { Metadata } from '../../../../server/metadata.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, removeTemp, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
const work = defineTask<null, { phase: 'hold' }, null>({
  name: 'sidebar-window.work',
  version: 1,
  initial: () => ({ phase: 'hold' }),
  phases: {
    hold: (_task, runtime, caller) =>
      runtime.sleepUntil(Date.now() + 3_600_000, { phase: 'hold' }, caller),
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})

it('bounds active rows, preserves forward Tab and leaves the global Shift+Tab shortcut unchanged', async () => {
  const home = await temp('sidebar-window-')
  cleanup.push(() => removeTemp(home))
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['update'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  server.host.registry.install({ name: 'sidebar-window', tasks: [work] })
  const { root, at } = await server.harness.commit(async (tx) => {
    const source = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots[0]
    return { root: source, at: (await tx.appendEntry(source, { kind: 'test.point', data: {} })).id }
  }, context)
  const branch = await server.harness.commit(async (tx) => {
    const record = await tx.forkConversation(root, at, { ownership: { kind: 'ownerless' } })
    ;(await tx.doc(Metadata, record.id)).title = 'Synthetic active branch'
    return record.id
  }, context)
  const children = await server.harness.commit(async (tx) => {
    const ids = []
    for (let index = 0; index < 160; index++) {
      const owner = await tx.createTask(work, null, {
        ownership: { kind: 'conversation' },
        conversationId: index === 1 ? ids[0] : branch,
      })
      const record = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
      ;(await tx.doc(Metadata, record.id)).label = `worker ${index}`
      ids.push(record.id)
    }
    return ids
  }, context)
  await server.harness.commit(async (tx) => {
    const tasks = await tx.doc(TaskIndex, ROOT_CONVERSATION_ID)
    for (const [index, id] of children.entries()) {
      if (index % 2 !== 0) continue
      tasks.children[String(id)] = {
        coordinator: branch,
        epic: 'E1',
        key: `E1.${index + 1}`,
        title: `Synthetic task ${index}`,
        status: 'in_progress',
      }
    }
  }, context)
  await until(() => server.api.conversations().some((row) => row.id === children.at(-1)))
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${server.url}/?conversation=${branch}`)
  const window = page.locator('[data-subagent-window]')
  await window.waitFor()
  const rows = window.locator('[data-child-conversation]')
  expect(await rows.count()).toBeLessThan(50)
  const row = (index: number) => page.locator(`[data-child-conversation="${children[index]}"]`)
  const scrollTo = async (index: number) => {
    await window.evaluate((node, target) => {
      let viewport = node.parentElement!
      while (!/(auto|scroll)/.test(getComputedStyle(viewport).overflowY))
        viewport = viewport.parentElement!
      const top =
        node.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
      viewport.scrollTop =
        top +
        target * 1.75 * parseFloat(getComputedStyle(document.documentElement).fontSize) -
        viewport.clientHeight / 2
    }, index)
    await until(async () => {
      const box = await row(index).boundingBox()
      return box !== null && box.y >= 0 && box.y < 850
    })
  }
  for (const index of [159, 80, 0]) {
    await scrollTo(index)
    expect(await rows.count()).toBeLessThan(50)
  }
  await row(0).focus()
  expect(await row(1).evaluate((node) => getComputedStyle(node).paddingLeft)).toBe('32px')
  const focus = () =>
    page.evaluate(() =>
      document.activeElement?.hasAttribute('data-task')
        ? `task:${document.activeElement.getAttribute('data-task')}`
        : `row:${document.activeElement?.getAttribute('data-child-conversation')}`,
    )
  const unchangedShiftTab = async () => {
    const before = await focus()
    await page.evaluate(() => {
      delete document.documentElement.dataset.shiftTabPrevented
      const capture = (event: KeyboardEvent) => {
        if (event.key !== 'Tab' || !event.shiftKey) return
        document.documentElement.dataset.shiftTabPrevented = String(event.defaultPrevented)
        document.removeEventListener('keydown', capture)
      }
      document.addEventListener('keydown', capture)
    })
    await page.keyboard.press('Shift+Tab')
    expect(await page.locator('html').getAttribute('data-shift-tab-prevented')).toBe('true')
    expect(await focus()).toBe(before)
  }
  await unchangedShiftTab()
  await page.keyboard.press('Tab')
  await unchangedShiftTab()
  await row(0).focus()
  await row(1).evaluate((node) => {
    node.parentElement!.style.height = '1.75rem'
    node.style.display = 'none'
  })
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  expect(await focus()).toBe(`row:${children[2]}`)
  await row(1).evaluate((node) => {
    node.parentElement!.style.height = ''
    node.style.display = ''
  })
  await row(0).focus()
  const sequence = children.flatMap((id, index) => [
    `row:${id}`,
    ...(index % 2 === 0 ? [`task:E1.${index + 1}`] : []),
  ])
  const forward = [await focus()]
  for (let index = 1; index < children.length; index++) {
    if ((index - 1) % 2 === 0) {
      await page.keyboard.press('Tab')
      forward.push(await focus())
    }
    await page.keyboard.press('Tab')
    forward.push(await focus())
    expect(await rows.count()).toBeLessThan(50)
  }
  expect(forward).toEqual(sequence)
  await page.keyboard.press('Tab')
  expect(await window.evaluate((node) => node.contains(document.activeElement))).toBe(false)
  await row(0).focus()
  for (let index = 1; index <= 80; index++) {
    if ((index - 1) % 2 === 0) await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
  }
  await page.keyboard.press('Enter')
  await page.locator(`[data-child-conversation="${children[80]}"][aria-current="true"]`).waitFor()
  expect(await row(80).isVisible()).toBe(true)
  const bounds = await row(80).boundingBox()
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeLessThan(900)
  expect(await rows.count()).toBeLessThan(50)
  await row(80).focus()
  await scrollTo(0)
  expect(await row(80).count()).toBe(1)
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('data-child-conversation')),
  ).toBe(String(children[80]))
  const before = await window.evaluate((node) => {
    let viewport = node.parentElement!
    while (!/(auto|scroll)/.test(getComputedStyle(viewport).overflowY))
      viewport = viewport.parentElement!
    return viewport.scrollTop
  })
  await server.harness.commit(async (tx) => {
    const owner = await tx.createTask(work, null, {
      ownership: { kind: 'conversation' },
      conversationId: children[0],
    })
    const extra = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
    ;(await tx.doc(Metadata, extra.id)).label = 'new grandchild'
  }, context)
  await window.locator('[role="listitem"][aria-setsize="161"]').first().waitFor()
  expect(
    await window.evaluate((node) => {
      let viewport = node.parentElement!
      while (!/(auto|scroll)/.test(getComputedStyle(viewport).overflowY))
        viewport = viewport.parentElement!
      return viewport.scrollTop
    }),
  ).toBe(before)
  expect(
    await window.locator(`[data-subagent-id="${children[80]}"]`).getAttribute('aria-posinset'),
  ).toBe('82')
  const linked = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await linked.goto(`${server.url}/?conversation=${children[80]}`)
  const selectedRow = linked.locator(
    `[data-child-conversation="${children[80]}"][aria-current="true"]`,
  )
  await selectedRow.waitFor()
  const linkedBounds = await selectedRow.boundingBox()
  expect(linkedBounds!.y).toBeGreaterThanOrEqual(0)
  expect(linkedBounds!.y).toBeLessThan(900)
  expect(errors).toEqual([])
})
