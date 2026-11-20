import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Overview } from '../../../conversations/overview.ts'
import { Phases } from '../../../phase/server.ts'
import { Metadata } from '../../../../server/metadata.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, removeTemp, sourceCopy, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const hold = defineTask<null, { phase: 'hold' }, null>({
  name: 'plain-row-test.hold',
  version: 1,
  initial: () => ({ phase: 'hold' }),
  phases: {
    hold: (_task, runtime, caller) =>
      runtime.sleepUntil(Date.now() + 3_600_000, { phase: 'hold' }, caller),
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})

it('isolates plain-row status, title, phase, insertion and reorder renders without losing a draft rename', async () => {
  const home = await temp('sidebar-plain-rows-')
  cleanup.push(() => removeTemp(home))
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['phase'], disable: ['update'] } }),
  )
  const sourceRoot = await sourceCopy(home)
  const file = join(sourceRoot, 'extensions/sidebar/rows.tsx')
  const sourceText = await readFile(file, 'utf8')
  const marker = '  const hasActivity = !!(displayPhase || activity)'
  expect(sourceText).toContain(marker)
  await writeFile(
    file,
    sourceText.replace(
      marker,
      `  if (typeof document !== 'undefined') { const counts = JSON.parse(document.documentElement.dataset.plainRenders ?? '{}'); counts[conversation.id] = (counts[conversation.id] ?? 0) + 1; document.documentElement.dataset.plainRenders = JSON.stringify(counts) }\n${marker}`,
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
  server.host.registry.install({ name: 'plain-row-test', tasks: [hold] })
  const at = 1_700_000_000_000
  const ids = await server.harness.commit(async (tx) => {
    const result = []
    for (let index = 0; index < 12; index++) {
      const record = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      ;(await tx.doc(Metadata, record.id)).title = `Synthetic flat ${index}`
      ;(await tx.doc(Metadata, record.id)).inputAt = at + index
      result.push(record.id)
    }
    return result
  }, context)
  await server.harness.commit(async (tx) => {
    for (const id of [ids[6], ids[7]]) {
      await tx.createTask(hold, null, { ownership: { kind: 'conversation' }, conversationId: id })
      ;(await tx.doc(Phases, ROOT_CONVERSATION_ID)).conversations[id] = { phase: 'editing' }
    }
  }, context)
  await until(() => server.api.conversations().some((row) => row.id === ids.at(-1)))
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await page.clock.install({ time: new Date(Date.UTC(2025, 0, 1)) })
  await page.addInitScript(() => sessionStorage.setItem('ultimate.driven', '1'))
  await page.goto(`${server.url}/?conversation=${ids[0]}`)
  await until(
    async () =>
      (await page.evaluate<{ shown: number }>('window.ultimate.state()')).shown === ids[0],
  )
  await page.getByRole('button', { name: /^Earlier/ }).click()
  const region = page.getByRole('region', { name: 'Earlier' })
  const row = (id: number) => region.locator(`[data-conversation="${id}"]`)
  await row(ids[0])
    .getByRole('button', { name: /Synthetic flat 0/ })
    .waitFor()
  const counts = async (): Promise<Record<string, number>> =>
    JSON.parse((await page.locator('html').getAttribute('data-plain-renders')) ?? '{}')
  const changed = (before: Record<string, number>, after: Record<string, number>) =>
    ids.filter((id) => before[id] !== after[id])
  await row(ids[6]).getByText('Editing', { exact: true }).waitFor()
  await row(ids[7]).getByText('Editing', { exact: true }).waitFor()
  const before = await counts()
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Overview, ROOT_CONVERSATION_ID)).conversations[ids[1]] = { runState: 'error' }
  }, context)
  await row(ids[1]).getByRole('img', { name: 'Its latest run failed' }).waitFor()
  const afterStatus = await counts()
  console.log({ mountedRows: ids.length, statusChangedRows: changed(before, afterStatus).length })
  expect(changed(before, afterStatus)).toEqual([ids[1]])
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, ids[2])).title = 'Changed flat title'
  }, context)
  await row(ids[2]).getByText('Changed flat title', { exact: true }).waitFor()
  const afterTitle = await counts()
  expect(changed(afterStatus, afterTitle)).toEqual([ids[2]])
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Phases, ROOT_CONVERSATION_ID)).conversations[ids[6]].phase = 'verifying'
  }, context)
  await row(ids[6]).getByText('Verifying', { exact: true }).waitFor()
  const afterPhase = await counts()
  expect(changed(afterTitle, afterPhase)).toEqual([ids[6]])
  const added = await server.harness.commit(async (tx) => {
    const record = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    ;(await tx.doc(Metadata, record.id)).title = 'Added flat row'
    ;(await tx.doc(Metadata, record.id)).inputAt = at + 10_000
    return record.id
  }, context)
  await row(added).getByText('Added flat row', { exact: true }).waitFor()
  const afterInsert = await counts()
  expect(afterInsert[added]).toBeGreaterThan(0)
  expect(changed(afterPhase, afterInsert)).toEqual([])
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, ids[3])).inputAt = at + 5000
  }, context)
  await until(
    async () =>
      (await region.locator('[data-conversation]').nth(1).getAttribute('data-conversation')) ===
      String(ids[3]),
  )
  const afterReorder = await counts()
  expect(changed(afterInsert, afterReorder)).toEqual([ids[3]])
  expect(
    await region.locator('[data-conversation]').first().getAttribute('data-conversation'),
  ).toBe(String(added))
  console.log({
    titleChangedRows: changed(afterStatus, afterTitle).length,
    phaseChangedRows: changed(afterTitle, afterPhase).length,
    existingRowsRenderedForInsert: changed(afterPhase, afterInsert).length,
    reorderChangedRows: changed(afterInsert, afterReorder).length,
  })
  await row(ids[0]).getByText('Synthetic flat 0', { exact: true }).dblclick()
  const title = page.getByRole('textbox', { name: 'Conversation title' })
  await title.fill('Unfinished plain title')
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Overview, ROOT_CONVERSATION_ID)).conversations[ids[0]] = { runState: 'working' }
  }, context)
  await row(ids[0]).getByRole('img', { name: 'Working', exact: true }).waitFor()
  expect(await title.inputValue()).toBe('Unfinished plain title')
})
