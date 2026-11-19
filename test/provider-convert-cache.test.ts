import { expect, it, vi } from 'vitest'
import type { Model, TranscriptContext } from '@earendil-works/pi-ai'
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'

// Pi upstream: @earendil-works/pi-ai@1.5.2 dist/api/openai-responses-shared.js — cache immutable transcript conversions without sharing mutable payloads. Drop with the matching pnpm patch when upstream caches conversion.
const model: Model<'openai-responses'> = {
  id: 'test-model',
  name: 'Test model',
  provider: 'openai',
  api: 'openai-responses',
  baseUrl: 'https://example.invalid/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1000,
}
const providers = new Set(['openai'])

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function transcript(): TranscriptContext {
  return normalizeContext({
    messages: [
      { role: 'user', content: 'Inspect \ud800 this file', timestamp: 1 },
      {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          {
            type: 'thinking',
            thinking: '',
            thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_1', summary: [] }),
          },
          { type: 'text', text: 'Reading the file' },
          {
            type: 'toolCall',
            id: 'call_1|fc_1',
            name: 'read',
            arguments: { path: 'sample.ts' },
          },
        ],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_1|fc_1',
        toolName: 'read',
        content: [{ type: 'text', text: 'const value = 1' }],
        isError: false,
        timestamp: 3,
      },
    ],
  })
}

it('reuses immutable messages across new history arrays without parsing their reasoning again', () => {
  const context = freeze(transcript())
  const expected = JSON.stringify(convertResponsesMessages(model, transcript(), providers))
  const parse = vi.spyOn(JSON, 'parse')
  try {
    const first = convertResponsesMessages(model, context, providers)
    expect(parse).toHaveBeenCalledTimes(1)
    const second = convertResponsesMessages(
      model,
      { ...context, messages: [...context.messages] },
      providers,
    )
    expect(parse).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(first)).toBe(expected)
    expect(JSON.stringify(second)).toBe(expected)
    expect(second[1]).not.toBe(first[1])
  } finally {
    parse.mockRestore()
  }
})

it('keeps payload edits private and does not cache mutable or shallow-frozen messages', () => {
  const context = freeze(transcript())
  const expected = JSON.stringify(convertResponsesMessages(model, context, providers))
  const payload = convertResponsesMessages(model, context, providers)
  const reasoning = payload.find((item) => 'type' in item && item.type === 'reasoning')!
  Object.assign(reasoning, { summary: [{ type: 'summary_text', text: 'hook edit' }] })
  expect(JSON.stringify(convertResponsesMessages(model, context, providers))).toBe(expected)

  for (const shallow of [false, true]) {
    const mutable = transcript()
    if (shallow) for (const message of mutable.messages) Object.freeze(message)
    convertResponsesMessages(model, mutable, providers)
    const result = mutable.messages[2]
    if (result.role !== 'toolResult' || result.content[0].type !== 'text')
      throw new Error('fixture')
    result.content[0].text = 'changed result'
    expect(JSON.stringify(convertResponsesMessages(model, mutable, providers))).toContain(
      'changed result',
    )
  }
})
