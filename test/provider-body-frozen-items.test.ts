import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import type { Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses'
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'

// Pi upstream: @earendil-works/pi-ai@1.5.2 dist/api/openai-responses.js, dist/api/openai-responses-shared.js — immutable item identities permit cached JSON only on the unchanged, understood path. Drop with the matching pnpm patch when upstream supports it.
const model: Model<'openai-responses'> = {
  id: 'test-model',
  name: 'Test model',
  provider: 'openai',
  api: 'openai-responses',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1000,
}
const providers = new Set(['openai'])
const context = normalizeContext({
  messages: [
    Object.freeze({
      role: 'user',
      timestamp: 0,
      content: Object.freeze([
        Object.freeze({ type: 'text', text: 'Quotes " slash \\ newline\n lone \ud800' }),
      ]),
    }),
    Object.freeze({ role: 'user', timestamp: 1, content: 'Second item' }),
  ],
} as Parameters<typeof normalizeContext>[0])
type Item = { role: string; content: { type: string; text: string }[] }
type Payload = { model: string; input: Item[]; stream: boolean; [key: string]: unknown }
type Edit = (payload: Payload) => Payload | void

async function request(edit?: Edit, flag: boolean | 'default' = true, transcript = context) {
  let payload: unknown
  let expected: string | undefined
  let actual: unknown
  const stringify = vi.spyOn(JSON, 'stringify')
  let cached = false
  try {
    const result = await streamSimple(model, transcript, {
      apiKey: 'sk-synthetic-only',
      ...(flag === 'default' ? {} : { cacheFrozenResponseItems: flag }),
      onPayload: (given) => {
        const replacement = edit?.(given as Payload)
        payload = replacement ?? given
        expected = JSON.stringify(payload)
        return replacement
      },
      fetch: async (_url, init) => {
        actual = init?.body
        cached = stringify.mock.calls.some(
          ([value, replacer]) => value === payload && typeof replacer === 'function',
        )
        const event = JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_test', status: 'completed', output: [] },
        })
        return new Response(`event: response.completed\ndata: ${event}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    }).result()
    expect(result.stopReason).toBe('stop')
    expect(actual).toBe(expected)
    return { actual, cached, payload: payload as Payload }
  } finally {
    stringify.mockRestore()
  }
}

it('returns stable deeply frozen items and keeps the raw SDK streaming body byte-identical', async () => {
  const options = { cacheFrozenResponseItems: true }
  const first = convertResponsesMessages(model, context, providers, options)
  const next = convertResponsesMessages(
    model,
    { ...context, messages: [...context.messages] },
    providers,
    options,
  )
  expect(next[0]).toBe(first[0])
  expect(Object.isFrozen(first[0])).toBe(true)
  const item = first[0] as Item
  expect(Object.isFrozen(item.content)).toBe(true)
  expect(Object.isFrozen(item.content[0])).toBe(true)
  expect((await request()).cached).toBe(true)
  expect((await request()).cached).toBe(true)
})

it('uses native JSON escaping for changed understood metadata, including lone surrogates', async () => {
  const result = await request((payload) => {
    payload.prompt_cache_key = 'key\ud800'
  })
  expect(result.cached).toBe(true)
  expect(result.actual).toContain('\\ud800')
  expect(
    (
      await request((payload) => {
        payload.model = '"input":[]'
      })
    ).cached,
  ).toBe(true)
  expect(
    (
      await request((payload) => {
        payload.prompt_cache_options = { input: [{ text: 'nested' }] }
      })
    ).cached,
  ).toBe(true)
})

it('rejects nested edits and array-length growth, including sloppy writes, without stale bytes', async () => {
  const response = await request((payload) => {
    const item = payload.input[0]
    expect(() => {
      item.content.length += 1
    }).toThrow(TypeError)
    expect(() => {
      item.content[0].text = 'changed'
    }).toThrow(TypeError)
    expect(Reflect.set(item.content, 'length', item.content.length + 1)).toBe(false)
    expect(Reflect.set(item.content[0], 'text', 'ignored sloppy assignment')).toBe(false)
    runInNewContext('item.content.length += 1; item.content[0].text = "sloppy edit"', { item })
    expect(item.content).toHaveLength(1)
    expect(item.content[0].text).not.toBe('sloppy edit')
  })
  expect(response.cached).toBe(true)
})

it('freezes copied system tool declarations without freezing caller-owned schemas', () => {
  const schema = { type: 'object', properties: { input: { type: 'string' } } }
  const source = normalizeContext({
    messages: [
      {
        role: 'system',
        content: 'Tools',
        timestamp: 0,
        toolsAdded: [{ name: 'read', description: 'Read', parameters: schema }],
      },
    ],
  })
  const options = { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true }
  const expected = JSON.stringify(convertResponsesMessages(model, source, providers, options))
  const items = convertResponsesMessages(model, source, providers, {
    ...options,
    cacheFrozenResponseItems: true,
  })
  expect(JSON.stringify(items)).toBe(expected)
  expect(items.every(Object.isFrozen)).toBe(true)
  expect(Object.isFrozen(schema)).toBe(false)
  expect(Object.isFrozen(schema.properties)).toBe(false)
})

const fallback: [string, Edit][] = [
  [
    'replacement item',
    (p) => {
      p.input[0] = { role: 'user', content: [{ type: 'input_text', text: 'new' }] }
    },
  ],
  [
    'reordered items',
    (p) => {
      p.input.reverse()
    },
  ],
  [
    'splice',
    (p) => {
      p.input.splice(0, 1)
    },
  ],
  [
    'sparse input',
    (p) => {
      Reflect.deleteProperty(p.input, '0')
    },
  ],
  [
    'grown input length',
    (p) => {
      p.input.length += 1
    },
  ],
  [
    'replacement with a grown nested array',
    (p) => {
      const content = [...p.input[0].content]
      content.length += 1
      p.input[0] = { ...p.input[0], content }
    },
  ],
  [
    'proxy replacement',
    (p) => {
      p.input[0] = new Proxy(p.input[0], {})
    },
  ],
  [
    'metadata proxy',
    (p) => {
      p.prompt_cache_options = new Proxy({ mode: 'explicit' }, {})
    },
  ],
  [
    'new array',
    (p) => {
      p.input = [...p.input]
    },
  ],
  ['new root', (p) => ({ ...p })],
  [
    'reordered existing root keys',
    (p) => {
      const stream = p.stream
      Reflect.deleteProperty(p, 'stream')
      p.stream = stream
    },
  ],
  [
    'top-level addition',
    (p) => {
      p.temperature = 0
    },
  ],
  [
    'root toJSON',
    (p) => {
      p.toJSON = () => ({ model: p.model, input: p.input, stream: true })
    },
  ],
  [
    'array toJSON',
    (p) => {
      Object.defineProperty(p.input, 'toJSON', {
        value: (key: string) => [{ role: 'user', content: [{ type: 'input_text', text: key }] }],
      })
    },
  ],
  [
    'item toJSON',
    (p) => {
      p.input[0] = {
        toJSON: (key: string) => ({ role: 'user', content: [{ type: 'input_text', text: key }] }),
      } as unknown as Item
    },
  ],
  [
    'root getter',
    (p) => {
      const input = p.input
      Object.defineProperty(p, 'input', { enumerable: true, get: () => input })
    },
  ],
  [
    'item getter',
    (p) => {
      p.input[0] = Object.defineProperty({ role: 'user' }, 'content', {
        enumerable: true,
        get: () => [{ type: 'input_text', text: 'getter' }],
      }) as Item
    },
  ],
  [
    'nested metadata getter',
    (p) => {
      p.prompt_cache_options = Object.defineProperty({}, 'mode', {
        enumerable: true,
        get: () => 'explicit',
      })
    },
  ],
  [
    'nested metadata toJSON',
    (p) => {
      p.prompt_cache_options = { toJSON: (key: string) => ({ mode: key }) }
    },
  ],
]
it.each(fallback)('uses the SDK encoder for %s', async (_name, edit) => {
  expect((await request(edit)).cached).toBe(false)
})

it('supports empty input and keeps the default/off path mutable and normally encoded', async () => {
  expect((await request(undefined, true, normalizeContext({ messages: [] }))).cached).toBe(true)
  for (const flag of [false, 'default'] as const) {
    const result = await request((payload) => {
      expect(Object.isFrozen(payload.input[0])).toBe(false)
      payload.input[0].content.length += 1
      payload.input[0].content[0].text = 'ordinary mutable hook'
    }, flag)
    expect(result.cached).toBe(false)
    expect(result.actual).toContain('null')
  }
})
