import type { Site } from './report.ts'
import { sourceFile } from './report.ts'

export type Mode = 'sample' | 'sync' | 'actors'
export const expectedSites: Record<Mode, string[]> = {
  sample: [],
  sync: [
    'task-graph.publish',
    'delta.copyContainers',
    'settings.resolveSettings',
    'scheduler.wake',
    'scheduler.wakeDue',
    'session.publish',
    'session.adopt',
    'host.extensionOrder',
    'host.sseSend',
    'sqlite.exec',
    'sqlite.run',
    'sqlite.get',
    'sqlite.all',
  ],
  actors: [
    'extension.install',
    'session.observeCommits',
    'session.followCommits',
    'scheduler.start',
    'scheduler.drain',
    'scheduler.wakeDue',
  ],
}
export function assertSites(mode: Mode, sites: Record<string, Site>) {
  const missing = expectedSites[mode].filter((label) => !Object.hasOwn(sites, label))
  if (missing.length)
    throw new Error(`Profiling sites not found in this build: ${missing.join(', ')}`)
}
export function instrument(source: string, url: string, mode: Mode, build: string) {
  let code = source
  const sites: Record<string, Site> = {}
  const replace = (needle: string, replacement: string, label: string) => {
    const at = code.indexOf(needle)
    if (at < 0 || code.indexOf(needle, at + needle.length) >= 0)
      throw new Error(`Unsupported profiling site ${label} in ${sourceFile(url, build)}`)
    sites[label] = {
      file: sourceFile(url, build),
      line: source.slice(0, source.indexOf(needle)).split('\n').length,
    }
    code = code.replace(needle, replacement)
  }
  const method = (name: string, args: string, label: string, reset = false, async = false) => {
    const needle = `${name}(${args}) {`
    replace(
      needle,
      `${needle} return globalThis.fleetProfile.${reset ? 'root' : 'phase'}(${JSON.stringify(label)}, () => this.${name}Profile(${args})); }\n    ${async ? 'async ' : ''}${name}Profile(${args}) {`,
      label,
    )
  }
  const fn = (name: string, label: string, exported = false) => {
    replace(`${exported ? 'export ' : ''}function ${name}(`, `function __profile_${name}(`, label)
    code += `\n${exported ? 'export ' : ''}function ${name}(...args) { return globalThis.fleetProfile.phase(${JSON.stringify(label)}, () => __profile_${name}(...args)); }\n`
  }
  if (mode === 'sync') {
    if (url.endsWith('/harness/task-graph.js')) fn('publish', 'task-graph.publish')
    if (url.endsWith('/delta/index.js')) fn('copyContainers', 'delta.copyContainers')
    if (url.endsWith('/harness/agent.js')) fn('resolveSettings', 'settings.resolveSettings', true)
    if (url.endsWith('/harness/scheduler.js')) {
      method('wake', '', 'scheduler.wake')
      method('#wakeDue', '', 'scheduler.wakeDue')
    }
    if (url.endsWith('/session/session.js')) {
      method('#publish', 'seq, writes, documents, context', 'session.publish')
      method('#adopt', 'tx, writes, taken, seq, context', 'session.adopt')
    }
    if (url.endsWith('/server/harness.ts')) {
      const getter = /get extensions\(\) \{([\s\S]*?)\n    \},/.exec(code)
      if (!getter) throw new Error('Unsupported profiling site host.extensionOrder')
      replace(
        getter[0],
        `get extensions() { return globalThis.fleetProfile.phase("host.extensionOrder", () => {${getter[1]}\n}); },`,
        'host.extensionOrder',
      )
    }
    if (url.endsWith('/server/api.ts')) {
      replace(
        'function eventStream(response: ServerResponse) {',
        'function __profile_eventStream(response: ServerResponse) {',
        'host.sseSend',
      )
      code +=
        '\nfunction eventStream(response) { const stream = __profile_eventStream(response); const send = stream.send; stream.send = (name, ...args) => globalThis.fleetProfile.phase("host.sseSend", () => send(name, ...args)); return stream; }\n'
    }
  }
  if (mode === 'actors') {
    if (url.endsWith('/harness/registry.js'))
      replace(
        '    install(extension) {',
        '    install(extension) {\n        extension = globalThis.fleetProfile.extension(extension);',
        'extension.install',
      )
    if (url.endsWith('/session/session.js')) {
      for (const [name, argument] of [
        ['observeCommits', 'observer'],
        ['followCommits', 'listener'],
      ]) {
        const needle = `    ${name}(${argument}) {`
        replace(needle, needle, `session.${name}`)
      }
      code +=
        '\nfor (const key of ["observeCommits", "followCommits"]) { const original = SessionImpl.prototype[key]; SessionImpl.prototype[key] = function(observer, ...args) { const label = globalThis.fleetProfile.registration(); if (key === "observeCommits") observer = { ...observer, advance: globalThis.fleetProfile.wrap(label, observer.advance, true) }; else observer = globalThis.fleetProfile.wrap(label, observer, true); return original.call(this, observer, ...args); }; }\n'
    }
    if (url.endsWith('/harness/scheduler.js')) {
      method('#start', 'reservation', 'scheduler.start', true)
      method('#drain', '', 'scheduler.drain', true, true)
      method('#wakeDue', '', 'scheduler.wakeDue', true)
    }
  }
  return { source: code, sites }
}
