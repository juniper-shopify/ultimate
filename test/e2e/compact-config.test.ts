import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, sourceCopy, temp } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
const counter = (kind: string) =>
  defineDoc({
    kind,
    version: 1,
    checkpointWhen: () => false,
    scope: 'conversation',
    history: 'latest',
    fork: 'initial',
    initial: () => ({ n: 0 }),
  })
const Declared = counter('test.compact')
const Unrelated = counter('test.unrelated')

it('only rerenders compact grouping when a declared root document changes', async () => {
  const home = await temp('compact-config-')
  cleanup.push(() => removeTemp(home))
  const root = await sourceCopy(home)
  const project = join(home, 'project')
  const extension = join(project, '.ultimate/extensions/compact-probe')
  await mkdir(extension, { recursive: true })
  await writeFile(
    join(project, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'faux/faux-1', extensions: { disable: ['update'] } }),
  )
  await writeFile(
    join(extension, 'server.ts'),
    `import { defineDoc } from '@earendil-works/pi-durable'
const counter = kind => defineDoc({ kind, version: 1, checkpointWhen: () => false, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ n: 0 }) })
export const docs = [counter('test.compact'), counter('test.unrelated')]
export default { name: 'compact-probe' }
`,
  )
  await writeFile(
    join(extension, 'web.tsx'),
    `import { memo } from 'react'
import { defineWebExtension, docRef, ROOT, useCompact, useDocOf } from '@/sdk'
import { useCompactThread } from ${JSON.stringify(join(root, 'web/src/sdk/hooks.ts'))}
let docs, renders = 0
const Probe = memo(function Probe() {
  const compact = useCompact(), thread = useCompactThread()
  window.compactProbe = { renders: ++renders, docs, compact, thread }
  return <output data-probe="grouping">{docs?.['test.compact']?.n ?? 0}</output>
})
function Received() {
  const declared = useDocOf(ROOT, docRef('test.compact'))
  const unrelated = useDocOf(ROOT, docRef('test.unrelated'))
  return <output data-probe="received">{declared && unrelated ? declared.n + ':' + unrelated.n : 'loading'}</output>
}
export default defineWebExtension({
  compact: { docs: ['test.compact'], when: (_conversation, value) => { docs = value; return true }, tools: ['read'], thread: () => true },
  surfaces: [{ id: 'compact-probe', title: 'Compact probe', icon: () => null, component: () => <><Probe /><Received /></> }],
})
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
  const id = (await post(server, '/api/conversations', {})).data.id
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
  await page.locator('[data-surface="compact-probe"]').click()
  const received = page.locator('[data-probe="received"]')
  await received.filter({ hasText: /^0:0$/ }).waitFor()
  await page.evaluate(() => {
    const probe = window as typeof window & { compactProbe: object; initialProbe: object }
    probe.initialProbe = probe.compactProbe
  })
  const update = async (doc: typeof Declared) =>
    server.harness.commit(async (tx) => {
      ;(await tx.doc(doc, ROOT_CONVERSATION_ID)).n++
    }, context)
  const compare = () =>
    page.evaluate(() => {
      type Probe = { renders: number; docs: object; compact: unknown; thread: { test: unknown } }
      const probe = window as typeof window & { compactProbe: Probe; initialProbe: Probe }
      const current = probe.compactProbe
      const initial = probe.initialProbe
      return {
        renders: current.renders - initial.renders,
        docs: current.docs === initial.docs,
        compact: current.compact === initial.compact,
        thread: current.thread.test === initial.thread.test,
      }
    })
  await update(Unrelated)
  await received.filter({ hasText: /^0:1$/ }).waitFor()
  expect(await compare()).toEqual({ renders: 0, docs: true, compact: true, thread: true })
  await update(Declared)
  await received.filter({ hasText: /^1:1$/ }).waitFor()
  expect(await compare()).toEqual({ renders: 1, docs: false, compact: false, thread: false })
  expect(await page.locator('[data-probe="grouping"]').textContent()).toBe('1')
  expect(errors).toEqual([])
})
