import type { ConversationView, ConversationId, TaskGraph } from '@earendil-works/pi-durable'
import type { Op } from '@earendil-works/chord/delta'
import { parseConversationId, parseTaskId } from '../../lib/ids.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '../../web/src/sdk/store.ts'
import type { ServerEvents } from '../../shared/protocol.ts'

import { FakeSource, fakeSubscriptions } from './fake-source.ts'

function setup(retryMs = 5) {
  const sources: FakeSource[] = []
  const server = fakeSubscriptions(sources)
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (path, init) =>
      server.handle(path as string, init) ?? Response.json({ providers: [], models: [] }),
  )
  const onFallback = vi.fn<() => void>()
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
    fetch,
    retryMs,
    onFallback,
  })
  store.start()
  const models = () => fetch.mock.calls.filter(([path]) => path === '/api/models').length
  return { store, sources, server, fetch, models, onFallback, latest: () => sources.at(-1)! }
}

const user = (id: number, text: string) => ({
  id,
  conversationId: 1,
  kind: 'pi.user',
  model: [{ role: 'user' as const, content: text, timestamp: id }],
})
const view = (
  entries: ReturnType<typeof user>[],
  docs: ConversationView['docs'] = {},
  id = 1,
): ConversationView => ({ conversation: { id }, entries, docs }) as unknown as ConversationView
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const tick = () => vi.advanceTimersByTimeAsync(10)

