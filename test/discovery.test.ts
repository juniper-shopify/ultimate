import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { discoverExtensions } from '../lib/discovery.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    stat: vi.fn<typeof fs.stat>(fs.stat),
    realpath: vi.fn<typeof fs.realpath>(fs.realpath),
  }
})

it('reads independent directories concurrently with a bound and preserves override/core precedence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'extension-discovery-'))
  const root = join(home, 'repo')
  const project = join(home, 'project')
  const directory = join(root, 'extensions')
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const names = Array.from(
    { length: 20 },
    (_, index) => `extension-${String(index).padStart(2, '0')}`,
  )
  for (const name of names) {
    await mkdir(join(directory, name), { recursive: true })
    await writeFile(join(directory, name, 'server.ts'), '')
  }
  await writeFile(join(directory, names[0], 'api.ts'), "export const tier = 'core'")
  const user = join(home, '.ultimate/extensions', names[0])
  const override = join(project, '.ultimate/extensions', names[1])
  for (const path of [user, override]) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'api.ts'), "export const tier = 'core'")
  }
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: [names[0]] } }),
  )
  let entered!: () => void
  const firstRead = new Promise<void>((resolve) => (entered = resolve))
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let active = 0
  let maximum = 0
  vi.mocked(stat).mockImplementation(async (path) => {
    if (!String(path).startsWith(directory + '/')) return original.stat(path)
    active++
    maximum = Math.max(maximum, active)
    entered()
    try {
      await gate
      return await original.stat(path)
    } finally {
      active--
    }
  })
  const reading = discoverExtensions(root, project, home, true)
  try {
    await firstRead
    expect(active).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(16)
    release()
    const result = await reading
    expect(result.map((entry) => entry.name).toSorted()).toEqual(names)
    expect(result.find((entry) => entry.name === names[0])).toMatchObject({
      source: 'user',
      path: user,
      core: true,
      enabled: true,
    })
    expect(result.find((entry) => entry.name === names[1])).toMatchObject({
      source: 'project',
      path: override,
      enabled: true,
    })
    expect(result.find((entry) => entry.name === names[1])).not.toHaveProperty('core')
    expect(maximum).toBeLessThanOrEqual(16)
  } finally {
    release()
    await reading
    vi.mocked(stat).mockImplementation(original.stat)
    await rm(home, { recursive: true, force: true })
  }
})

it('retains a builtin core name for overrides when its realpath fails after the marker read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'extension-core-error-'))
  const root = join(home, 'repo')
  const project = join(home, 'project')
  const builtin = join(root, 'extensions/shared')
  const user = join(home, '.ultimate/extensions/shared')
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  await mkdir(project)
  for (const path of [builtin, user]) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'api.ts'), "export const tier = 'core'")
  }
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['shared'] } }),
  )
  vi.mocked(realpath).mockImplementation(async (path) => {
    if (String(path) === builtin) throw new Error('Synthetic realpath failure')
    return original.realpath(path)
  })
  try {
    const found = (await discoverExtensions(root, project, home, true)).find(
      (entry) => entry.name === 'shared',
    )
    expect(found).toMatchObject({ source: 'user', path: user, core: true, enabled: true })
    expect(found).not.toHaveProperty('error')
  } finally {
    vi.mocked(realpath).mockImplementation(original.realpath)
    await rm(home, { recursive: true, force: true })
  }
})
