import { describe, expect, it } from 'vitest'
import { isInvalidRequestError, isTooBigError, retryAfterMs, streamErrorCode, streamErrorText } from '../src/stream.ts'

const responseWith = (headers: Record<string, string>): Response =>
  new Response(null, { status: 429, headers })

describe('llm-kiro stream retry-after', () => {
  it('reads x-amz-retry-after as a millisecond delay', () => {
    expect(retryAfterMs(responseWith({ 'x-amz-retry-after': '4200' }), 30_000)).toBe(4200)
  })

  it('falls back to the standard retry-after header', () => {
    expect(retryAfterMs(responseWith({ 'retry-after': '1500' }), 30_000)).toBe(1500)
  })

  it('clamps the server delay to the ceiling', () => {
    expect(retryAfterMs(responseWith({ 'x-amz-retry-after': '999999' }), 30_000)).toBe(30_000)
  })

  it('ignores a missing or malformed header', () => {
    expect(retryAfterMs(responseWith({}), 30_000)).toBeUndefined()
    expect(retryAfterMs(responseWith({ 'x-amz-retry-after': 'soon' }), 30_000)).toBeUndefined()
    expect(retryAfterMs(responseWith({ 'x-amz-retry-after': '-5' }), 30_000)).toBeUndefined()
  })
})

describe('llm-kiro error classification', () => {
  it('recognizes both context-window spellings at any status', () => {
    expect(isTooBigError(413, '')).toBe(true)
    expect(isTooBigError(400, 'CONTENT_LENGTH_EXCEEDS_THRESHOLD')).toBe(true)
    expect(isTooBigError(400, 'MODEL_CONTEXT_WINDOW_EXCEEDED')).toBe(true)
    // The stop-reason spelling is recognized even when the status is not 400.
    expect(isTooBigError(422, 'MODEL_CONTEXT_WINDOW_EXCEEDED')).toBe(true)
    expect(isTooBigError(400, 'something else')).toBe(false)
  })

  it('classifies in-stream error events by their text', () => {
    expect(streamErrorCode(streamErrorText({ error: 'MODEL_CONTEXT_WINDOW_EXCEEDED' }))).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(streamErrorCode(streamErrorText({ error: 'ValidationException', message: 'Input is too long' }))).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(streamErrorCode('MONTHLY_REQUEST_COUNT reached')).toBe('QUOTA')
    expect(streamErrorCode('THINKING_SIGNATURE_INVALID')).toBe('INVALID_REQUEST')
    expect(streamErrorCode('boom: detail')).toBe('SERVER')
    expect(streamErrorText({ error: 'boom', message: 'detail' })).toBe('boom: detail')
  })

  it('recognizes malformed-request codes', () => {
    expect(isInvalidRequestError('INVALID_MODEL_ID')).toBe(true)
    expect(isInvalidRequestError('THINKING_SIGNATURE_INVALID')).toBe(true)
    expect(isInvalidRequestError('IMAGE_FORMAT_UNSUPPORTED')).toBe(true)
    expect(isInvalidRequestError('transient server hiccup')).toBe(false)
  })
})
