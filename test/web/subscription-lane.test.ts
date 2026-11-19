import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import { createStore } from '../../web/src/sdk/store.ts'
import { createSubscriptionLane } from '../../web/src/sdk/subscription-lane.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const tick = () => vi.advanceTimersByTimeAsync(10)
const id = (value: number) => value as ConversationId

function setup() {
  const sources: FakeSource[] = []
  const server = fakeSubscriptions(sources)
  const held: {
    conversation: number
    stream: string
    sub: number
    spec: { docs: string[] }
    finish: () => void
  }[] = []
  let hold = true
  const fetch = vi.fn<typeof globalThis.fetch>(async (path, init) => {
    const response =
      server.handle(path as string, init) ?? Response.json({ providers: [], models: [] })
    if (init?.method === 'POST') {
      const spec = JSON.parse(init.body as string)
      if (!spec.view && spec.conversation >= 10 && hold) {
        const gate = Promise.withResolvers<Response>()
        const [, stream, sub] = /^\/api\/events\/([^/]+)\/(\d+)$/.exec(path as string)!
        held.push({
          conversation: spec.conversation,
          stream,
          sub: Number(sub),
          spec,
          finish: () => gate.resolve(response),
        })
        init.signal!.addEventListener('abort', () => gate.reject(init.signal!.reason), {
          once: true,
        })
        return gate.promise
      }
    }
    return response
  })
  const store = createStore({
    fetch,
    eventSource: (url) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
  })
  store.start()
  sources[0].open()
  return {
    store,
    server,
    held,
    fetch,
    source: sources[0],
    release: () => {
      hold = false
      for (const request of held) request.finish()
    },
  }
}

it('leaves background work FIFO and drains it even when interactive work keeps arriving', async () => {
  const lane = createSubscriptionLane(2),
    signal = new AbortController().signal
  const order: number[] = [],
    gates = Array.from({ length: 6 }, () => Promise.withResolvers<void>())
  const pending = gates.map((gate, index) =>
    lane.run(
      async () => {
        order.push(index)
        await gate.promise
      },
      () => false,
      signal,
    ),
  )
  expect(order).toEqual([0, 1])
  await lane.run(
    async () => {
      order.push(100)
    },
    () => true,
    signal,
  )
  expect(order).toEqual([0, 1, 100])
  for (const gate of gates) {
    gate.resolve()
    await tick()
  }
  await Promise.all(pending)
  expect(order).toEqual([0, 1, 100, 2, 3, 4, 5])
})

it('sends the shown view, root and scoped view immediately and promotes its queued docs once', async () => {
  const { store, server, held, fetch, release } = setup()
  await tick()
  for (let conversation = 10; conversation < 15; conversation++)
    store.watchDocOf(id(conversation), 'test.counter')
  await tick()
  expect(held.map((request) => request.conversation)).toEqual([10, 11, 12, 13])
  store.show(id(14))
  store.watchDocOf(id(1), 'test.root')
  store.watchConversation(id(20))
  await tick()
  expect(held.map((request) => request.conversation)).toEqual([10, 11, 12, 13, 14])
  expect(server.of(14)!.view).toBe(true)
  expect(server.of(1)!.docs).toEqual(['test.root'])
  expect(server.of(20)!.view).toBe(true)
  release()
  await tick()
  expect(held.filter((request) => request.conversation === 14)).toHaveLength(1)
  expect(
    fetch.mock.calls.filter(
      ([, init]) => init?.method === 'POST' && JSON.parse(init.body as string).conversation === 14,
    ),
  ).toHaveLength(2)
  store.stop()
})

it('never sends a queued subscription or a DELETE when its last watch closes', async () => {
  const { store, server, fetch, release } = setup()
  await tick()
  for (let conversation = 10; conversation < 14; conversation++)
    store.watchDocOf(id(conversation), 'test.counter')
  const stop = store.watchDocOf(id(14), 'test.counter')
  await tick()
  stop()
  await tick()
  release()
  await tick()
  expect(server.of(14)).toBeUndefined()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0)
  store.stop()
})

it('aborts an old lane on reconnect and starts the new stream with full wanted specs', async () => {
  const { store, held, server, source, release } = setup()
  await tick()
  for (let conversation = 10; conversation < 16; conversation++)
    store.watchDocOf(id(conversation), 'test.first')
  await tick()
  const oldStream = source.id
  store.watchDocOf(id(14), 'test.second')
  await tick()
  source.drop()
  source.open()
  await tick()
  expect(server.of()!.stream).toBe(source.id)
  expect(
    held.filter((request) => request.stream === oldStream).map((request) => request.conversation),
  ).toEqual([10, 11, 12, 13])
  release()
  await tick()
  expect(server.of(14)!.stream).toBe(source.id)
  expect(server.of(14)!.docs).toEqual(['test.first', 'test.second'])
  store.stop()
})

it('releases background capacity after a current subscription receives a 404', async () => {
  const { store, held, server, release } = setup()
  await tick()
  server.refuse(10, 404)
  for (let conversation = 10; conversation < 15; conversation++)
    store.watchDocOf(id(conversation), 'test.counter')
  await tick()
  expect(held.map((request) => request.conversation)).toEqual([10, 11, 12, 13])
  held[0].finish()
  await tick()
  expect(held.map((request) => request.conversation)).toEqual([10, 11, 12, 13, 14])
  expect(server.of(10)).toBeUndefined()
  release()
  await tick()
  store.stop()
})

it('keeps a sent subscription alive until its queued DELETE follows pending creates', async () => {
  const { store, held, server, fetch, release } = setup()
  await tick()
  const stop = store.watchDocOf(id(10), 'test.counter')
  for (let conversation = 11; conversation < 17; conversation++)
    store.watchDocOf(id(conversation), 'test.counter')
  await tick()
  held[0].finish()
  await tick()
  expect(held.map((request) => request.conversation)).toEqual([10, 11, 12, 13, 14])
  stop()
  await tick()
  expect(server.of(10)).toBeDefined()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0)
  release()
  await tick()
  expect(server.of(10)).toBeUndefined()
  const changes = fetch.mock.calls.filter(
    ([, init]) => init?.method === 'POST' || init?.method === 'DELETE',
  )
  expect(changes.at(-1)![1]!.method).toBe('DELETE')
  store.stop()
})

it('keeps updates behind their own create and prevents a queued update overtaking close', async () => {
  const { store, held, server, fetch, release } = setup()
  await tick()
  const first = store.watchDocOf(id(10), 'test.first')
  await tick()
  const second = store.watchDocOf(id(10), 'test.second')
  await tick()
  expect(held).toHaveLength(1)
  held[0].finish()
  await tick()
  expect(held).toHaveLength(2)
  expect(held.map((request) => request.spec.docs)).toEqual([
    ['test.first'],
    ['test.first', 'test.second'],
  ])
  first()
  second()
  await tick()
  release()
  await tick()
  expect(server.of(10)).toBeUndefined()
  const changes = fetch.mock.calls
    .filter(([path]) => (path as string).endsWith('/' + held[0].sub))
    .map(([, init]) => init!.method)
  expect(changes).toEqual(['POST', 'POST', 'DELETE'])
  store.stop()
})
