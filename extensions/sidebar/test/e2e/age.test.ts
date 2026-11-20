import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Roots } from '../../../lineage/api.ts'
import { Started } from '../../../messages/addresses.ts'
import { Messages } from '../../../messages/api.ts'
import { Metadata } from '../../../../server/metadata.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, removeTemp, sourceCopy, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('retains a mounted branch age across status renders and refreshes it for timestamps and clock ticks', async () => {
  const home = await temp('sidebar-age-')
  cleanup.push(() => removeTemp(home))
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['update'] } }),
  )
  const at = Date.UTC(2023, 10, 23)
  const sourceRoot = await sourceCopy(home)
  const agoFile = join(sourceRoot, 'lib/ago.ts')
  const sourceText = await readFile(agoFile, 'utf8')
  expect(sourceText).toContain('  const minutes =')
  await writeFile(
    agoFile,
    sourceText.replace(
      '  const minutes =',
      `  if (typeof document !== 'undefined' && (at === ${at} || at === ${at + 1})) document.documentElement.dataset.ageCalls = String(Number(document.documentElement.dataset.ageCalls ?? 0) + 1)\n  const minutes =`,
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
    return { root, entry: (await tx.appendEntry(root, { kind: 'test.point', data: {} })).id }
  }, context)
  const branches = await server.harness.commit(async (tx) => {
    const ids = []
    for (let index = 0; index < 12; index++) {
      const row = await tx.forkConversation(source.root, source.entry, {
        ownership: { kind: 'ownerless' },
      })
      ;(await tx.doc(Metadata, row.id)).title = `Synthetic branch ${index}`
      ;(await tx.doc(Metadata, row.id)).inputAt = at
      ;(await tx.doc(Started, row.id)).by = source.root
      ids.push(row.id)
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
  await page.clock.install({ time: new Date(Date.UTC(2025, 0, 1, 12)) })
  await page.goto(`${server.url}/?conversation=${branches[0]}`)
  const row = page.locator(`[data-in-flight="${branches[0]}"]`)
  await row.locator(`[title="waits on #${source.root}"]`).waitFor()
  const calls = () => page.locator('html').getAttribute('data-age-calls').then(Number)
  const before = await calls()
  expect(before).toBeGreaterThanOrEqual(branches.length)
  for (let index = 0; index < 20; index++) {
    const target = index % 2 === 0 ? branches[1] : source.root
    await server.harness.commit(async (tx) => {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
      log.messages = [
        {
          id: 1,
          from: branches[0],
          to: target,
          reply: true,
          state: 'delivered',
          text: 'Synthetic request',
          at: 1,
        },
      ]
    }, context)
    await row.locator(`[title="waits on #${target}"]`).waitFor()
  }
  const afterStatus = await calls()
  console.log({ mountedBranches: branches.length, statusUpdates: 20, before, afterStatus })
  expect(afterStatus).toBe(before)
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, branches[0])).inputAt = at + 1
  }, context)
  await until(async () => (await calls()) === before + 1)
  await page.clock.fastForward(60_000)
  await until(async () => (await calls()) >= before + 1 + branches.length)
})
