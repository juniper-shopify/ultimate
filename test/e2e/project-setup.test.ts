import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { projectDecision } from '../../lib/project-setup.ts'

it('sees a decision written by another process on the next read', () => {
  const home = mkdtempSync(join(tmpdir(), 'trust-process-'))
  const root = join(home, 'project')
  mkdirSync(root)
  try {
    new ProjectTrustStore(join(home, '.ultimate')).set(root, true)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
    expect(projectDecision(root, home)).toBe(true)
    const module = realpathSync('node_modules/@earendil-works/pi-coding-agent/dist/index.js')
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { ProjectTrustStore } from ${JSON.stringify(module)}; new ProjectTrustStore(${JSON.stringify(join(home, '.ultimate'))}).set(${JSON.stringify(root)}, false)`,
    ])
    expect(projectDecision(root, home)).toBe(false)
  } finally {
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
})
