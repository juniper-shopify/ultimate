import { afterEach, expect, it, vi } from 'vitest'
import { streamClient } from './e2e/fleet-benchmark/stream.ts'
import { until } from './helpers.ts'

afterEach(() => vi.unstubAllGlobals())

it('counts framed bytes and follows incremental tasks, upserts and document subscriptions', async () => {
  const frame = (event: string, value: unknown, sub?: number) =>
    `event: ${event}\n${sub === undefined ? '' : `data: ${sub}\n`}data: ${JSON.stringify(value)}\n\n`
  const future = frame('benchmark.future', { text: 'Synthetic 🧪' })
  const bytes = new TextEncoder().encode(
    [
      frame('stream', { id: 'synthetic' }),
      frame('tasks', { tasks: {} }),
      frame('tasksOps', { ops: [['s', ['tasks', 'sample'], { phase: 'done' }]] }),
      frame('conversations', [
        { id: 1, busy: false },
        { id: 2, busy: false },
      ]),
      frame('conversationsUpsert', [
        { id: 1, busy: true },
        { id: 3, busy: false },
      ]),
      frame('doc', { kind: 'example.progress', value: { count: 0 } }, 1),
      frame('docOps', { kind: 'example.progress', ops: [['s', ['count'], 1]] }, 1),
      future,
    ].join(''),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < bytes.length; index += 7)
                controller.enqueue(bytes.slice(index, index + 7))
              controller.close()
            },
          }),
        ),
    ),
  )
  const client = await streamClient('http://127.0.0.1:1', 1)
  try {
    await until(() => client.counts().some((row) => row.event === 'benchmark.future'))
    expect(client.state()).toMatchObject({
      tasks: { tasks: { sample: { phase: 'done' } } },
      conversations: [
        { id: 1, busy: true },
        { id: 2, busy: false },
        { id: 3, busy: false },
      ],
      docs: { 'example.progress': { count: 1 } },
    })
    expect(client.counts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'tasksOps', delivery: 'operations', count: 1 }),
        expect.objectContaining({ event: 'conversationsUpsert', delivery: 'operations', count: 1 }),
        expect.objectContaining({
          event: 'docOps',
          document: 'example.progress',
          subscription: '1',
        }),
        expect.objectContaining({
          event: 'benchmark.future',
          count: 1,
          bytes: Buffer.byteLength(future),
          largestPayload: Buffer.byteLength(JSON.stringify({ text: 'Synthetic 🧪' })),
        }),
      ]),
    )
  } finally {
    await client.close()
  }
})
