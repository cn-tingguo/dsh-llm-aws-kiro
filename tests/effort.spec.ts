/**
 * Reasoning-effort tests: the pre-discovery fallback ladders, the schema-first
 * derivation, and the mapping of harness effort onto a model's wire enum.
 */
import { describe, expect, it } from 'vitest'
import {
  buildKiroAdditionalModelRequestFields,
  deriveKiroEffort,
  fallbackKiroEffort,
  getKiroEffortConfig,
  kiroEffortLabel,
  mapDshEffortToKiro,
  nearestKiroEffort,
  selectableKiroEfforts,
} from '../src/effort.ts'

describe('llm-kiro effort', () => {
  it('knows the shipped model ladders before discovery', () => {
    expect(fallbackKiroEffort('claude-opus-5.5')).toEqual({
      field: 'output_config',
      values: ['low', 'medium', 'high', 'xhigh', 'max'],
      summarizedThinking: true,
    })
    expect(fallbackKiroEffort('claude-opus-5')).toMatchObject({ field: 'output_config', summarizedThinking: true })
    expect(fallbackKiroEffort('gpt-5.6-sol')).toMatchObject({ field: 'reasoning', summarizedThinking: false })
    expect(fallbackKiroEffort('gpt-5.6-terra')).toMatchObject({ field: 'reasoning' })
    expect(fallbackKiroEffort('claude-opus-4.6')).toMatchObject({
      field: 'output_config',
      values: ['low', 'medium', 'high', 'max'],
      summarizedThinking: false,
    })
    expect(fallbackKiroEffort('claude-haiku-4.5')).toBeUndefined()
  })

  it('prefers the authenticated schema and falls back only in its absence', () => {
    const schema = {
      properties: {
        output_config: { properties: { effort: { enum: ['low', 'high'] } } },
        thinking: { properties: { display: { enum: ['summarized'] } } },
      },
    }
    expect(deriveKiroEffort(schema)).toEqual({
      field: 'output_config',
      values: ['low', 'high'],
      summarizedThinking: true,
    })
    expect(getKiroEffortConfig(schema, 'claude-haiku-4.5')).toMatchObject({ values: ['low', 'high'] })
    expect(getKiroEffortConfig(undefined, 'claude-opus-5.5')).toMatchObject({ field: 'output_config' })
    expect(deriveKiroEffort('not-a-schema')).toBeUndefined()
    expect(deriveKiroEffort({ properties: { reasoning: { properties: { effort: { enum: [] } } } } })).toBeUndefined()
  })

  it('falls back to the shipped ladder when a published schema omits effort', () => {
    // A management catalog entry can carry additionalModelRequestFields with
    // only thinking/max_tokens and no effort enum. Returning undefined here
    // would drop additionalModelRequestFields from the request, which the
    // runtime rejects for Claude models, so the shipped ladder must apply.
    const silent = { properties: { thinking: { type: 'object' }, max_tokens: { type: 'number' } } }
    expect(deriveKiroEffort(silent)).toBeUndefined()
    expect(getKiroEffortConfig(silent, 'claude-opus-5.5')).toEqual({
      field: 'output_config',
      values: ['low', 'medium', 'high', 'xhigh', 'max'],
      summarizedThinking: true,
    })
    expect(getKiroEffortConfig({}, 'gpt-5.6-sol')).toMatchObject({ field: 'reasoning' })
    // A model with no shipped ladder still yields nothing, unchanged.
    expect(getKiroEffortConfig(silent, 'auto')).toBeUndefined()
    // A schema that does disclose a ladder keeps winning over the fallback.
    expect(getKiroEffortConfig(
      { properties: { output_config: { properties: { effort: { enum: ['low', 'high'] } } } } },
      'claude-opus-5.5',
    )).toMatchObject({ values: ['low', 'high'] })
  })

  it('maps harness effort onto the nearest wire rung and builds the request field', () => {
    const extended = fallbackKiroEffort('claude-opus-5.5')!
    expect(mapDshEffortToKiro('high', extended)).toBe('high')
    expect(mapDshEffortToKiro('max', extended)).toBe('max')
    expect(buildKiroAdditionalModelRequestFields(extended, 'high')).toEqual({
      output_config: { effort: 'high' },
      thinking: { type: 'adaptive', display: 'summarized' },
    })
    const capped = fallbackKiroEffort('claude-opus-4.6')!
    expect(mapDshEffortToKiro('max', capped)).toBe('max')
    expect(buildKiroAdditionalModelRequestFields(fallbackKiroEffort('gpt-5.6-sol'), 'low')).toEqual({
      reasoning: { effort: 'low' },
    })
    expect(buildKiroAdditionalModelRequestFields(undefined, 'high')).toBeUndefined()
    expect(buildKiroAdditionalModelRequestFields(extended, undefined)).toBeUndefined()
  })

  it('offers each model its own Kiro rungs, dropping the reasoning-disabling ones', () => {
    expect(selectableKiroEfforts(fallbackKiroEffort('claude-opus-5.5'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(selectableKiroEfforts(fallbackKiroEffort('claude-sonnet-4.6'))).toEqual(['low', 'medium', 'high', 'max'])
    expect(selectableKiroEfforts(fallbackKiroEffort('gpt-5.6-sol'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(selectableKiroEfforts(deriveKiroEffort({
      properties: { reasoning: { properties: { effort: { enum: ['max', 'none', 'low'] } } } },
    }))).toEqual(['low', 'max'])
    expect(selectableKiroEfforts(undefined)).toEqual(['low', 'high', 'max'])
    expect(kiroEffortLabel('xhigh')).toBe('Extra High')
    expect(kiroEffortLabel('medium')).toBe('Medium')
  })

  it('rounds absent rungs up, then down', () => {
    expect(nearestKiroEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('max')
    expect(nearestKiroEffort('medium', ['low', 'high', 'max'])).toBe('high')
    expect(nearestKiroEffort('max', ['low', 'medium'])).toBe('medium')
    expect(nearestKiroEffort('high', [])).toBeUndefined()
    expect(mapDshEffortToKiro('xhigh', fallbackKiroEffort('claude-opus-4.6')!)).toBe('max')
    expect(buildKiroAdditionalModelRequestFields(fallbackKiroEffort('gpt-5.6-sol'), 'xhigh')).toEqual({
      reasoning: { effort: 'xhigh' },
    })
  })
})
