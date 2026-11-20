import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Roots } from '../../../lineage/api.ts'
import { Overview } from '../../../conversations/overview.ts'
import { Started } from '../../../messages/addresses.ts'
import { Metadata } from '../../../../server/metadata.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, removeTemp, sourceCopy, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('renders only the affected flight header and preserves editing when a working phase mounts', async () => {
  const home = await temp('sidebar-rows-')
  cleanup.push(() => removeTemp(home))
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['update'] } }),
  )
  const sourceRoot = await sourceCopy(home)
  const file = join(sourceRoot, 'extensions/sidebar/root.tsx')
  const sourceText = await readFile(file, 'utf8')
  expect(sourceText).toContain('  const cancelled = useRef(false)')
  await writeFile(
    file,
    sourceText.replace(
      '  const cancelled = useRef(false)',
      `  if (typeof document !== 'undefined') { const counts = JSON.parse(document.documentElement.dataset.flightRenders ?? '{}'); counts[conversation.id] = (counts[conversation.id] ?? 0) + 1; document.documentElement.dataset.flightRenders = JSON.stringify(counts) }\n  const cancelled = useRef(false)`,
    ),
  )
  const server = await fauxServer({
    ultimateRoot: sourceRoot,
    projectRoot: sourceRoot,
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const source = await server.harness.commit(async (tx) => {
    const root = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots[0]
    return { root, at: (await tx.appendEntry(root, { kind: 'test.point', data: {} })).id }
  }, context)
  const branches = await server.harness.commit(async (tx) => {
    const ids = []
    for (let index = 0; index < 12; index++) {
      const record = await tx.forkConversation(source.root, source.at, {
        ownership: { kind: 'ownerless' },
      })
      ;(await tx.doc(Metadata, record.id)).title = `Synthetic branch ${index}`
      ;(await tx.doc(Metadata, record.id)).inputAt = 1_700_000_000_000
      ;(await tx.doc(Started, record.id)).by = source.root
      ids.push(record.id)
    }
    return ids
  }, context)
  await until(() => server.api.conversations().some((row) => row.id === branches.at(-1)))
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.clock.install({ time: new Date(Date.UTC(2025, 0, 1)) })
  await page.goto(`${server.url}/?conversation=${branches[0]}`)
  const row = (index: number) => page.locator(`[data-in-flight="${branches[index]}"]`)
  await until(
    async () =>
      (await page.locator(`[data-in-flight] [title="waits on #${source.root}"]`).count()) ===
      branches.length,
  )
  const counts = async (): Promise<Record<string, number>> =>
    JSON.parse((await page.locator('html').getAttribute('data-flight-renders')) ?? '{}')
  const before = await counts()
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Overview, ROOT_CONVERSATION_ID)).conversations[branches[1]] = {
      runState: 'error',
    }
  }, context)
  await row(1).locator('[title="failed"]').waitFor()
  const afterStatus = await counts()
  console.log({
    statusChangedRows: branches.filter((id) => afterStatus[id] !== before[id]).length,
    mountedRows: branches.length,
  })
  expect(afterStatus[branches[1]]).toBeGreaterThan(before[branches[1]])
  expect(branches.filter((id) => afterStatus[id] !== before[id])).toEqual([branches[1]])
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, branches[2])).title = 'Changed title'
  }, context)
  await row(2).getByText('Changed title', { exact: true }).waitFor()
  const afterTitle = await counts()
  expect(branches.filter((id) => afterTitle[id] !== afterStatus[id])).toEqual([branches[2]])
  console.log({
    statusChangedRows: branches.filter((id) => afterStatus[id] !== before[id]).length,
    titleChangedRows: branches.filter((id) => afterTitle[id] !== afterStatus[id]).length,
    mountedRows: branches.length,
  })
  await row(0).focus()
  await page
    .locator('li')
    .filter({ has: row(0) })
    .getByRole('button', { name: 'Conversation actions' })
    .click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const title = page.getByRole('textbox', { name: 'Conversation title' })
  await title.fill('Unfinished title')
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Overview, ROOT_CONVERSATION_ID)).conversations[branches[0]] = {
      runState: 'working',
    }
  }, context)
  await row(0).locator('[title="working"]').waitFor()
  expect(await title.inputValue()).toBe('Unfinished title')
})
