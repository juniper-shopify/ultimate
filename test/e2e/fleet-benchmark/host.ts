import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { configure, defineTask, AgentDoc } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, TaskId } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'

const [build, scratch, countText, taskText, activeText, shape] = process.argv.slice(2)
const load = (path: string) => import(pathToFileURL(join(build, path)).href)
const { createServer } = (await load('server/main.ts')) as typeof import('../../../server/main.ts')
const { Metadata } = (await load(
  'server/metadata.ts',
)) as typeof import('../../../server/metadata.ts')
const { Roots, Tally } = (await load(
  'extensions/lineage/api.ts',
)) as typeof import('../../../extensions/lineage/api.ts')
const { UiState } = (await load(
  'shared/ui-state.ts',
)) as typeof import('../../../shared/ui-state.ts')
console.log('Starting scratch host')
const app = await createServer({
  ultimateRoot: build,
  projectRoot: join(scratch, 'project'),
  userHome: join(scratch, 'user'),
  home: join(scratch, 'store'),
  port: 0,
})
console.log('Seeding synthetic fleet')
const parked = defineTask<null, { phase: 'park' }, null>({
  name: 'fleet.park',
  version: 1,
  initial: () => ({ phase: 'park' }),
  phases: {
    park: (_task, runtime, caller) =>
      runtime.sleepUntil(Date.now() + 3_600_000, { phase: 'park' }, caller),
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})
app.host.registry.install({ name: 'fleet-park', tasks: [parked] })
const conversations: ConversationId[] = []
let treeRoot: ConversationId | undefined
let forkAt: EntryId | undefined
let parent: ConversationId | undefined
let owner: TaskId | undefined
const existing = app.api.conversations().length
if (shape === 'tree') {
  const root = await app.harness.createConversation(
    {
      ownership: { kind: 'ownerless' },
      agent: {
        model: { provider: 'scripted', modelId: 'scripted-1' },
        cwd: join(scratch, 'project'),
      },
    },
    context,
  )
  treeRoot = root.id
  await app.harness.commit(async (tx) => {
    forkAt = (await tx.appendEntry(root.id, { kind: 'pi.reset', head: 'self' })).id
    ;(await tx.doc(Roots, app.root.id)).roots.push(root.id)
    ;(await tx.doc(Tally, root.id)).since = forkAt
    ;(await tx.doc(Metadata, root.id)).title = 'Synthetic root'
    ;(await tx.doc(AgentDoc, root.id)).tools = ['fleet_pulse']
  }, context)
  conversations.push(root.id)
}
await app.harness.commit(async (tx) => {
  for (let index = existing + conversations.length; index < Number(countText); index++) {
    const owned =
      shape === 'tree' && owner !== undefined && conversations.length < Number(activeText) + 2
    const record = owned
      ? await tx.createConversation({ ownership: { kind: 'task', taskId: owner! } })
      : shape === 'tree' && treeRoot !== undefined
        ? await tx.forkConversation(treeRoot, forkAt!, { ownership: { kind: 'ownerless' } })
        : await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, record.id, {
      model: { provider: 'scripted', modelId: 'scripted-1' },
      cwd: join(scratch, 'project'),
    })
    ;(await tx.doc(AgentDoc, record.id)).tools = ['fleet_pulse']
    const meta = await tx.doc(Metadata, record.id)
    meta.title = `Synthetic conversation ${index}`
    meta.inputAt = 1_700_000_000_000 + index
    if (shape === 'tree' && parent === undefined) {
      parent = record.id
      owner = await tx.createTask(parked, null, {
        ownership: { kind: 'conversation' },
        conversationId: parent,
        background: true,
      })
    }
    if (owned) meta.label = 'worker'
    conversations.push(record.id)
  }
}, context)
let latestGraph: { readonly value: import('@earendil-works/pi-durable').TaskGraph } | undefined
const graph = await app.harness.observeTaskGraph(
  {
    advance: (call) => {
      if (call.kind === 'value') latestGraph = call
    },
    end: () => {},
  },
  context,
)
const tasks = () => (latestGraph ?? graph).value
const offset = shape === 'tree' ? 2 : 0
const active = conversations.slice(offset, offset + Number(activeText))
const fixed = parent ?? conversations.at(-1)!
const submit = async (id: ConversationId) => {
  const conversation = await app.harness.conversation(id, context)
  await conversation!.submit(
    { type: 'input', content: 'Run the fleet synthetic sample loop.' },
    context,
  )
}
let started = false
let cpu = process.threadCpuUsage()
let at = performance.now()
const samples: { seconds: number; mainThreadMs: number; mainThreadMsPerSecond: number }[] = []
const sample = () => {
  const elapsed = (performance.now() - at) / 1000
  const used = process.threadCpuUsage(cpu)
  const mainThreadMs = (used.user + used.system) / 1000
  samples.push({ seconds: elapsed, mainThreadMs, mainThreadMsPerSecond: mainThreadMs / elapsed })
  cpu = process.threadCpuUsage()
  at = performance.now()
}
let meter: NodeJS.Timeout | undefined
process.on(
  'message',
  async (message: { id: number; command: string; docs?: Record<string, string[]> }) => {
    try {
      let result: unknown
      if (message.command === 'start') {
        if (started) throw new Error('Already started')
        started = true
        await Promise.all(active.map(submit))
        result = { active: active.length }
      } else if (message.command === 'fill') {
        const missing = Math.max(0, Number(taskText) - Object.keys(tasks().tasks).length)
        await app.harness.commit(async (tx) => {
          for (let index = 0; index < missing; index++)
            await tx.createTask(parked, null, {
              ownership: { kind: 'conversation' },
              conversationId: conversations[index % conversations.length],
              background: true,
            })
        }, context)
        result = { tasks: Object.keys(tasks().tasks).length }
      } else if (message.command === 'measure') {
        cpu = process.threadCpuUsage()
        at = performance.now()
        meter = setInterval(sample, 1000)
        result = true
      } else if (message.command === 'stop') {
        clearInterval(meter)
        sample()
        await Promise.all(
          active.map(async (id) => (await app.harness.conversation(id, context))!.abort(context)),
        )
        result = { samples }
      } else if (message.command === 'state') {
        const docs: Record<string, Record<string, unknown>> = {}
        for (const [id, kinds] of Object.entries(message.docs ?? {})) {
          docs[id] = {}
          for (const kind of kinds) {
            const token = kind === UiState.definition.kind ? UiState : app.extensions.doc(kind)
            if (!token) throw new Error(`Unknown document ${kind}`)
            docs[id][kind] = await app.harness.snapshot(
              token,
              Number(id) as ConversationId,
              context,
            )
          }
        }
        result = {
          tasks: tasks(),
          conversations: app.api.conversations(),
          docs,
          ui: await app.harness.snapshot(UiState, app.root.id, context),
        }
      } else if (message.command === 'close') {
        clearInterval(meter)
        graph.detach()
        await app.close()
        process.send?.({ id: message.id, result: true })
        process.disconnect?.()
        return
      } else throw new Error(`Unknown command ${message.command}`)
      process.send?.({ id: message.id, result })
    } catch (error) {
      process.send?.({ id: message.id, error: String(error) })
    }
  },
)
console.log('Fleet ready', app.url, conversations.length)
process.send?.({
  ready: true,
  url: app.url,
  fixed,
  active,
  parent,
  conversations: Number(countText),
})
