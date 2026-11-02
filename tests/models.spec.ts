/**
 * Model catalog tests: bootstrap resolution, authenticated-catalog mapping,
 * and the shared management cache. The cache path derives from os.homedir(),
 * which this spec stubs to a temp directory.
 */
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { homeVar } = vi.hoisted(() => ({ homeVar: { value: '' } }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => homeVar.value }
})

import {
  bootstrapKiroModels,
  getCachedModels,
  isCacheStale,
  KIRO_MODEL_IDS,
  mapKiroCatalogModels,
  mergeKiroModels,
  orderKiroModels,
  hasAuthenticatedCatalog,
  withoutRetiredModels,
  resolveKiroModelId,
  servedKiroModels,
  toHarnessModelId,
  updateKiroModelsCache,
} from '../src/models.ts'
import type { KiroModel } from '../src/models.ts'
import { getKiroManagementCachePath, readManagementCache } from '../src/management.ts'
import type { KiroCatalogModel } from '../src/types.ts'

let home: string | undefined

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'llm-kiro-models-'))
  homeVar.value = home
})

afterEach(async () => {
  if (home !== undefined) await rm(join(home, '.kiro-management-models-cache.json'), { force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const catalogModel = (modelId: string, extra: Partial<KiroCatalogModel> = {}): KiroCatalogModel => ({
  modelId,
  displayName: `Model ${modelId}`,
  tokenLimits: { maxInputTokens: 123456, maxOutputTokens: 4321 },
  ...extra,
})

describe('llm-kiro models', () => {
  it('ships the bootstrap catalog with dashed harness ids', () => {
    expect(bootstrapKiroModels.length).toBeGreaterThan(10)
    expect(bootstrapKiroModels.find(model => model.id === 'claude-sonnet-4-6')).toMatchObject({
      kiroModelId: 'claude-sonnet-4.6',
      reasoning: true,
      contextWindow: 1000000,
    })
    expect(bootstrapKiroModels.find(model => model.id === 'deepseek-3-2')).toMatchObject({
      kiroModelId: 'deepseek-3.2',
      contextWindow: 164000,
      inputModalities: ['text'],
    })
    expect(bootstrapKiroModels.find(model => model.id === 'claude-haiku-4-5')).toMatchObject({ reasoning: false })
  })

  it('converts dotted wire ids to dashed harness ids', () => {
    expect(toHarnessModelId('claude-sonnet-4.6')).toBe('claude-sonnet-4-6')
    expect(toHarnessModelId('glm-5')).toBe('glm-5')
  })

  it('resolves wire ids from the bootstrap catalog and normalizes unknown dotted input', () => {
    expect(resolveKiroModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4.6')
    expect(resolveKiroModelId('claude-sonnet-4.6')).toBe('claude-sonnet-4.6')
    expect(() => resolveKiroModelId('nope-model')).toThrow('unknown Kiro model id')
  })

  it('takes image support from the catalog, not from the model id', () => {
    // `auto` and the GPT family are image-capable but do not match the Claude
    // prefix the pre-discovery guess relies on; only the catalog knows.
    const mapped = mapKiroCatalogModels([
      catalogModel('auto', { supportedInputTypes: ['TEXT', 'IMAGE'] }),
      catalogModel('gpt-5.6-luna', { supportedInputTypes: ['TEXT', 'IMAGE'] }),
      catalogModel('text-only-model', { supportedInputTypes: ['TEXT'] }),
      // A Claude entry the catalog reports as text-only loses the guess too.
      catalogModel('claude-sonnet-4.6', { supportedInputTypes: ['TEXT'] }),
    ], 'us-east-1')
    const modalities = (id: string): readonly string[] | undefined =>
      mapped.find(model => model.id === id)?.inputModalities
    expect(modalities('auto')).toEqual(['text', 'image'])
    expect(modalities('gpt-5-6-luna')).toEqual(['text', 'image'])
    expect(modalities('text-only-model')).toEqual(['text'])
    expect(modalities('claude-sonnet-4-6')).toEqual(['text'])
  })

  it('falls back to the id guess when the catalog declares no input types', () => {
    const mapped = mapKiroCatalogModels([
      catalogModel('claude-opus-5'),
      catalogModel('brand-new-model'),
    ], 'us-east-1')
    expect(mapped.find(model => model.id === 'claude-opus-5')?.inputModalities).toEqual(['text', 'image'])
    expect(mapped.find(model => model.id === 'brand-new-model')?.inputModalities).toEqual(['text'])
  })

  it('humanizes an unnamed id without splitting its version number', () => {
    // The catalog leaves displayName null for these, and the harness id encodes
    // the version's point as a dash, so a naive split renders "Haiku 5 5".
    const mapped = mapKiroCatalogModels([
      catalogModel('claude-haiku-5.5', { displayName: null }),
      catalogModel('qwen3-coder-next', { displayName: null }),
    ], 'us-east-1')
    expect(mapped.find(model => model.id === 'claude-haiku-5-5')?.name).toBe('Claude Haiku 5.5')
    expect(mapped.find(model => model.id === 'qwen3-coder-next')?.name).toBe('Qwen3 Coder Next')
  })

  it('maps an authenticated catalog, merging bootstrap metadata', () => {
    const mapped = mapKiroCatalogModels([
      catalogModel('claude-sonnet-4.6', { additionalModelRequestFieldsSchema: null }),
      catalogModel('brand-new-model'),
    ], 'us-east-1')
    expect(mapped.find(model => model.id === 'claude-sonnet-4-6')).toMatchObject({
      name: 'Model claude-sonnet-4.6',
      contextWindow: 123456,
      maxTokens: 4321,
      inputModalities: ['text', 'image'],
      reasoning: true,
    })
    expect(mapped.find(model => model.id === 'brand-new-model')).toMatchObject({
      name: 'Model brand-new-model',
      contextWindow: 123456,
      maxTokens: 4321,
      inputModalities: ['text'],
      reasoning: false,
    })
  })

  it('maps an authenticated catalog with an effort schema disclosing reasoning', () => {
    const mapped = mapKiroCatalogModels([
      {
        modelId: 'openai-gpt-x',
        displayName: 'GPT X',
        additionalModelRequestFieldsSchema: {
          properties: { reasoning: { properties: { effort: { enum: ['low', 'high'] } } } },
        },
      },
    ], 'us-east-1')
    expect(mapped[0]).toMatchObject({ reasoning: true })
  })

  it('rejects invalid catalogs', () => {
    expect(() => mapKiroCatalogModels([], 'us-east-1')).toThrow('no models')
    expect(() => mapKiroCatalogModels([{ modelId: ' spaced ' }], 'us-east-1')).toThrow('invalid model ID')
    expect(() => mapKiroCatalogModels([{ modelId: 'a' }, { modelId: 'a' }], 'us-east-1')).toThrow('conflicting model ID')
    expect(() => mapKiroCatalogModels([{ modelId: 'a', additionalModelRequestFieldsSchema: 'bad' }], 'us-east-1')).toThrow('invalid request-fields schema')
    expect(() => mapKiroCatalogModels([{ modelId: 'a', tokenLimits: 'bad' }], 'us-east-1')).toThrow('invalid token limits')
    expect(() => mapKiroCatalogModels([{ modelId: 'a', tokenLimits: { maxInputTokens: -1 } }], 'us-east-1')).toThrow('invalid token limits')
  })

  it('keeps a fetched catalog for eight hours before refetching', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('List-Available-Profiles')) {
        return new Response(JSON.stringify({ profiles: [{ arn: 'arn:1' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ models: [catalogModel('claude-sonnet-4.6')] }), { status: 200 })
    }))
    await updateKiroModelsCache('token', 'eu-west-1')

    const ageBy = (hours: number): void => {
      const cache = readManagementCache()!
      cache.regions['eu-west-1'] = {
        ...cache.regions['eu-west-1']!,
        fetchedAt: Date.now() - hours * 60 * 60 * 1000,
      }
      writeFileSync(getKiroManagementCachePath(), JSON.stringify(cache))
    }

    // The old one-hour window refetched long before the menu could change.
    ageBy(1)
    expect(isCacheStale('eu-west-1')).toBe(false)
    ageBy(7.9)
    expect(isCacheStale('eu-west-1')).toBe(false)
    ageBy(8.1)
    expect(isCacheStale('eu-west-1')).toBe(true)
  })

  it('caches the authenticated catalog per region and serves it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('List-Available-Profiles')) {
        return new Response(JSON.stringify({ profiles: [{ arn: 'arn:1' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({
        models: [catalogModel('claude-sonnet-4.6'), catalogModel('brand-new-model')],
      }), { status: 200 })
    }))
    await updateKiroModelsCache('token', 'us-east-1')
    const cached = getCachedModels('us-east-1')
    expect(cached.find(model => model.id === 'brand-new-model')).toBeDefined()
    expect(isCacheStale('us-east-1')).toBe(false)
    expect(isCacheStale('eu-central-1')).toBe(true)
    const cache = readManagementCache()
    expect(cache?.regions['us-east-1']).toBeDefined()
    // The discovered id joins the known-id set
    expect(KIRO_MODEL_IDS.has('brand-new-model')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('reuses the parsed cache until another writer replaces the file', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('List-Available-Profiles')) {
        return new Response(JSON.stringify({ profiles: [{ arn: 'arn:1' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ models: [catalogModel('claude-sonnet-4.6')] }), { status: 200 })
    }))
    await updateKiroModelsCache('token', 'us-east-1')
    const first = readManagementCache()
    expect(readManagementCache()).toBe(first)
    expect(getCachedModels('us-east-1').map(model => model.id)).toEqual(['claude-sonnet-4-6'])

    // A second tool rewrites the shared file with a different catalog.
    writeFileSync(getKiroManagementCachePath(), JSON.stringify({
      ...first,
      regions: { 'us-east-1': { region: 'us-east-1', fetchedAt: Date.now(), models: [catalogModel('glm-5'), catalogModel('brand-new-model')] } },
    }))
    expect(readManagementCache()).not.toBe(first)
    expect(getCachedModels('us-east-1').map(model => model.id)).toEqual(['glm-5', 'brand-new-model'])
    // Callers get their own array, so mutating it cannot corrupt the memo.
    getCachedModels('us-east-1').pop()
    expect(getCachedModels('us-east-1')).toHaveLength(2)
  })

  it('distinguishes an absent catalog from the bootstrap fallback', () => {
    // getCachedModels falls back to bootstrap, so presence is judged separately.
    expect(hasAuthenticatedCatalog('no-such-region')).toBe(false)
  })

  it('serves the bootstrap catalog before discovery and tolerates cache corruption', async () => {
    expect(getCachedModels('ap-southeast-1')).toEqual(bootstrapKiroModels)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(home!, '.kiro-management-models-cache.json'), 'not json')
    expect(getCachedModels('ap-southeast-1')).toEqual(bootstrapKiroModels)
  })

  it('ships the newest authenticated models in the bootstrap catalog', () => {
    expect(bootstrapKiroModels.find(model => model.id === 'claude-opus-5-5')).toMatchObject({
      kiroModelId: 'claude-opus-5.5',
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoning: true,
      inputModalities: ['text', 'image'],
    })
    expect(bootstrapKiroModels.find(model => model.id === 'claude-opus-5')).toMatchObject({
      kiroModelId: 'claude-opus-5',
      maxTokens: 128000,
    })
    expect(bootstrapKiroModels.find(model => model.id === 'claude-opus-4-5')).toMatchObject({
      kiroModelId: 'claude-opus-4.5',
      contextWindow: 200000,
    })
    expect(bootstrapKiroModels.find(model => model.id === 'gpt-5-6-sol')).toMatchObject({
      kiroModelId: 'gpt-5.6-sol',
      contextWindow: 1000000,
      maxTokens: 128000,
      inputModalities: ['text'],
    })
    expect(resolveKiroModelId('claude-opus-5-5')).toBe('claude-opus-5.5')
  })

  it('merges discovered metadata over the matched id and appends new ids', () => {
    const discovered: KiroModel[] = [
      { id: 'claude-opus-5-5', kiroModelId: 'claude-opus-5.5', name: 'Claude Opus 5.5 (live)', reasoning: true, contextWindow: 123, maxTokens: 45, inputModalities: ['text', 'image'] },
      { id: 'brand-new-model', kiroModelId: 'brand-new-model', name: 'Brand New', reasoning: false, contextWindow: 777, maxTokens: 77, inputModalities: ['text'] },
    ]
    const merged = mergeKiroModels(bootstrapKiroModels, discovered)
    expect(merged).toHaveLength(bootstrapKiroModels.length + 1)
    expect(merged.find(model => model.id === 'claude-opus-5-5')).toMatchObject({
      name: 'Claude Opus 5.5 (live)',
      contextWindow: 123,
      maxTokens: 45,
    })
    expect(merged[merged.length - 1]?.id).toBe('brand-new-model')
  })

  it('serves an explicit list verbatim and extends it only when discovery is on', () => {
    const explicit: KiroModel[] = [
      { id: 'only-me', kiroModelId: 'only-me', name: 'Only Me', reasoning: false, contextWindow: 1, maxTokens: 1, inputModalities: ['text'] },
    ]
    // An explicit list with discovery off is served exactly as authored.
    expect(servedKiroModels({ models: explicit })).toEqual(explicit)
    // With discovery on, the merged catalog is served in picker order.
    const merged = servedKiroModels({ models: explicit, discoverModels: true, region: 'ap-southeast-1' })
    expect(merged.map(model => model.id)).toEqual(
      orderKiroModels(mergeKiroModels(explicit, bootstrapKiroModels)).map(model => model.id),
    )
  })

  it('reads a shared pi-provider-kiro version-1 cache document', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(home!, '.kiro-management-models-cache.json'), JSON.stringify({
      version: 1,
      source: 'kiro-management',
      regions: {
        'ap-southeast-2': {
          region: 'ap-southeast-2',
          fetchedAt: Date.now(),
          models: [
            {
              id: 'claude-opus-5-5',
              kiroModelId: 'claude-opus-5.5',
              name: 'Claude Opus 5.5',
              contextWindow: 1000000,
              maxTokens: 128000,
              additionalModelRequestFieldsSchema: {
                properties: { output_config: { properties: { effort: { enum: ['low', 'high'] } } } },
              },
            },
            { id: 'brand-new-model', kiroModelId: 'brand-new-model', name: 'Brand New', contextWindow: 777, maxTokens: 77 },
          ],
        },
      },
    }))
    const cached = getCachedModels('ap-southeast-2')
    expect(cached.find(model => model.id === 'claude-opus-5-5')).toMatchObject({
      name: 'Claude Opus 5.5',
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoning: true,
    })
    expect(cached.find(model => model.id === 'brand-new-model')).toMatchObject({
      contextWindow: 777,
      maxTokens: 77,
      reasoning: false,
    })
    expect(isCacheStale('ap-southeast-2')).toBe(false)
    expect(resolveKiroModelId('brand-new-model')).toBe('brand-new-model')
    expect(KIRO_MODEL_IDS.has('brand-new-model')).toBe(true)
  })

  it('retires a bootstrap entry the authenticated catalog no longer offers', () => {
    const entry = (id: string, rateMultiplier?: number): KiroModel => ({
      id,
      kiroModelId: id,
      name: id,
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 8_192,
      inputModalities: ['text'],
      ...(rateMultiplier !== undefined ? { rateMultiplier } : {}),
    })
    const base = [entry('kept', 1), entry('retired')]
    const discovered = [entry('kept', 1.3), entry('added', 0.5)]
    // An entry the account still serves survives; one it dropped does not.
    expect(withoutRetiredModels(base, discovered).map(model => model.id)).toEqual(['kept'])
    // Without an authenticated catalog nothing is judged retired.
    expect(withoutRetiredModels(base, []).map(model => model.id)).toEqual(['kept', 'retired'])
  })

  it('orders the picker auto first, then by credit multiplier descending', () => {
    const priced = (id: string, rateMultiplier?: number): KiroModel => ({
      id,
      kiroModelId: id,
      name: id,
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 8_192,
      inputModalities: ['text'],
      ...(rateMultiplier !== undefined ? { rateMultiplier } : {}),
    })
    const ordered = orderKiroModels([
      priced('claude-opus-5', 2.2),
      priced('glm-5', 0.5),
      priced('auto', 1),
      priced('unpriced-model'),
      priced('qwen3-coder-next', 0.05),
      priced('claude-sonnet-5', 1.3),
    ])
    // auto is pinned first; priced models descend; the unpriced one sorts last.
    expect(ordered.map(model => model.id)).toEqual([
      'auto',
      'claude-opus-5',
      'claude-sonnet-5',
      'glm-5',
      'qwen3-coder-next',
      'unpriced-model',
    ])
  })

  it('keeps catalog order for models that tie on multiplier', () => {
    const base = (id: string): KiroModel => ({
      id,
      kiroModelId: id,
      name: id,
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 8_192,
      inputModalities: ['text'],
      rateMultiplier: 1.3,
    })
    expect(orderKiroModels([base('first'), base('second'), base('third')]).map(m => m.id))
      .toEqual(['first', 'second', 'third'])
  })

  it('applies the picker order to a merged catalog', () => {
    const model = (id: string, rateMultiplier?: number): KiroModel => ({
      id,
      kiroModelId: id,
      name: id,
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 64_000,
      inputModalities: ['text'],
      ...(rateMultiplier !== undefined ? { rateMultiplier } : {}),
    })
    // mergeKiroModels is what discovery feeds the picker; order after merging.
    const merged = mergeKiroModels(
      [model('claude-opus-5', 2.2), model('auto', 1)],
      [model('glm-5', 0.5), model('claude-opus-5', 2.2)],
    )
    expect(orderKiroModels(merged).map(entry => entry.id)).toEqual(['auto', 'claude-opus-5', 'glm-5'])
  })

})