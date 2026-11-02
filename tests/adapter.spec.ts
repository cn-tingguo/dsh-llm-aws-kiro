/**
 * KiroAdapter transport tests against the scripted local mock server:
 * request shape, attribution headers, stream translation, auth-recovery,
 * capacity retries, timeouts, and error classification.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { KiroAdapter } from '../src/adapter.ts'
import type { KiroAdapterOptions, KiroConnectionOptions } from '../src/adapter.ts'
import type { KiroCredentials } from '../src/types.ts'
import { closeMockServers, mockServer, textEvents, thinkingTextEvents, toolCallEvents, type Behavior } from './mock-server.ts'
import { DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/adapter.ts'

const credential: KiroCredentials = {
  access: 'token-1',
  refresh: 'refresh-1|c|s|idc',
  expires: Date.now() + 3600_000,
  clientId: 'c',
  clientSecret: 's',
  region: 'us-east-1',
  authMethod: 'idc',
  profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/test',
}

let lastMockURL: string | undefined

afterEach(() => {
  lastMockURL = undefined
})

async function serverWith(script: Behavior[]): Promise<ReturnType<typeof mockServer>> {
  const server = await mockServer(script)
  lastMockURL = server.url
  return server
}

function connection(overrides: Partial<KiroConnectionOptions> = {}): KiroConnectionOptions {
  return {
    ...(lastMockURL !== undefined ? { runtimeURL: lastMockURL } : {}),
    models: [
      { id: 'claude-sonnet-4-6', kiroModelId: 'claude-sonnet-4.6', name: 'Sonnet', reasoning: true, contextWindow: 200000, maxTokens: 65536, inputModalities: ['text', 'image'] },
      { id: 'glm-5', kiroModelId: 'glm-5', name: 'GLM 5', reasoning: true, contextWindow: 200000, maxTokens: 8192, inputModalities: ['text'] },
    ],
    defaultContextWindow: 200000,
    maxTokens: 8192,
    thinking: 'enabled',
    reasoningEffort: 'high',
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    firstTokenTimeoutMs: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
    retryPolicy: { mode: 'normal', maxRetries: 5 },
    allowKiroCliRefresh: true,
    ...overrides,
  }
}

function adapter(
  overrides: Partial<KiroAdapterOptions> = {},
  resolveCredential = vi.fn(async () => credential),
  recoverCredential = vi.fn(async () => undefined),
): KiroAdapter {
  return new KiroAdapter({
    options: () => connection(),
    resolveCredential,
    recoverCredential,
    ...overrides,
  })
}

function request(overrides: Record<string, unknown> = {}): any {
  return {
    provider: 'kiro',
    model: 'claude-sonnet-4-6',
    reasoningEffort: 'off',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    }],
    ...overrides,
  }
}

async function collect(chunks: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

afterEach(async () => {
  await closeMockServers()
  vi.restoreAllMocks()
})

describe('llm-kiro adapter stream', () => {
  it('streams a text response with the attribution user-agent and request shape', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    const chunks = await collect(adapter().stream(request()))
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
    // The runtime's client-identity gate requires the SDK-shaped UA on both
    // headers; the harness attribution UA is rejected with 403.
    // The harness attribution must ride along (adapter contract), and the AWS
    // prefix must stay verbatim: the backend rejects a user-agent without it.
    const userAgent = server.headers[0]?.['user-agent'] ?? ''
    expect(userAgent).toMatch(/^aws-sdk-rust\/1\.0\.0 ua\/2\.1 os\/other lang\/js api\/codewhispererstreaming#1\.28\.3 m\/E app\/AmazonQ-For-CLI md\/appVersion-\S+/)
    expect(userAgent).toContain('deepseek-harness/')
    expect(server.headers[0]?.['x-amz-user-agent']).toBe(userAgent)
    expect(server.headers[0]?.authorization).toBe('Bearer token-1')
    expect(server.headers[0]?.accept).toBe('application/vnd.amazon.eventstream')
    expect(server.headers[0]?.['x-amzn-codewhisperer-optout']).toBe('true')
    expect(server.headers[0]?.['x-amzn-kiro-agent-mode']).toBe('vibe')
    const body = server.requests[0] as Record<string, unknown>
    expect(body.profileArn).toBe('arn:aws:codewhisperer:us-east-1:123:profile/test')
    expect(body.agentMode).toBe('vibe')
    expect((body.conversationState as Record<string, unknown>).chatTriggerType).toBe('MANUAL')
    expect((body.conversationState as Record<string, unknown>).currentMessage).toMatchObject({
      userInputMessage: {
        content: 'hello',
        modelId: 'claude-sonnet-4.6',
        origin: 'KIRO_CLI',
      },
    })
  })

  it('folds the leading system message into the current user content on the wire', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    await collect(adapter().stream(request({
      reasoningEffort: 'off',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'SYSTEM_PROMPT_MARKER be brief' }] },
        { role: 'user', content: [{ type: 'text', text: 'the question' }] },
        { role: 'user', content: [{ type: 'text', text: 'runtime context' }] },
      ],
    })))
    const body = server.requests[0] as Record<string, unknown>
    const cs = body.conversationState as Record<string, unknown>
    const content = (cs.currentMessage as any).userInputMessage.content as string
    // The system prompt rides the current turn (the classic wire has no system
    // field), every user message is merged, and nothing is stranded in history.
    expect(content).toBe('SYSTEM_PROMPT_MARKER be brief\n\nthe question\n\nruntime context')
    expect(cs.history).toBeUndefined()
  })

  it('records the transport failure cause in the error message', async () => {
    // A connection reset before any HTTP response: the adapter must surface why,
    // not a bare "Kiro API stream failed", so the session log can diagnose it.
    const inst = adapter({ options: () => connection({ runtimeURL: 'http://127.0.0.1:1/generateAssistantResponse' }) })
    let caught: any
    try { await collect(inst.stream(request())) } catch (error) { caught = error }
    expect(caught.code).toBe('TRANSPORT')
    expect(caught.message).toMatch(/^Kiro API stream failed: .+/)
    expect(caught.cause).toBeInstanceOf(Error)
  })

  it('streams thinking and tool calls with a tool-calls finish', async () => {
    const server = await serverWith([
      { kind: 'eventstream', events: thinkingTextEvents },
      { kind: 'eventstream', events: toolCallEvents },
    ])
    const thinking = await collect(adapter().stream(request({ model: 'glm-5' })))
    expect(thinking).toContainEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    const tools = await collect(adapter().stream(request()))
    expect(tools).toContainEqual({ type: 'block-end', index: 0, block: expect.objectContaining({ type: 'tool-call' }) })
    expect(tools).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(server.requests).toHaveLength(2)
  })

  it('enables reasoning through structured fields, not a content text marker', async () => {
    // The <thinking_mode> text marker made the model echo literal
    // <thinking>...</thinking> tags into visible content (verified live), so
    // reasoning now rides only the structured additionalModelRequestFields.
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    await collect(adapter().stream(request({ reasoningEffort: 'max' })))
    const body = server.requests[0] as Record<string, unknown>
    const current = (body.conversationState as Record<string, unknown>).currentMessage as Record<string, unknown>
    const content = (current.userInputMessage as Record<string, unknown>).content as string
    expect(content).not.toContain('<thinking_mode>')
    expect(content).not.toContain('<max_thinking_length>')
    expect(body.additionalModelRequestFields).toMatchObject({
      output_config: { effort: 'max' },
      thinking: { type: 'adaptive' },
    })
  })

  it('omits reasoning fields when the effort is off', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    await collect(adapter().stream(request({ reasoningEffort: 'off' })))
    const body = server.requests[0] as Record<string, unknown>
    const current = (body.conversationState as Record<string, unknown>).currentMessage as Record<string, unknown>
    expect((current.userInputMessage as Record<string, unknown>).content).not.toContain('<thinking_mode>')
    expect(body.additionalModelRequestFields).toBeUndefined()
  })

  it('does not enable thinking for a model outside the served catalog', async () => {
    // claude-opus-4-6 resolves to a known wire id but is not in this
    // connection's explicit catalog, so the picker offered it only 'off'.
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    await collect(adapter().stream(request({ model: 'claude-opus-4-6', reasoningEffort: 'high' })))
    const body = server.requests[0] as Record<string, unknown>
    const current = (body.conversationState as Record<string, unknown>).currentMessage as Record<string, unknown>
    expect((current.userInputMessage as Record<string, unknown>).content).not.toContain('<thinking_mode>')
    expect(body.additionalModelRequestFields).toBeUndefined()
  })

  it('recovers from a 403 with a rotated credential and retries once', async () => {
    const server = await serverWith([
      { kind: 'http-error', status: 403, body: 'Forbidden' },
      { kind: 'eventstream', events: textEvents },
    ])
    const recoverCredential = vi.fn(async () => ({ ...credential, access: 'token-2' }))
    const chunks = await collect(adapter({ recoverCredential }).stream(request()))
    expect(chunks.some(chunk => (chunk as { type: string }).type === 'finish')).toBe(true)
    expect(server.headers).toHaveLength(2)
    expect(server.headers[1]?.authorization).toBe('Bearer token-2')
  })

  it('fails with AUTH when recovery finds nothing new', async () => {
    const server = await serverWith([{ kind: 'http-error', status: 403, body: 'Forbidden' }])
    const error = await collect(adapter().stream(request())).catch(error => error)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ code: 'AUTH' })
  })

  it('retries capacity rejections with backoff before streaming', async () => {
    const server = await serverWith([
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
      { kind: 'eventstream', events: textEvents },
    ])
    const chunks = await collect(adapter({ options: () => connection({ capacityDelayMs: () => 1 }) }).stream(request()))
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.requests).toHaveLength(3)
  })

  it('gives up on capacity after the retry budget', async () => {
    const server = await serverWith([
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
      { kind: 'http-error', status: 429, body: 'INSUFFICIENT_MODEL_CAPACITY' },
    ])
    await expect(collect(adapter({ options: () => connection({ capacityDelayMs: () => 1 }) }).stream(request())))
      .rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('classifies quota, context-overflow, and server errors', async () => {
    await closeMockServers()
    const quota = await serverWith([{ kind: 'http-error', status: 429, body: 'MONTHLY_REQUEST_COUNT exceeded' }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'QUOTA' })
    await closeMockServers()
    const big = await serverWith([{ kind: 'http-error', status: 400, body: 'Input is too long' }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    await closeMockServers()
    const serverErr = await serverWith([{ kind: 'http-error', status: 500, body: 'boom' }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('surfaces local history overflow as CONTEXT_WINDOW_EXCEEDED without a request', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    const small = adapter({
      options: () => connection({
        models: [{ id: 'glm-5', kiroModelId: 'glm-5', name: 'GLM 5', reasoning: false, contextWindow: 1_000, maxTokens: 100, inputModalities: ['text'] }],
      }),
    })
    await expect(collect(small.stream(request({
      model: 'glm-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'x'.repeat(10_000) }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
    })))).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(server.requests).toHaveLength(0)
  })

  it('classifies an in-stream context overflow instead of calling it SERVER', async () => {
    await serverWith([{ kind: 'eventstream', events: [
      { eventType: 'conversation', payload: { error: 'MODEL_CONTEXT_WINDOW_EXCEEDED', message: 'too long' } },
    ] }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    await closeMockServers()
    await serverWith([{ kind: 'eventstream', events: [
      { eventType: 'conversation', payload: { error: 'InternalServerException', message: 'boom' } },
    ] }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('classifies the reverse-engineered error codes', async () => {
    // Daily and credit limits join the monthly one as QUOTA.
    await closeMockServers()
    await serverWith([{ kind: 'http-error', status: 429, body: 'DAILY_REQUEST_COUNT_LIMIT_EXCEEDED' }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'QUOTA' })
    // The stop-reason spelling of context overflow is recognized too.
    await closeMockServers()
    await serverWith([{ kind: 'http-error', status: 400, body: 'MODEL_CONTEXT_WINDOW_EXCEEDED' }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    // A malformed-request code maps to INVALID_REQUEST even off the 400 path.
    await closeMockServers()
    await serverWith([{ kind: 'http-error', status: 422, body: 'THINKING_SIGNATURE_INVALID' }])
    await expect(collect(adapter().stream(request()))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('maps caller abort to ABORTED', async () => {
    const controller = new AbortController()
    const server = await serverWith([{ kind: 'eventstream', events: [{ eventType: 'conversation', payload: { content: 'x' } }], stallAfterMs: 60_000 }])
    const pending = collect(adapter().stream(request({ signal: controller.signal }))).catch(error => error)
    setTimeout(() => controller.abort('test abort'), 50)
    const error = await pending
    expect(error).toMatchObject({ code: 'ABORTED' })
  })

  it('fails with TIMEOUT when the first token never arrives', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: [], stallAfterMs: 60_000 }])
    await expect(collect(adapter({ options: () => connection({ firstTokenTimeoutMs: 50 }) }).stream(request())))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('fails with TIMEOUT on the idle watchdog', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: [{ eventType: 'conversation', payload: { content: 'a' } }], stallAfterMs: 60_000 }])
    await expect(collect(adapter({ options: () => connection({ streamIdleTimeoutMs: 80 }) }).stream(request())))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('rejects image input without the attachment service or image capability', async () => {
    const imageMessage = {
      role: 'user',
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId('sha256:' + 'a'.repeat(64)),
          mediaType: 'image/png' as const,
          bytes: 3,
          width: 1,
          height: 1,
        },
      }],
    }
    await expect(collect(adapter().stream(request({ model: 'glm-5', messages: [imageMessage] }))))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(collect(adapter().stream(request({ messages: [imageMessage] }))))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('sends image bytes resolved through the attachment store', async () => {
    const store = {
      readImage: vi.fn(async (ref: ImageAttachmentRef) => ({
        ref,
        data: Uint8Array.of(1, 2, 3),
      })),
    } as unknown as AttachmentStore
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    const imageMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId('sha256:' + 'a'.repeat(64)),
            mediaType: 'image/png' as const,
            bytes: 3,
            width: 1,
            height: 1,
          },
        },
      ],
    }
    await collect(adapter({ resolveAttachments: () => store }).stream(request({ messages: [imageMessage] })))
    const body = server.requests[0] as Record<string, unknown>
    const current = (body.conversationState as Record<string, unknown>).currentMessage as Record<string, unknown>
    expect((current.userInputMessage as Record<string, unknown>).images).toEqual([
      { format: 'png', source: { bytes: 'AQID' } },
    ])
    expect(store.readImage).toHaveBeenCalledOnce()
  })

  it('resolves the profile through the management API when not provided', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    const realFetch = globalThis.fetch.bind(globalThis)
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('List-Available-Profiles')) {
        return new Response(JSON.stringify({ profiles: [{ arn: 'arn:discovered' }] }), { status: 200 })
      }
      return realFetch(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const noProfile = vi.fn(async () => ({
      access: 'token-1',
      refresh: 'refresh-1|c|s|idc',
      expires: Date.now() + 3600_000,
      clientId: 'c',
      clientSecret: 's',
      region: 'us-east-1',
      authMethod: 'idc' as const,
    }))
    await collect(adapter({}, noProfile).stream(request()))
    const body = server.requests[0] as Record<string, unknown>
    expect(body.profileArn).toBe('arn:discovered')
    vi.unstubAllGlobals()
  })

  it('listModels and resolveModel expose catalog metadata', async () => {
    const inst = adapter()
    const models = await inst.listModels('kiro')
    expect(models.map(model => model.id)).toContain('claude-sonnet-4-6')
    const resolved = await inst.resolveModel('kiro', 'claude-sonnet-4-6')
    expect(resolved).toMatchObject({
      context: { contextWindow: 200000 },
      defaultMaxTokens: 65536,
      reasoning: { efforts: expect.any(Array), defaultEffort: expect.any(String) },
    })
    const passThrough = await inst.resolveModel('kiro', 'unknown-model')
    expect(passThrough).toMatchObject({ id: 'unknown-model', context: { contextWindow: 200000 } })
    const locked = adapter({ options: () => connection({ thinking: 'disabled' }) })
    const lockedResolved = await locked.resolveModel('kiro', 'claude-sonnet-4-6')
    expect(lockedResolved.reasoning).toEqual({
      efforts: [{ id: 'off', name: 'Off' }],
      defaultEffort: 'off',
    })
    expect(inst.providerInfo('kiro')).toEqual({ id: 'kiro', name: 'Kiro' })
    expect(inst.providerRetryPolicy('kiro')).toEqual({ mode: 'normal', maxRetries: 5 })
  })

  it('offers the model ladder in the effort picker and rounds the default onto it', async () => {
    const sonnet = await adapter().resolveModel('kiro', 'claude-sonnet-4-6')
    expect(sonnet.reasoning).toEqual({
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'high',
    })
    const glm = await adapter().resolveModel('kiro', 'glm-5')
    expect(glm.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'high', 'max'])
    const xhighDefault = adapter({ options: () => connection({ reasoningEffort: 'xhigh' }) })
    expect((await xhighDefault.resolveModel('kiro', 'claude-sonnet-4-6')).reasoning?.defaultEffort).toBe('max')
  })

  it('sends a picked rung verbatim when the model offers it', async () => {
    const server = await serverWith([{ kind: 'eventstream', events: textEvents }])
    await collect(adapter().stream(request({ reasoningEffort: 'medium' })))
    const body = server.requests[0] as Record<string, unknown>
    const current = (body.conversationState as Record<string, unknown>).currentMessage as Record<string, unknown>
    expect((current.userInputMessage as Record<string, unknown>).content).not.toContain('<thinking_mode>')
    expect(body.additionalModelRequestFields).toMatchObject({ output_config: { effort: 'medium' } })
  })

  it('shows the credit multiplier with the model name', async () => {
    const models = await adapter({
      options: () => connection({
        region: 'us-east-1',
        discoverModels: true,
        models: [
          { id: 'auto', kiroModelId: 'auto', name: 'Auto', reasoning: true, contextWindow: 200_000, maxTokens: 64_000, inputModalities: ['text'], rateMultiplier: 1 },
          { id: 'glm-5', kiroModelId: 'glm-5', name: 'GLM 5', reasoning: true, contextWindow: 200_000, maxTokens: 8_192, inputModalities: ['text'], rateMultiplier: 0.5 },
          { id: 'claude-sonnet-4', kiroModelId: 'claude-sonnet-4', name: 'Claude Sonnet 4', reasoning: true, contextWindow: 200_000, maxTokens: 8_192, inputModalities: ['text'] },
        ],
      }),
    }).listModels('kiro')
    const byId = new Map(models.map(model => [model.id, model]))
    // The composer renders only `name`, so both the provider tag and the cost
    // ride there; `description` keeps the spelled-out cost.
    expect(byId.get('glm-5')?.name).toBe('[Kiro] GLM 5 · 0.5x')
    expect(byId.get('glm-5')?.description).toBe('0.5x credit')
    expect(byId.get('auto')?.name).toBe('[Kiro] Auto · 1x')
    // The authenticated catalog does not list this entry, so it is retired
    // rather than served without a price.
    expect(byId.has('claude-sonnet-4')).toBe(false)
  })

  it('tags an unpriced model with the provider too', async () => {
    const models = await adapter({
      options: () => connection({
        models: [
          { id: 'house-model', kiroModelId: 'house-model', name: 'House Model', reasoning: false, contextWindow: 200_000, maxTokens: 8_192, inputModalities: ['text'] },
        ],
      }),
    }).listModels('kiro')
    // No multiplier to append, but the provider tag still applies.
    expect(models[0]?.name).toBe('[Kiro] House Model')
    expect(models[0]?.description).toBeUndefined()
  })

  it('refreshes the served catalog from discovery and warms it when the list is read', async () => {
    const warmCatalog = vi.fn()
    const inst = adapter({
      options: () => connection({ region: 'no-such-region', discoverModels: true }),
      warmCatalog,
    })
    const models = await inst.listModels('kiro')
    expect(warmCatalog).toHaveBeenCalledOnce()
    expect(warmCatalog).toHaveBeenCalledWith(expect.objectContaining({ region: 'no-such-region' }))
    // Discovery merges the authenticated catalog in, so the served list is the
    // full catalog in picker order: auto first, then cheapest multiplier first.
    expect(models[0]?.id).toBe('auto')
    const multipliers = models
      .map(model => model.rateMultiplier)
      .filter((rate): rate is number => rate !== undefined)
    expect(multipliers).toEqual([...multipliers].sort((left, right) => left - right))
    expect(models.map(model => model.id)).toContain('claude-opus-5-5')
    expect(models.map(model => model.id)).toContain('claude-sonnet-4-6')
    expect(await inst.resolveModel('kiro', 'claude-opus-5-5')).toMatchObject({
      context: { contextWindow: 1000000 },
      defaultMaxTokens: 128000,
    })
    expect(await inst.resolveModel('kiro', 'claude-sonnet-4-6'))
      .toMatchObject({ context: { contextWindow: 1000000 } })
    // Without the flag the configured list stays authoritative and nothing warms.
    const explicit = adapter()
    const explicitModels = await explicit.listModels('kiro')
    expect(explicitModels.map(model => model.id)).toEqual(['claude-sonnet-4-6', 'glm-5'])
    expect(await explicit.resolveModel('kiro', 'claude-sonnet-4-6'))
      .toMatchObject({ context: { contextWindow: 200000 } })
  })

  it('fails loud for an unknown model id on the wire', async () => {
    await expect(collect(adapter().stream(request({ model: 'totally-unknown' }))))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})