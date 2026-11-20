import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, post, removeTemp, sourceCopy, temp } from '../../../../test/helpers.ts'
import { Workspaces } from '../../workspaces.ts'
import type { Workspace, WorkspaceIndex } from '../../types.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('selects workspace fields and items without rerendering on unrelated changes', async () => {
  const home = await temp('workspace-selectors-')
  cleanup.push(() => removeTemp(home))
  const root = await sourceCopy(home)
  const project = join(home, 'project')
  const extension = join(project, '.ultimate/extensions/workspace-probe')
  await mkdir(extension, { recursive: true })
  await writeFile(
    join(project, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'faux/faux-1', extensions: { disable: ['update'] } }),
  )
  await writeFile(
    join(extension, 'web.tsx'),
    `import { memo, useState } from 'react'
import { defineWebExtension, useConversation } from '@/sdk'
import { useWorkspace, useWorkspaceConversations, useWorkspaceIndex, useWorkspaces, useLanderQueue } from ${JSON.stringify(join(root, 'extensions/workspaces/data.tsx'))}
const renders = { items: 0, selected: 0, conversations: 0, queue: 0 }
let joined
window.workspaceProbe = () => ({ ...renders, joined })
const Items = memo(function Items() {
  const items = useWorkspaces()
  renders.items++
  return <output>{Object.keys(items).length}</output>
})
const Selected = memo(function Selected() {
  const id = useConversation(conversation => conversation.id)
  const workspace = useWorkspace(id)
  renders.selected++
  return <output data-probe="selected">{workspace?.path}</output>
})
const Joined = memo(function Joined() {
  joined = useWorkspaceConversations()
  const [tick, setTick] = useState(0)
  renders.conversations++
  return <button onClick={() => setTick(tick + 1)}>Join {tick}</button>
})
const Queue = memo(function Queue() {
  const queue = useLanderQueue()
  renders.queue++
  return <output>{queue.length}</output>
})
function Received() {
  const index = useWorkspaceIndex()
  return <output data-probe="received">{Object.keys(index.results).length}:{index.queue.length}:{Object.values(index.items).map(workspace => workspace.path).join(':')}</output>
}
export default defineWebExtension({ surfaces: [{ id: 'workspace-probe', title: 'Workspace probe', icon: () => null, component: () => <><Items /><Selected /><Joined /><Queue /><Received /></> }] })
`,
  )
  const server = await fauxServer({
    ultimateRoot: root,
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const id = (await post(server, '/api/conversations', {})).data.id as ConversationId
  const other = (await post(server, '/api/conversations', {})).data.id as ConversationId
  const workspace = (path: string): Workspace => ({
    path,
    branch: 'sample',
    base: 'main',
    source: project,
    target: 'main',
    state: 'removed',
  })
  const update = (change: (index: WorkspaceIndex) => void) =>
    server.harness.commit(async (tx) => {
      change(await tx.doc(Workspaces, ROOT_CONVERSATION_ID))
    }, context)
  await update((index) => {
    index.items[String(id)] = workspace('selected')
    index.items[String(other)] = workspace('other')
  })
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${server.url}/?conversation=${id}`)
  await page.locator('[data-surface="workspace-probe"]').click()
  const received = page.locator('[data-probe="received"]')
  await received.filter({ hasText: /^0:0:selected:other$/ }).waitFor()
  const counts = () =>
    page.evaluate(() => {
      const probe = window as typeof window & {
        workspaceProbe: () => {
          items: number
          selected: number
          conversations: number
          queue: number
          joined: unknown
        }
      }
      const { joined: _joined, ...renders } = probe.workspaceProbe()
      return renders
    })
  const initial = await counts()
  await update((index) => {
    index.results.sample = {
      outcome: 'failed',
      target: 'main',
      tip: 'sample',
      lander: id,
      steps: [],
      at: 0 as EntryId,
      divergence: 'None',
    }
  })
  await received.filter({ hasText: /^1:0:selected:other$/ }).waitFor()
  expect(await counts()).toEqual(initial)
  await update((index) => {
    index.queue.push({
      id: 'sample',
      conversationId: id,
      source: project,
      target: 'main',
      tip: 'sample',
      at: 0 as EntryId,
      divergence: 'None',
      state: 'queued',
      steps: [],
    })
  })
  await received.filter({ hasText: /^1:1:selected:other$/ }).waitFor()
  expect(await counts()).toEqual({ ...initial, queue: initial.queue + 1 })
  await update((index) => {
    index.items[String(other)].path = 'other-updated'
  })
  await received.filter({ hasText: /^1:1:selected:other-updated$/ }).waitFor()
  expect(await counts()).toEqual({
    items: initial.items + 1,
    selected: initial.selected,
    conversations: initial.conversations + 1,
    queue: initial.queue + 1,
  })
  await update((index) => {
    index.items[String(id)].path = 'selected-updated'
  })
  await received.filter({ hasText: /^1:1:selected-updated:other-updated$/ }).waitFor()
  expect(await counts()).toEqual({
    items: initial.items + 2,
    selected: initial.selected + 1,
    conversations: initial.conversations + 2,
    queue: initial.queue + 1,
  })
  expect(await page.locator('[data-probe="selected"]').textContent()).toBe('selected-updated')
  await page.evaluate(() => {
    const probe = window as typeof window & {
      workspaceProbe: () => { joined: unknown }
      initialJoin: unknown
    }
    probe.initialJoin = probe.workspaceProbe().joined
  })
  await page.getByRole('button', { name: 'Join 0', exact: true }).click()
  await page.getByRole('button', { name: 'Join 1', exact: true }).waitFor()
  expect(
    await page.evaluate(() => {
      const probe = window as typeof window & {
        workspaceProbe: () => { joined: unknown }
        initialJoin: unknown
      }
      return probe.workspaceProbe().joined === probe.initialJoin
    }),
  ).toBe(true)
  expect(errors).toEqual([])
})
