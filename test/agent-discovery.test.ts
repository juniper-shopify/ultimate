import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { discoverAgents } from '../lib/agents.ts'
import { temp } from './helpers.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: vi.fn<typeof fs.readFile>(fs.readFile),
    readdir: vi.fn<typeof fs.readdir>(fs.readdir),
  }
})
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, readFileSync: vi.fn<typeof fs.readFileSync>(fs.readFileSync) }
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

async function fixture() {
  const home = await temp()
  const root = join(home, 'repo')
  const agents = join(root, 'agents')
  await mkdir(agents, { recursive: true })
  const runtime = {} as ModelRuntime
  const discover = () => discoverAgents(root, root, home, runtime)
  const definition = (name: string, description: string) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the work.\n`
  await writeFile(join(agents, 'one.md'), definition('one', 'first'))
  return { home, root, agents, discover, definition }
}

it('reuses unchanged definitions without reading files or directories and isolates callers', async () => {
  const { discover } = await fixture()
  const first = await discover()
  expect(first.definitions.map((definition) => definition.name)).toEqual(['one'])
  vi.clearAllMocks()
  const second = await discover()
  expect(second).toEqual(first)
  expect(readFile).not.toHaveBeenCalled()
  expect(readdir).not.toHaveBeenCalled()
  expect(readFileSync).not.toHaveBeenCalled()
  second.definitions[0].instructions = 'Changed by a caller'
  second.definitions.pop()
  expect(await discover()).toEqual(first)
})

it('sees edited, added and removed definition files on the next call', async () => {
  const { agents, discover, definition } = await fixture()
  const descriptions = async () =>
    (await discover()).definitions.map(({ name, description }) => ({ name, description }))
  expect(await descriptions()).toEqual([{ name: 'one', description: 'first' }])
  await writeFile(join(agents, 'one.md'), definition('one', 'other'))
  expect(await descriptions()).toEqual([{ name: 'one', description: 'other' }])
  await writeFile(join(agents, 'two.md'), definition('two', 'added'))
  expect(await descriptions()).toEqual([
    { name: 'one', description: 'other' },
    { name: 'two', description: 'added' },
  ])
  await rm(join(agents, 'one.md'))
  expect(await descriptions()).toEqual([{ name: 'two', description: 'added' }])
})

it('applies a changed trust decision before returning cached project definitions', async () => {
  const { home, root, discover, definition } = await fixture()
  const directory = join(root, '.ultimate/agents')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'two.md'), definition('two', 'project'))
  const names = async () => (await discover()).definitions.map(({ name }) => name)
  expect(await names()).toEqual(['one'])
  const trust = new ProjectTrustStore(join(home, '.ultimate'))
  trust.set(root, true)
  expect(await names()).toEqual(['one', 'two'])
  trust.set(root, false)
  expect(await names()).toEqual(['one'])
})

it('refreshes after ten seconds to find a new agents folder inside an existing extension', async () => {
  const { root, discover, definition } = await fixture()
  const extension = join(root, 'extensions/sample')
  await mkdir(extension, { recursive: true })
  await writeFile(join(extension, 'server.ts'), 'export default { name: "sample" }')
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const names = async () => (await discover()).definitions.map(({ name }) => name)
  expect(await names()).toEqual(['one'])
  await mkdir(join(extension, 'agents'))
  await writeFile(join(extension, 'agents/two.md'), definition('two', 'extension'))
  clock.mockReturnValue(now + 9_999)
  expect(await names()).toEqual(['one'])
  clock.mockReturnValue(now + 10_000)
  expect(await names()).toEqual(['one', 'two'])
})
