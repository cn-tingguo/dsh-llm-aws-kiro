import { describe, expect, it } from 'vitest'
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import { CHARS_PER_TOKEN, translate } from '../src/translate.ts'
import type { KiroStreamEvent } from '../src/types.ts'

async function collect(events: KiroStreamEvent[], contextWindow = 200_000) {
  const chunks: unknown[] = []
  for await (const chunk of translate(events, contextWindow)) chunks.push(chunk)
  return chunks
}

describe('llm-kiro translate', () => {
  it('translates a text response with usage', async () => {
    const chunks = await collect([
      { type: 'contextUsage', data: { contextUsagePercentage: 12 } },
      { type: 'content', data: 'hello' },
      { type: 'content', data: ' world' },
      { type: 'usage', data: { inputTokens: 24, outputTokens: 2 } },
    ])
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: ' world' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } })
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 24, outputTokens: 2 } })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('estimates output tokens from emitted text when the usage event is empty', async () => {
    // The live runtime sends `usage: {}`; reporting 0 output tokens would be wrong.
    const chunks = await collect([
      { type: 'contextUsage', data: { contextUsagePercentage: 1 } },
      { type: 'content', data: 'hello' },
      { type: 'content', data: ' world' },
      { type: 'usage', data: {} },
    ])
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 2000, outputTokens: Math.ceil(11 / CHARS_PER_TOKEN) } })
  })

  it('keeps every content event, including ones identical to the previous', async () => {
    // The runtime fragments a stream arbitrarily, so two equal chunks are
    // ordinary repeated output rather than a heartbeat. Dropping them lost real
    // text: a ten-line repeat arrived as six.
    const chunks = await collect([
      { type: 'content', data: 'ok\n' },
      { type: 'content', data: 'ok\n' },
      { type: 'content', data: 'ok\n' },
    ])
    const deltas = chunks.filter(chunk => (chunk as { type: string }).type === 'text-delta')
    expect(deltas).toHaveLength(3)
    const text = deltas.map(chunk => (chunk as { text: string }).text).join('')
    expect(text).toBe('ok\nok\nok\n')
  })

  it('translates thinking into a reasoning block closed by the signature', async () => {
    const chunks = await collect([
      { type: 'thinkingText', data: 'hmm' },
      { type: 'thinkingText', data: ' more' },
      { type: 'thinkingSignature', data: 'sig' },
      { type: 'content', data: 'answer' },
    ])
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'hmm' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hmm more' } })
    expect(chunks).toContainEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('translates a tool call stream into a tool-call block with a tool-calls finish', async () => {
    const chunks = await collect([
      { type: 'toolUse', data: { name: 'run_shell', toolUseId: 'call-1', input: '{"cmd":' } },
      { type: 'toolUseInput', data: { input: '"ls"' } },
      { type: 'toolUseStop', data: { stop: true } },
    ])
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks).toContainEqual({
      type: 'tool-call-delta',
      index: 0,
      id: 'call-1',
      name: 'run_shell',
      argumentsDelta: '{"cmd":',
    })
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-1', name: 'run_shell', arguments: '{"cmd":"ls"' },
    })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('closes an unstopped tool call at stream end', async () => {
    const chunks = await collect([
      { type: 'toolUse', data: { name: 'sh', toolUseId: 'c1', input: '' } },
    ])
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'c1', name: 'sh', arguments: '' },
    })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('reports an error finish for an error event', async () => {
    const events = [
      { type: 'error' as const, data: { error: 'boom', message: 'detail' } },
    ]
    await expect(collect(events)).rejects.toThrow('boom: detail')
  })

  it('ignores followup prompts and reports empty responses as EMPTY_RESPONSE', async () => {
    const chunks = await collect([
      { type: 'followupPrompt', data: 'want more?' },
      { type: 'contextUsage', data: { contextUsagePercentage: 3 } },
    ])
    expect(chunks).toContainEqual({
      type: 'finish',
      reason: { kind: 'error', failure: expect.objectContaining({ code: EMPTY_RESPONSE_CODE }) },
    })
    const usage = chunks.find(chunk => (chunk as { type: string }).type === 'usage') as { usage: { inputTokens: number } }
    expect(usage.usage.inputTokens).toBe(6000)
  })

  it('emits usage before the finish chunk', async () => {
    const chunks = await collect([{ type: 'content', data: 'x' }])
    const usageIndex = chunks.findIndex(chunk => (chunk as { type: string }).type === 'usage')
    const finishIndex = chunks.findIndex(chunk => (chunk as { type: string }).type === 'finish')
    expect(usageIndex).toBeGreaterThanOrEqual(0)
    expect(finishIndex).toBeGreaterThan(usageIndex)
  })
})