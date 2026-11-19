import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Roots } from '../../extensions/lineage/api.ts'
import { Started } from '../../extensions/messages/addresses.ts'
import { Metadata } from '../../server/metadata.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, removeTemp, sourceCopy, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('keeps a settled synthetic sidebar byte-identical with bounded and unbounded subscription dispatch', async () => {
  const home = await temp('subscription-visual-')
  cleanup.push(() => removeTemp(home))
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['update'] } }),
  )
  const root = await sourceCopy(home)
  const storeFile = join(root, 'web/src/sdk/store.ts')
  const bounded = await readFile(storeFile, 'utf8')
  expect(bounded).toContain('const backgroundSubscriptionRequestLimit = 4')
  await writeFile(
    storeFile,
    bounded.replace(
      'const backgroundSubscriptionRequestLimit = 4',
      'const backgroundSubscriptionRequestLimit = 10000',
    ),
  )
  const clientFile = join(root, 'web/src/sdk/client.ts')
  await writeFile(
    clientFile,
    (await readFile(clientFile, 'utf8')) + '\nObject.assign(window, { visualStore: store })\n',
  )
  const server = await fauxServer({
    ultimateRoot: root,
    projectRoot: root,
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const source = await server.harness.commit(async (tx) => {
    const rootId = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots[0]
    return { id: rootId, at: (await tx.appendEntry(rootId, { kind: 'test.point', data: {} })).id }
  }, context)
  const ids = await server.harness.commit(async (tx) => {
    const result = []
    for (let index = 0; index < 12; index++) {
      const conversation = await tx.forkConversation(source.id, source.at, {
        ownership: { kind: 'ownerless' },
      })
      Object.assign(await tx.doc(Metadata, conversation.id), {
        title: `Synthetic branch ${index}`,
        inputAt: 1_700_000_000_000,
      })
      ;(await tx.doc(Started, conversation.id)).by = source.id
      result.push(conversation.id)
    }
    return result
  }, context)
  await until(() => server.api.conversations().some((row) => row.id === ids.at(-1)))
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  })
  cleanup.push(() => browser.close())
  const screenshots: Buffer[] = []
  for (const name of ['before', 'after']) {
    if (name === 'after') await writeFile(storeFile, bounded)
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    )
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.clock.install({ time: new Date(Date.UTC(2025, 0, 1)) })
    await page.goto(`${server.url}/?conversation=${ids[0]}`)
    await page.waitForFunction(
      (conversations) =>
        conversations.every((id) => {
          const docs = (
            window as unknown as {
              visualStore?: { getState(): { docsOf: Record<number, Record<string, unknown>> } }
            }
          ).visualStore?.getState().docsOf[id]
          return docs?.['board.started'] && docs['ultimate.plan'] && docs['ultimate.plan.progress']
        }),
      ids,
    )
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
        ),
    )
    expect(errors).toEqual([])
    const image = await page.screenshot({ clip: { x: 0, y: 180, width: 288, height: 660 } })
    screenshots.push(image)
    if (process.env.SUBSCRIPTION_VISUAL_OUTPUT) {
      await mkdir(process.env.SUBSCRIPTION_VISUAL_OUTPUT, { recursive: true })
      await writeFile(join(process.env.SUBSCRIPTION_VISUAL_OUTPUT, `${name}.png`), image)
    }
    await page.close()
  }
  expect(screenshots[1].equals(screenshots[0])).toBe(true)
})
