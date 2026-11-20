import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Started } from '../../../messages/addresses.ts'
import { Roots } from '../../../lineage/api.ts'
import { Metadata } from '../../../../server/metadata.ts'
import { context } from '../../../../server/harness.ts'
import { UiState } from '../../../../shared/ui-state.ts'
import { fauxServer, removeTemp, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('does not watch concluded starters even while their history rows are mounted', async () => {
  const home = await temp('sidebar-starters-')
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
  const branchCount = 1100 - server.api.conversations().length
  const { root, at } = await server.harness.commit(async (tx) => {
    const source = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots[0]
    return { root: source, at: (await tx.appendEntry(source, { kind: 'test.point', data: {} })).id }
  }, context)
  const branches = await server.harness.commit(async (tx) => {
    const ids = []
    for (let index = 0; index < branchCount; index++) {
      const branch = await tx.forkConversation(root, at, { ownership: { kind: 'ownerless' } })
      ;(await tx.doc(Metadata, branch.id)).title = `Synthetic branch ${index}`
      ;(await tx.doc(Started, branch.id)).by = root
      ids.push(branch.id)
    }
    return ids
  }, context)
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded'] =
      branches.slice(99)
  }, context)
  await until(() => server.api.conversations().some((row) => row.id === branches.at(-1)))
  expect(server.api.conversations()).toHaveLength(1100)
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const subscriptions = new Map<string, number>()
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!/^\/api\/events\/[^/]+\/\d+$/.test(url.pathname)) return
    const id = url.pathname.split('/').at(-1)!
    if (request.method() === 'DELETE') subscriptions.delete(id)
    if (request.method() !== 'POST') return
    const data = request.postDataJSON()
    if (data.docs?.includes('board.started')) subscriptions.set(id, data.conversation)
  })
  await page.goto(`${server.url}/?conversation=${branches[0]}`)
  await page.locator('[data-in-flight]').first().waitFor()
  const watched = () => new Set(subscriptions.values())
  await until(() => watched().size === 99)
  expect([...watched()].toSorted((a, b) => a - b)).toEqual(
    branches.slice(0, 99).toSorted((a, b) => a - b),
  )
  const concluded = page.getByRole('button', { name: `Concluded · ${branchCount - 99}` })
  await concluded.click()
  await page
    .getByRole('region', { name: 'Concluded' })
    .getByText(`Synthetic branch ${branchCount - 1}`, { exact: true })
    .waitFor()
  await page.evaluate(
    () =>
      new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
      ),
  )
  expect(watched().size).toBe(99)
  await concluded.click()
  await until(() => watched().size === 99)
  expect(watched().size).toBe(99)
  console.log({
    conversations: 1100,
    branches: branchCount,
    collapsed: 99,
    expanded: 99,
    recollapsed: 99,
  })
})