describe('web replica store', () => {
  it('applies ops to the snapshot and starts over from a fresh snapshot after a reconnect', () => {
    const { store, server, latest } = setup()
    const source = latest()
    expect(source.url).toBe('/api/events')
    expect(store.getState().connection.status).toBe('connecting')
    source.open()
    expect(store.getState().connection.status).toBe('open')
    // The shown conversation (the root) is a subscription on the stream.
    const main = server.of()!
    expect(main).toMatchObject({ stream: source.id, docs: [], view: true })

    main.send('view', view([user(1, 'hello')], { 'pi.live': {} }))
    const ops: Op[] = [
      ['s', ['docs', 'pi.live', 'run'], { taskId: 2, inputs: [1], turns: 0 }],
      ['p', ['entries'], 1, 0, [user(3, 'steer')]],
    ]
    main.send('ops', ops)
    main.send('ops', [['a', ['entries', 1, 'model', 0, 'content'], ' now']])
    const replica = store.getState().view!
    expect(replica.entries.map((entry) => entry.id)).toEqual([1, 3])
    expect(replica.entries[1].model?.[0]).toMatchObject({
      content: 'steer now',
    })
    expect(replica.docs['pi.live']).toEqual({
      run: { taskId: 2, inputs: [1], turns: 0 },
    })
    // Unchanged entries keep their identity, so the transcript re-renders only what changed.
    main.send('ops', [['d', ['docs', 'pi.live', 'run']]])
    expect(store.getState().view!.entries[0]).toBe(replica.entries[0])

    // The root conversation's UI document belongs to the stream, not to a subscription.
    source.send('ui', { value: { 'shell.panelOpen': true } })
    source.send('uiOps', { ops: [['s', ['shell.surface'], 'example']] })
    expect(store.getState().shared).toEqual({
      'shell.panelOpen': true,
      'shell.surface': 'example',
    })

    source.drop()
    expect(store.getState().connection.status).toBe('reconnecting')
    // EventSource reopened the stream: a new one, whose subscription sends a full snapshot first.
    source.open()
    const resumed = server.of()!
    expect(resumed.stream).toBe(source.id)
    expect(resumed.sub).not.toBe(main.sub)
    resumed.send('view', view([user(1, 'hello'), user(3, 'steer now'), user(4, 'next')]))
    // Events of the old stream's subscription are not this one's.
    main.send('ops', [['p', ['entries'], 3, 0, [user(5, 'stale')]]])
    expect(store.getState().view!.entries.map((entry) => entry.id)).toEqual([1, 3, 4])
    expect(store.getState().view!.docs).toEqual({})
    expect(store.getState().connection.status).toBe('open')
    store.stop()
  })

  it('applies task operations with shared untouched nodes and resets to the reconnect snapshot', () => {
    const { store, latest } = setup()
    const source = latest()
    source.open()
    const node = (id: number) =>
      ({
        id: parseTaskId(id),
        kind: 'sample',
        conversationId: parseConversationId(1),
        background: false,
        abortRequested: false,
        state: { status: 'running', phase: 'first' },
        conversations: [],
      }) satisfies TaskGraph['tasks'][string]
    const snapshot: TaskGraph = { tasks: { 1: node(1), 2: node(2) } }
    source.send('tasks', snapshot)
    const before = store.getState().tasks!
    source.send('tasksOps', {
      ops: [
        ['s', ['tasks', '3'], node(3)],
        ['s', ['tasks', '1', 'state', 'phase'], 'second'],
        ['p', ['tasks', '1', 'conversations'], 0, 0, [7]],
      ],
    })
    expect(store.getState().tasks).toEqual({
      tasks: {
        1: { ...node(1), state: { status: 'running', phase: 'second' }, conversations: [7] },
        2: node(2),
        3: node(3),
      },
    })
    expect(store.getState().tasks!.tasks[2]).toBe(before.tasks[2])
    expect(before).toEqual(snapshot)
    source.send('tasksOps', { ops: [['d', ['tasks', '3']]] })
    expect(Object.keys(store.getState().tasks!.tasks)).toEqual(['1', '2'])

    source.drop()
    source.open()
    source.send('tasks', snapshot)
    expect(store.getState().tasks).toEqual(snapshot)
    source.send('tasksOps', { ops: [['p', ['tasks', '1', 'conversations'], 0, 0, [8]]] })
    expect(store.getState().tasks!.tasks[1].conversations).toEqual([8])
    store.stop()
  })

  it('streams extension documents of the shown conversation', async () => {
    const { store, sources, server, latest } = setup()
    latest().open()
    const first = server.of()!
    const release = store.watchDoc('test.counter')
    await tick()
    // The shown conversation's subscription is updated on the same stream.
    expect(sources).toHaveLength(1)
    expect(first.closed).toBe(false)
    const main = server.of()!
    expect(main).toBe(first)
    expect(main.docs).toEqual(['test.counter'])

    main.send('doc', { kind: 'test.counter', value: { count: 0 } })
    main.send('docOps', {
      kind: 'test.counter',
      ops: [['s', ['count'], 1]],
    })
    expect(store.getState().docs['test.counter']).toEqual({ count: 1 })
    // Documents nobody asked for are ignored.
    main.send('doc', { kind: 'other', value: { x: 1 } })
    expect(store.getState().docs.other).toBeUndefined()

    release()
    await tick()
    expect(store.getState().docs['test.counter']).toBeUndefined()
    main.send('docOps', {
      kind: 'test.counter',
      ops: [['s', ['count'], 2]],
    })
    expect(store.getState().docs['test.counter']).toBeUndefined()
    // Watched again: operations wait for the added watch's snapshot.
    store.watchDoc('test.counter')
    main.send('docOps', {
      kind: 'test.counter',
      ops: [['s', ['count'], 3]],
    })
    expect(store.getState().docs['test.counter']).toBeUndefined()
    await tick()
    server.of()!.send('doc', { kind: 'test.counter', value: { count: 3 } })
    expect(store.getState().docs['test.counter']).toEqual({ count: 3 })
    store.stop()
  })

  it('keeps the shown view and unchanged documents when kinds are added or removed', async () => {
    const { store, server, latest } = setup()
    latest().open()
    const main = server.of()!
    main.send('view', view([user(1, 'kept')]))
    const first = store.watchDoc('test.first')
    store.watchDoc('test.second')
    await tick()
    main.send('doc', { kind: 'test.first', value: { n: 1 } })
    main.send('doc', { kind: 'test.second', value: { n: 2 } })
    const before = store.getState()
    const third = store.watchDoc('test.third')
    await tick()
    expect(server.of()).toBe(main)
    expect(main.docs).toEqual(['test.first', 'test.second', 'test.third'])
    expect(store.getState().view).toBe(before.view)
    expect(store.getState().docs).toBe(before.docs)
    main.send('docOps', { kind: 'test.third', ops: [['s', ['n'], 3]] })
    expect(store.getState().docs['test.third']).toBeUndefined()
    main.send('doc', { kind: 'test.third', value: { n: 3 } })
    third()
    await tick()
    expect(server.of()).toBe(main)
    expect(main.docs).toEqual(['test.first', 'test.second'])
    expect(store.getState().docs['test.third']).toBeUndefined()
    main.send('docOps', { kind: 'test.first', ops: [['s', ['n'], 4]] })
    main.send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' live']])
    expect(store.getState().docs['test.first']).toEqual({ n: 4 })
    expect(store.getState().view!.entries[0].model?.[0]).toMatchObject({ content: 'kept live' })
    const retained = store.getState().docs['test.first']
    first()
    store.watchDoc('test.first')
    await tick()
    expect(server.of()).toBe(main)
    expect(store.getState().docs['test.first']).toBe(retained)
    store.stop()
  })

  it.each(['doc', 'docOps'] as const)(
    'applies %s between a release and re-add before the batched main sync',
    async (event) => {
      const { store, server, latest } = setup()
      latest().open()
      const release = store.watchDoc('test.counter')
      await tick()
      const main = server.of()!
      if (event === 'docOps') main.send('doc', { kind: 'test.counter', value: { count: 0 } })
      release()
      if (event === 'doc') main.send('doc', { kind: 'test.counter', value: { count: 1 } })
      else main.send('docOps', { kind: 'test.counter', ops: [['s', ['count'], 1]] })
      store.watchDoc('test.counter')
      await tick()
      expect(server.of()).toBe(main)
      expect(store.getState().docs['test.counter']).toEqual({ count: 1 })
      store.stop()
    },
  )

  it('does not leak retries from failed current-main updates', async () => {
    const { store, server, latest, fetch } = setup(100)
    latest().open()
    const main = server.of()!
    main.send('view', view([user(1, 'original')]))
    const response = Promise.withResolvers<Response>()
    fetch.mockImplementationOnce(() => response.promise)
    store.watchDoc('test.first')
    await tick()
    store.watchDoc('test.second')
    await tick()
    server.refuse(undefined, 500)
    response.resolve(Response.json({}, { status: 500 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(main.closed).toBe(false)
    server.refuse(undefined, undefined)
    store.watchDoc('test.third')
    await tick()
    await vi.advanceTimersByTimeAsync(100)
    expect(main.closed).toBe(false)
    expect(server.subscriptions).toHaveLength(1)
    expect(server.of()!.docs).toEqual(['test.first', 'test.second', 'test.third'])
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(4)
    server.refuse(undefined, 500)
    store.watchDoc('test.fourth')
    await tick()
    server.refuse(undefined, undefined)
    await vi.advanceTimersByTimeAsync(100)
    expect(main.closed).toBe(true)
    expect(server.subscriptions).toHaveLength(2)
    expect(server.of()!.docs).toEqual(['test.first', 'test.fourth', 'test.second', 'test.third'])
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(6)
    store.stop()
  })

  it.each(['switch', 'close', 'reconnect'] as const)(
    'discards an in-flight main update and queued changes on %s',
    async (transition) => {
      const { store, server, latest, fetch } = setup()
      latest().open()
      const main = server.of()!
      main.send('view', view([user(1, 'original')]))
      const response = Promise.withResolvers<Response>()
      fetch.mockImplementationOnce(async (path, init) => {
        server.handle(path as string, init)
        return response.promise
      })
      store.watchDoc('test.first')
      await tick()
      store.watchDoc('test.second')
      await tick()
      if (transition === 'switch') store.show(7 as ConversationId)
      else if (transition === 'close') store.stop()
      else {
        latest().drop()
        latest().open()
      }
      await tick()
      const resumed = server.of(transition === 'switch' ? 7 : undefined)
      expect(resumed).not.toBe(main)
      expect(resumed?.docs).toEqual(
        transition === 'close' ? undefined : ['test.first', 'test.second'],
      )
      resumed?.send('view', view([user(2, 'fresh')], {}, transition === 'switch' ? 7 : 1))
      resumed?.send('doc', { kind: 'test.first', value: { n: 2 } })
      const before = store.getState()
      const requests = fetch.mock.calls.length
      main.send('view', view([user(3, 'stale')]))
      main.send('doc', { kind: 'test.first', value: { n: 0 } })
      response.resolve(Response.json({}, { status: 500 }))
      await tick()
      expect(fetch.mock.calls).toHaveLength(requests)
      expect(store.getState().view).toBe(before.view)
      expect(store.getState().docs).toBe(before.docs)
      store.stop()
    },
  )

  it('streams documents of given conversations on one subscription per conversation', async () => {
    const { store, sources, server, latest } = setup()
    latest().open()
    const tasks = store.watchDocOf(1 as ConversationId, 'test.tasks')
    const tasksAgain = store.watchDocOf(1 as ConversationId, 'test.tasks')
    const overview = store.watchDocOf(1 as ConversationId, 'test.overview')
    const plan = store.watchDocOf(7 as ConversationId, 'test.plan')
    await tick()
    // All on the tab's one stream: the shown conversation, then one subscription of all kinds per conversation.
    expect(sources).toHaveLength(1)
    expect(
      server.subscriptions.map((item) => ({
        conversation: item.conversation,
        docs: item.docs,
        view: item.view,
        closed: item.closed,
      })),
    ).toEqual([
      { docs: [], view: true, closed: false },
      { conversation: 1, docs: ['test.overview', 'test.tasks'], view: false, closed: false },
      { conversation: 7, docs: ['test.plan'], view: false, closed: false },
    ])
    const root = server.of(1)!
    const coordinator = server.of(7)!

    root.send('docOps', { kind: 'test.tasks', ops: [['s', ['n'], 0]] })
    expect(store.getState().docsOf[1]).toEqual({})
    root.send('doc', { kind: 'test.tasks', value: { n: 1 } })
    root.send('docOps', { kind: 'test.tasks', ops: [['s', ['n'], 2]] })
    coordinator.send('doc', { kind: 'test.plan', value: { epics: {} } })
    expect(store.getState().docsOf).toEqual({
      1: { 'test.tasks': { n: 2 } },
      7: { 'test.plan': { epics: {} } },
    })
    // Documents of the shown conversation are a separate replica.
    expect(store.getState().docs).toEqual({})

    // Showing another conversation leaves these subscriptions alone.
    store.show(7 as ConversationId)
    await tick()
    expect([root.closed, coordinator.closed]).toEqual([false, false])

    // A refused subscription is tried again.
    server.refuse(1, 500)
    overview()
    await tick()
    expect(server.of(1)).toBeUndefined()
    server.refuse(1, undefined)
    await tick()
    expect(server.of(1)!.docs).toEqual(['test.tasks'])

    // A new stream (a restart) gets every subscription again; the value stays until its snapshot.
    latest().drop()
    latest().open()
    const reopened = server.of(1)!
    expect(reopened.stream).toBe(latest().id)
    expect(store.getState().docsOf[1]['test.tasks']).toEqual({ n: 2 })
    reopened.send('doc', { kind: 'test.tasks', value: { n: 3 } })
    root.send('doc', { kind: 'test.tasks', value: { n: 0 } })
    expect(store.getState().docsOf[1]['test.tasks']).toEqual({ n: 3 })
    expect(server.of(7)!.stream).toBe(latest().id)

    // Released and watched again before the next tick: the subscription carries on.
    overview()
    const watched = store.watchDocOf(1 as ConversationId, 'test.overview')
    await tick()
    const both = server.of(1)!
    expect(both.docs).toEqual(['test.overview', 'test.tasks'])
    watched()
    store.watchDocOf(1 as ConversationId, 'test.overview')
    await tick()
    expect(both.closed).toBe(false)

    // A kind nobody watches leaves its conversation's subscription; the last one closes it.
    tasks()
    await tick()
    expect(both.closed).toBe(false)
    tasksAgain()
    await tick()
    expect(both.closed).toBe(false)
    expect(server.of(1)).toBe(both)
    expect(server.of(1)!.docs).toEqual(['test.overview'])
    expect(store.getState().docsOf[1]).toEqual({})
    plan()
    await tick()
    // Only the shown conversation's own subscription of 7 is left.
    const seven = server.subscriptions.filter((item) => !item.closed && item.conversation === 7)
    expect(seven.map((item) => item.docs)).toEqual([[]])
    expect(store.getState().docsOf[7]).toBeUndefined()

    store.stop()
    expect(latest().closed).toBe(true)
  })

  it('keeps document and view replicas when adding and removing another kind', async () => {
    const { store, server, latest, fetch } = setup()
    latest().open()
    const id = 7 as ConversationId
    store.watchConversation(id)
    store.watchDocOf(id, 'test.first')
    store.watchDocOf(id, 'test.second')
    await tick()
    const subscription = server.of(id)!
    subscription.send('view', view([user(1, 'kept')], {}, id))
    subscription.send('doc', { kind: 'test.first', value: { text: 'x'.repeat(522000) } })
    subscription.send('doc', { kind: 'test.second', value: { text: 'y'.repeat(426000) } })
    const before = store.getState()
    const third = store.watchDocOf(id, 'test.third')
    await tick()
    expect(server.of(id)).toBe(subscription)
    expect(subscription.docs).toEqual(['test.first', 'test.second', 'test.third'])
    expect(store.getState().docsOf[id]).toBe(before.docsOf[id])
    expect(store.getState().viewsOf[id]).toBe(before.viewsOf[id])
    subscription.send('docOps', { kind: 'test.third', ops: [['s', ['n'], 1]] })
    expect(store.getState().docsOf[id]['test.third']).toBeUndefined()
    subscription.send('doc', { kind: 'test.third', value: { n: 1 } })
    third()
    await tick()
    expect(server.of(id)).toBe(subscription)
    expect(subscription.docs).toEqual(['test.first', 'test.second'])
    expect(store.getState().docsOf[id]['test.third']).toBeUndefined()
    subscription.send('docOps', { kind: 'test.first', ops: [['s', ['n'], 2]] })
    expect(store.getState().docsOf[id]['test.first']).toMatchObject({ n: 2 })
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0)
    store.stop()
  })

  it('shows another conversation on the same stream and falls back to the root when it cannot open', async () => {
    const { store, sources, server, latest, onFallback } = setup()
    latest().open()
    server.of()!.send('view', view([user(1, 'root')]))
    server.refuse(7, 404)
    store.show(7 as ConversationId)
    expect(store.getState().view).toBeUndefined()
    await tick()
    // The server answered 404: the store subscribes the root instead.
    expect(store.getState().requested).toBeUndefined()
    expect(onFallback).toHaveBeenCalledOnce()
    expect(server.of()!.closed).toBe(false)
    expect(server.subscriptions.filter((item) => !item.closed)).toHaveLength(1)
    expect(sources).toHaveLength(1)
    store.stop()
  })

  it('keeps the conversation list as it was when a reconnect resends it unchanged', async () => {
    const { store, latest } = setup()
    latest().open()
    const list = [{ id: 1 as ConversationId, cwd: '/my-app', busy: false }]
    latest().send('conversations', list)
    const before = store.getState().conversations
    latest().drop()
    latest().open()
    latest().send('conversations', list)
    // The same object: nothing that reads the list renders again on a reconnect.
    expect(store.getState().conversations).toBe(before)
    latest().send('conversations', [{ ...list[0], busy: true }])
    expect(store.getState().conversations[0].busy).toBe(true)
    store.stop()
  })

  it('keeps unchanged rows when the list is resent for another row', () => {
    const { store, latest } = setup()
    latest().open()
    latest().send('conversations', [
      { id: 1 as ConversationId, title: 'my-app', busy: false },
      { id: 2 as ConversationId, title: 'fix login', busy: false },
    ])
    const [root, branch] = store.getState().conversations
    latest().send('conversations', [
      { id: 1 as ConversationId, title: 'my-app', busy: false },
      { id: 2 as ConversationId, title: 'fix login', busy: true, answerAt: 5 },
    ])
    // Readers of row 1 (`useConversationSummary(1)`) see the same object and skip the re-render.
    expect(store.getState().conversations[0]).toBe(root)
    expect(store.getState().conversations[1]).not.toBe(branch)
    expect(store.getState().conversations[1]).toMatchObject({ busy: true, answerAt: 5 })
    store.stop()
  })

  it('upserts changed conversation rows in place and appends new rows in received order', () => {
    const { store, latest } = setup()
    latest().open()
    const rows = [
      { id: 1 as ConversationId, title: 'Project', cwd: '/project', busy: false },
      { id: 3 as ConversationId, title: 'Task', cwd: '/project', busy: false },
    ]
    latest().send('conversations', rows)
    const untouched = store.getState().conversations[0]
    const changed = { ...rows[1], title: 'Updated task', cwd: '/project/next', busy: true }
    const added = { id: 2 as ConversationId, title: 'New task', busy: false }
    latest().send('conversationsUpsert', [changed, added])
    expect(store.getState().conversations).toEqual([rows[0], changed, added])
    expect(store.getState().conversations[0]).toBe(untouched)
    const materialized = store.getState().conversations
    latest().send('conversationsUpsert', [changed, added])
    expect(store.getState().conversations).toBe(materialized)
    store.stop()
  })

  it('replaces upserts on reconnect even when the snapshot matches the earlier snapshot text', () => {
    const { store, latest } = setup()
    latest().open()
    const rows = [{ id: 1 as ConversationId, title: 'Original', busy: false }]
    latest().send('conversations', rows)
    latest().send('conversationsUpsert', [{ ...rows[0], title: 'Changed', busy: true }])
    expect(store.getState().conversations[0].title).toBe('Changed')
    latest().drop()
    latest().open()
    latest().send('conversations', rows)
    expect(store.getState().conversations).toEqual(rows)
    store.stop()
  })

  it('shows a conversation seen before at once, until its subscription brings a different snapshot', async () => {
    const { store, server, latest } = setup()
    latest().open()
    server.of()!.send('view', view([user(1, 'root')]))
    store.show(7 as ConversationId)
    await tick()
    const seven = view([user(2, 'seven')], {}, 7)
    server.of(7)!.send('view', seven)
    expect(store.getState().restored).toBe(false)

    // Back to the root, then to 7 again: its last replica shows before any subscription answers.
    store.show(undefined)
    expect(store.getState().view).toBeUndefined()
    store.show(7 as ConversationId)
    const kept = store.getState()
    expect(kept.restored).toBe(true)
    expect(kept.view?.entries.map((entry) => entry.id)).toEqual([2])
    await tick()
    // The same snapshot as last time changes nothing but the flag; a different one replaces the replica.
    server.of(7)!.send('view', seven)
    expect(store.getState().view).toBe(kept.view)
    expect(store.getState().restored).toBe(false)
    server.of(7)!.send('view', view([user(2, 'seven'), user(4, 'new')], {}, 7))
    expect(store.getState().view?.entries.map((entry) => entry.id)).toEqual([2, 4])

    // Ops applied since make the replica newer than its snapshot: the next snapshot replaces it again.
    server.of(7)!.send('ops', [['p', ['entries'], 2, 0, [user(5, 'later')]]])
    store.show(undefined)
    store.show(7 as ConversationId)
    expect(store.getState().view?.entries.map((entry) => entry.id)).toEqual([2, 4, 5])
    await tick()
    server.of(7)!.send('view', seven)
    expect(store.getState().view?.entries.map((entry) => entry.id)).toEqual([2])
    store.stop()
  })

  it('ignores what the conversation shown before still sends once another is shown', async () => {
    const { store, server, latest } = setup()
    latest().open()
    const root = server.of()!
    root.send('view', view([user(1, 'root')], { 'pi.live': { tools: [{ id: 'a' }] } }))
    store.show(7 as ConversationId)
    await tick()
    server.of(7)!.send('view', view([user(2, 'seven')], { 'pi.live': {} }, 7))
    store.show(undefined)
    await tick()
    const back = server.of()!
    back.send('view', view([user(1, 'root')], { 'pi.live': { tools: [{ id: 'a' }] } }))

    store.show(7 as ConversationId)
    expect(back.closed).toBe(true)
    const kept = store.getState().view
    expect(() =>
      back.send('ops', [['s', ['docs', 'pi.live', 'tools', 0, 'id'], 'b']]),
    ).not.toThrow()
    back.send('view', view([user(3, 'root again')]))
    expect(store.getState().view).toBe(kept)
    expect(kept?.conversation.id).toBe(7)
    store.stop()
  })

  it('keeps the last six views shown and forgets the rest', async () => {
    const { store, server, latest } = setup()
    latest().open()
    for (let id = 2; id <= 8; id++) {
      store.show(id as ConversationId)
      await tick()
      server.of(id)!.send('view', view([user(id, `c${id}`)], {}, id))
    }
    // Seven shown after the root: the oldest, 2, is gone; 3 is still at hand.
    store.show(2 as ConversationId)
    expect(store.getState().view).toBeUndefined()
    expect(store.getState().restored).toBe(false)
    store.show(3 as ConversationId)
    expect(store.getState().restored).toBe(true)
    expect(store.getState().view?.conversation.id).toBe(3)
    store.stop()
  })

  it('refreshes models after (re)starts and keeps notices', async () => {
    const { store, latest, models } = setup()
    const source = latest()
    source.open()
    const system = {
      process: { pid: 1, generation: 1, node: 'v26', startedAt: '', url: '' },
    } as ServerEvents['system']
    source.send('system', system)
    await vi.waitFor(() => expect(store.getState().models).toEqual({ providers: [], models: [] }))
    expect(models()).toBe(1)
    source.send('system', {
      ...system,
      process: { ...system.process, generation: 2 },
    })
    expect(models()).toBe(2)

    source.send('notice', {
      level: 'warning',
      message: 'Unknown extension document: x',
    })
    expect(store.getState().notices.map((notice) => notice.message)).toEqual([
      'Unknown extension document: x',
    ])
    store.stop()
  })

  it('retries models a failed fetch left missing, also when the system info is unchanged', async () => {
    const { store, latest, fetch, models } = setup()
    latest().open()
    fetch.mockRejectedValueOnce(new Error('offline'))
    const system = {
      process: { pid: 1, generation: 1, node: 'v26', startedAt: '', url: '' },
    } as ServerEvents['system']
    latest().send('system', system)
    await vi.waitFor(() => expect(models()).toBe(1))
    expect(store.getState().models).toBeUndefined()
    latest().send('system', system)
    await vi.waitFor(() => expect(store.getState().models).toEqual({ providers: [], models: [] }))
    store.stop()
  })
})
