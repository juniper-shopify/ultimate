import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension, Harness } from '@earendil-works/pi-durable'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, expect, it, vi } from 'vitest'
import { compareExtensions } from '../lib/discovery.ts'
import { context, createHarnessSettings, prepareHarness } from '../server/harness.ts'
import type { PreparedHost } from '../server/harness.ts'
import { fixture, orderedSource } from './server-fixture.ts'
import { temp, until } from './helpers.ts'

afterEach(() => vi.restoreAllMocks())

const freshOrder = (host: PreparedHost) =>
  host.registry
    .snapshot()
    .installed()
    .toSorted((a, b) =>
      compareExtensions(
        {
          name: a.name,
          source: host.extensionSources.get(a.name) ?? 'builtin',
          order: host.extensionOrders.get(a.name),
        },
        {
          name: b.name,
          source: host.extensionSources.get(b.name) ?? 'builtin',
          order: host.extensionOrders.get(b.name),
        },
      ),
    )

it('reuses the sort across settings reads, isolates callers and follows order-only changes', async () => {
  const home = await temp()
  const host = await prepareHarness({
    ultimateRoot: home,
    home,
    userHome: home,
    faux: fauxProvider(),
  })
  host.registry.install(defineExtension({ name: 'alpha' }))
  host.registry.install(defineExtension({ name: 'beta' }))
  const open = vi.spyOn(Harness, 'open')
  const opened = await host.open(false)
  try {
    const settings = open.mock.calls.at(-1)![1].settings
    if (!settings || typeof settings === 'function')
      throw new Error('Expected host settings object')
    const reference = createHarnessSettings(
      host.settings,
      () => undefined,
      () => freshOrder(host),
    )
    expect(settings).toEqual(reference)
    const expected = freshOrder(host)
    const sort = vi.spyOn(Array.prototype, 'toSorted')
    const first = settings.extensions!
    expect(settings.extensions).toEqual(expected)
    expect(sort).not.toHaveBeenCalled()
    expect(Reflect.set(first, 'length', 0)).toBe(true)
    expect(settings.extensions).toEqual(expected)
    expect(sort).not.toHaveBeenCalled()
    sort.mockRestore()
    const snapshot = host.registry.snapshot()
    host.extensionOrders.set('beta', -10)
    expect(host.registry.snapshot()).toBe(snapshot)
    expect(settings).toEqual(reference)
    expect(settings.extensions![0].name).toBe('beta')
    host.extensionOrders.delete('beta')
    host.extensionSources.set('alpha', 'project')
    expect(host.registry.snapshot()).toBe(snapshot)
    expect(settings).toEqual(reference)
    expect(settings.extensions!.at(-1)!.name).toBe('alpha')
  } finally {
    await opened.close()
  }
})

it('keeps settings equal to a fresh sort through install, disable, enable, reorder and reload', async () => {
  const opening = vi.spyOn(Harness, 'open')
  const { server, options } = await fixture(false, {
    alpha: orderedSource('alpha', 10),
    beta: orderedSource('beta', 20),
  })
  const settingsBeforeResolution = opening.mock.calls.at(-1)![1].settings
  if (!settingsBeforeResolution || typeof settingsBeforeResolution === 'function')
    throw new Error('Expected host settings object')
  const reference = createHarnessSettings(
    server.host.settings,
    () => undefined,
    () => freshOrder(server.host),
  )
  const check = async () => {
    expect(settingsBeforeResolution).toEqual(reference)
    expect((await server.root.agent(context)).extensions).toEqual(reference.extensions)
  }
  await check()
  const directory = join(options.ultimateRoot, 'extensions/gamma')
  await mkdir(directory)
  await writeFile(join(directory, 'server.ts'), orderedSource('gamma', 30))
  await until(() => server.host.extensionOrders.get('gamma') === 30)
  await check()
  const settings = join(options.ultimateRoot, '.ultimate/settings.json')
  await writeFile(settings, JSON.stringify({ extensions: { disable: ['beta'] } }))
  server.vite.watcher.emit('change', settings)
  await until(() => !server.host.registry.snapshot().extension('beta'))
  await check()
  await writeFile(settings, '{}')
  server.vite.watcher.emit('change', settings)
  await until(() => server.host.extensionOrders.get('beta') === 20)
  await check()
  const alpha = join(options.ultimateRoot, 'extensions/alpha/server.ts')
  await writeFile(alpha, orderedSource('alpha', -10))
  server.vite.watcher.emit('change', alpha)
  await until(() => server.host.extensionOrders.get('alpha') === -10)
  await check()
  const before = server.host.registry.snapshot().extension('alpha')
  await writeFile(
    alpha,
    orderedSource('alpha', -10).replace("description: 'alpha'", "description: 'Reloaded tool'"),
  )
  server.vite.watcher.emit('change', alpha)
  await until(() => server.host.registry.snapshot().extension('alpha') !== before)
  await check()
  expect(
    (await server.root.agent(context)).tools.find((tool) => tool.name === 'alpha')?.description,
  ).toBe('Reloaded tool')
  await rm(directory, { recursive: true })
  await until(() => !server.host.registry.snapshot().extension('gamma'))
  await check()
})
