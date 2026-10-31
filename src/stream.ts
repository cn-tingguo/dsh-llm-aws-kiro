/**
 * The Kiro runtime request: one POST `generateAssistantResponse` call with
 * the CodeWhisperer request headers, AWS event-stream response decoding,
 * capacity backoff, and first-token timeout. Credential refresh on 403 is
 * owned by the adapter (it re-resolves credentials and re-enters this
 * generator); everything before the first event retries here.
 * @module dsh-llm-kiro/stream
 */

import { APP_IDENTITY, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'
import { getKiroEndpoints } from './endpoints.ts'
import { decodeKiroEventStream } from './eventstream.ts'
import { describeKiroUsage, fetchKiroUsageLimits } from './management.ts'
import type { KiroCredentials, KiroRequest, KiroStreamEvent } from './types.ts'

/** How many times a capacity rejection is retried with backoff before giving up. */
const CAPACITY_MAX_RETRIES = 3
/** Initial capacity-retry delay. */
const CAPACITY_BASE_DELAY_MS = 5_000
/** Ceiling for capacity-retry backoff. */
const CAPACITY_MAX_DELAY_MS = 30_000

/** The body marker for a transient model-capacity rejection. */
const CAPACITY_PATTERN = 'INSUFFICIENT_MODEL_CAPACITY'
/**
 * Body markers for terminal quota exhaustion.
 *
 * Reverse-engineering kiro-cli 2.36 surfaced the monthly, daily, and credit
 * limit codes; all three are terminal for one request and map to QUOTA.
 */
const NON_RETRYABLE_BODY_PATTERNS = [
  'MONTHLY_REQUEST_COUNT',
  'DAILY_REQUEST_COUNT',
  'CREDIT_CONSUMPTION_LIMIT',
]
/**
 * Body markers for requests exceeding the context window. The runtime uses two
 * spellings: the request-validation `CONTENT_LENGTH_EXCEEDS_THRESHOLD` and the
 * stop-reason `MODEL_CONTEXT_WINDOW_EXCEEDED`.
 */
const TOO_BIG_PATTERNS = [
  'CONTENT_LENGTH_EXCEEDS_THRESHOLD',
  'MODEL_CONTEXT_WINDOW_EXCEEDED',
  'Input is too long',
]
/**
 * Body markers for a request the backend rejects as malformed rather than
 * transient. These stay INVALID_REQUEST but are named so a reader can see what
 * the 400 family covers: an unknown model, a stale thinking signature, a bad
 * tool schema, or an unsupported attachment.
 */
const INVALID_REQUEST_PATTERNS = [
  'INVALID_MODEL_ID',
  'THINKING_SIGNATURE_INVALID',
  'TOOL_SCHEMA_INVALID',
  'REQUEST_BODY_INVALID',
  'IMAGE_FORMAT_UNSUPPORTED',
  'IMAGE_DIMENSION_EXCEEDED',
  'DOCUMENT_MODEL_NOT_SUPPORTED',
]

/** One runtime request's transport facts. */
export interface KiroTransportOptions {
  /** The wire request body. */
  request: KiroRequest
  /** The credential facts for this request. */
  credential: KiroCredentials
  /** The resolved profile ARN. */
  profileArn: string
  /** Timeout for the first stream event. */
  firstTokenTimeoutMs: number
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Capacity-retry delay for attempt n (0-based), defaulting to exponential backoff. */
  capacityDelayMs?: (attempt: number) => number
  /** Runtime endpoint override; defaults to the region's kiro.dev endpoint. */
  endpoint?: string
}

/** Whether an error body text reports transient capacity exhaustion. */
export function isCapacityError(errorText: string): boolean {
  return errorText.includes(CAPACITY_PATTERN)
}

/** Whether an error body text reports a terminal quota or too-big condition. */
export function isNonRetryableBodyError(errorText: string): boolean {
  return NON_RETRYABLE_BODY_PATTERNS.some(pattern => errorText.includes(pattern))
}

/**
 * Whether an HTTP failure is a request-too-large rejection. A 413 is always
 * too-large; otherwise any of the context-window body markers identifies it,
 * at whatever status the runtime attaches them to.
 */
export function isTooBigError(status: number, errorText: string): boolean {
  return status === 413 || TOO_BIG_PATTERNS.some(pattern => errorText.includes(pattern))
}

/** Whether an error body names a malformed-request condition. */
export function isInvalidRequestError(errorText: string): boolean {
  return INVALID_REQUEST_PATTERNS.some(pattern => errorText.includes(pattern))
}

/**
 * Read the server's requested retry delay from the response, in milliseconds.
 *
 * The runtime answers a retryable rejection with `x-amz-retry-after`, an
 * integer millisecond count (the AWS SDK convention kiro-cli honors as
 * "explicit request from server to delay before retrying"). Honoring it is
 * friendlier than a fixed exponential guess, but the value is clamped to a
 * ceiling so a hostile or mistaken header cannot stall the turn.
 * @param response - the failed HTTP response.
 * @param maxMs - the largest delay to honor.
 * @returns the clamped delay, or undefined when no usable header is present.
 */
export function retryAfterMs(response: Response, maxMs: number): number | undefined {
  const raw = response.headers.get('x-amz-retry-after') ?? response.headers.get('retry-after')
  if (raw === null) return undefined
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.min(parsed, maxMs)
}

/** A delay that rejects early when the abort signal fires. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

/**
 * The AWS SDK-shaped UA the Kiro runtime requires on BOTH user-agent headers.
 * The backend's authorization layer gates on the client identity in this
 * header: an unknown app token (including the harness's standard attribution
 * UA) is rejected with 403 "User is not authorized to make this call", while
 * the known AmazonQ-For-CLI app identity streams normally. The `md/appVersion`
 * and `lang` segments are free-form; the product version rides along for
 * diagnostics. Verified against runtime.eu-central-1.kiro.dev 2026-08-21.
 */
/**
 * The `user-agent` this runtime accepts.
 *
 * The backend authorizes on the AWS SDK prefix, so it must stay verbatim:
 * measured on 2.36, a `user-agent` without `aws-sdk-rust/... app/AmazonQ-For-CLI`
 * is answered `403 User is not authorized to make this call`, and so is one
 * whose `x-amz-user-agent` keeps the prefix while `user-agent` does not.
 *
 * The harness attribution is appended rather than substituted, which the same
 * measurement accepts (`200`). That satisfies the adapter contract, which
 * requires every provider request to carry {@link attributionHeaders}, without
 * losing the prefix the backend checks.
 *
 * @returns the merged user-agent value.
 */
function kiroUserAgent(): string {
  const mid = crypto.randomUUID().replace(/-/g, '')
  const awsPrefix = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/js api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-${APP_IDENTITY.version}-${mid}`
  // attributionHeaders() carries the harness identity in its own `user-agent`;
  // merging it here keeps one header the backend already accepts.
  const attribution = attributionHeaders()['user-agent']
  return attribution === undefined ? awsPrefix : `${awsPrefix} ${attribution}`
}

/** Map a non-2xx runtime response to the harness failure code. */
function httpErrorCode(status: number, errorText: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (isNonRetryableBodyError(errorText)) return 'QUOTA'
  if (isTooBigError(status, errorText)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (isInvalidRequestError(errorText)) return 'INVALID_REQUEST'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Stream one runtime call as typed Kiro events. Capacity rejections retry
 * with backoff before any event is produced; other HTTP failures throw
 * {@link LlmError}; a missing first event within the first-token timeout
 * throws LlmError('TIMEOUT').
 * @param options - transport facts for the call.
 * @returns the streamed events.
 */
export async function* streamKiroEvents(options: KiroTransportOptions): AsyncGenerator<KiroStreamEvent> {
  const endpoint = options.endpoint ?? new URL('generateAssistantResponse', getKiroEndpoints(options.credential.region).runtime).toString()
  let capacityRetryCount = 0
  let response: Response | undefined

  while (true) {
    const body = JSON.stringify({ ...options.request, profileArn: options.profileArn })
    // One identity per request: the backend reads the same app token from
    // both headers, so they must carry the same value.
    const ua = kiroUserAgent()
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/vnd.amazon.eventstream',
        'authorization': `Bearer ${options.credential.access}`,
        'x-amzn-codewhisperer-optout': 'true',
        'amz-sdk-invocation-id': crypto.randomUUID(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'user-agent': ua,
        'x-amz-user-agent': ua,
      },
      body,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    if (response.ok) break

    let errorText = ''
    try {
      errorText = await response.text()
    } catch {
      // Only error-body reading is swallowed; the status still identifies the failure
    }
    if (isCapacityError(errorText) && capacityRetryCount < CAPACITY_MAX_RETRIES) {
      capacityRetryCount++
      // Prefer the server's own x-amz-retry-after over a blind exponential
      // guess; fall back to the local schedule when it names none.
      const serverDelay = retryAfterMs(response, CAPACITY_MAX_DELAY_MS)
      const delayMs = serverDelay ?? (options.capacityDelayMs !== undefined
        ? options.capacityDelayMs(capacityRetryCount - 1)
        : Math.min(
            CAPACITY_BASE_DELAY_MS * 2 ** (capacityRetryCount - 1),
            CAPACITY_MAX_DELAY_MS,
          ))
      await abortableDelay(delayMs, options.signal)
      continue
    }
    const code = httpErrorCode(response.status, errorText)
    let message = `Kiro API error: ${errorText || response.statusText || response.status}`
    if (code === 'QUOTA') {
      // A quota rejection carries no balance on the wire. Read the limits once,
      // here only, so the user sees how much is left and when it resets. The
      // lookup is best effort and bounded by the management timeout: if it
      // fails, the original quota error stands.
      try {
        const usage = await fetchKiroUsageLimits(
          { accessToken: options.credential.access, region: options.credential.region },
          options.profileArn,
        )
        const summary = describeKiroUsage(usage)
        if (summary !== undefined) message = `${message} (${summary})`
      } catch {
        // Keep the bare quota error when the usage lookup is unavailable.
      }
    }
    throw new LlmError(message, code, { status: response.status })
  }

  if (!response.ok || !response.body) {
    throw new LlmError('Kiro API returned no response body', 'EMPTY_RESPONSE')
  }

  const events = decodeKiroEventStream(response.body)[Symbol.asyncIterator]()
  const FIRST_TOKEN_SENTINEL = Symbol('firstTokenTimeout')
  let gotFirstToken = false
  try {
    while (true) {
      let result: IteratorResult<KiroStreamEvent>
      if (!gotFirstToken) {
        const readPromise = events.next()
        const raced = await Promise.race([
          readPromise,
          new Promise<typeof FIRST_TOKEN_SENTINEL>(resolve =>
            setTimeout(() => resolve(FIRST_TOKEN_SENTINEL), options.firstTokenTimeoutMs),
          ),
        ])
        if (raced === FIRST_TOKEN_SENTINEL) {
          readPromise.catch(() => {})
          throw new LlmError(
            `Kiro API error: first token timeout after ${options.firstTokenTimeoutMs}ms`,
            'TIMEOUT',
          )
        }
        result = raced
        gotFirstToken = true
      } else {
        result = await events.next()
      }
      if (result.done) return
      const event = result.value
      if (event.type === 'error') {
        throw new LlmError(
          `Kiro API stream error: ${event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error}`,
          'SERVER',
        )
      }
      yield event
    }
  } finally {
    // The event source owns the body reader; dropping the iterator closes it.
  }
}