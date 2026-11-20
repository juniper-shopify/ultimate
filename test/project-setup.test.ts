import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { projectDecision } from '../lib/project-setup.ts'

const homes: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'trust-cache-'))
  homes.push(home)
  const root = join(home, 'project')
  mkdirSync(root)
  const store = new ProjectTrustStore(join(home, '.ultimate'))
  store.set(root, true)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
  return { home, root, store }
}

it('reads an unchanged settled decision without another locked store read or file creation', () => {
  const { home, root } = fixture()
  const read = vi.spyOn(ProjectTrustStore.prototype, 'getEntry')
  const before = statSync(join(home, '.ultimate'), { bigint: true })
  expect(projectDecision(root, home)).toBe(true)
  const warmed = statSync(join(home, '.ultimate'), { bigint: true })
  expect(projectDecision(root, home)).toBe(true)
  expect(read).toHaveBeenCalledTimes(1)
  expect(statSync(join(home, '.ultimate'), { bigint: true }).mtimeNs).toBe(warmed.mtimeNs)
  expect(warmed.ino).toBe(before.ino)
})

it('sees this process’s next write immediately', () => {
  const { home, root, store } = fixture()
  expect(projectDecision(root, home)).toBe(true)
  store.set(root, false)
  expect(projectDecision(root, home)).toBe(false)
  store.set(root, true)
  expect(projectDecision(root, home)).toBe(true)
})

it('does not cache reads inside the file timestamp safety window', () => {
  const { home, root } = fixture()
  vi.mocked(Date.now).mockRestore()
  const read = vi.spyOn(ProjectTrustStore.prototype, 'getEntry')
  expect(projectDecision(root, home)).toBe(true)
  expect(projectDecision(root, home)).toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
})
