/**
 * Thin HTTP transport for the Ecamm Live Remote API.
 *
 * Every call is a GET. "get*" endpoints return JSON, "set*" endpoints return ["Done"].
 * Ecamm requires identifying headers on every request, and the UUID must stay the same
 * across restarts or the user is asked to approve the client again.
 */

export type QueryValue = string | number | boolean | undefined
export type QueryParams = Record<string, QueryValue>

export class EcammError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'timeout' | 'http' | 'parse' | 'permission' | 'not_found' | 'ambiguous' | 'blocked' | 'busy',
  ) {
    super(message)
  }
}

export interface HttpOptions {
  uuid: string
  clientName: string
  clientVersion: string
  deviceName: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

/**
 * Ecamm is a Cocoa app and does not decode "+" back into a space, so URLSearchParams
 * would corrupt marker text, comments and file paths. encodeURIComponent gives %20.
 */
export function buildQuery(params?: QueryParams): string {
  if (!params) return ''
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return pairs.length ? `?${pairs.join('&')}` : ''
}

const ACKS = new Set(['done', 'clicked it!'])

/**
 * Ecamm's own PDF shows set commands answering ["Done"] or ["Clicked it!"]. The Companion
 * module, which is tested against a real Ecamm, reports the bare word Done with no JSON
 * around it. Until a real device settles which, accept the same two words in any of the
 * shapes they could arrive in: bare, a JSON string, or a one-element JSON array.
 */
export function isAcknowledgement(body: string, endpoint?: string): boolean {
  let value: unknown = body
  try { value = JSON.parse(body) } catch { /* bare text */ }
  if (Array.isArray(value) && value.length === 1) value = value[0]
  if (typeof value !== 'string') return false
  const word = value.trim()
  return ACKS.has(word.toLowerCase()) || (endpoint !== undefined && ENDPOINT_ACKS[endpoint]?.(word) === true)
}

/**
 * Replies seen on a real Ecamm that are not one of the two documented words. Add an entry
 * only for a reply actually observed for that endpoint; anything else stays "unknown".
 *
 * setVolume: answers with the resulting level, e.g. ["100"] (Ecamm 4.6.2, 2026-11-10).
 */
const ENDPOINT_ACKS: Record<string, (reply: string) => boolean> = {
  setVolume: (reply) => /^\d{1,3}(\.\d+)?$/.test(reply),
}

export class EcammHttp {
  host = '' // "address:port"
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: HttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  headers(): Record<string, string> {
    return {
      'User-Agent': `${this.opts.clientName}/${this.opts.clientVersion}`,
      'EcammLive-UUID': this.opts.uuid,
      'EcammLive-ClientName': this.opts.clientName,
      'EcammLive-DeviceName': this.opts.deviceName,
    }
  }

  async raw(endpoint: string, params?: QueryParams): Promise<string> {
    if (!this.host) throw new EcammError('No Ecamm Live host resolved yet', 'unreachable')
    const url = `http://${this.host}/${endpoint}${buildQuery(params)}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      })
    } catch (err) {
      const name = (err as { name?: string })?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new EcammError(`${endpoint} timed out after ${this.opts.timeoutMs} ms`, 'timeout')
      }
      throw new EcammError(`Could not reach Ecamm Live at ${this.host} (${String(err)})`, 'unreachable')
    }
    const body = await res.text()
    if (!res.ok) {
      throw new EcammError(`${endpoint} returned HTTP ${res.status}: ${body.slice(0, 200).trim()}`, 'http')
    }
    return body
  }

  async get<T = unknown>(endpoint: string, params?: QueryParams): Promise<T> {
    const body = await this.raw(endpoint, params)
    try {
      return JSON.parse(body) as T
    } catch {
      throw new EcammError(`${endpoint} returned non-JSON: ${body.slice(0, 200)}`, 'parse')
    }
  }

  /** HTTP 200 can still mean permission was revoked after our readiness check. */
  async set(endpoint: string, params?: QueryParams): Promise<void> {
    const body = await this.raw(endpoint, params)
    if (/access denied/i.test(body)) {
      throw new EcammError(`${endpoint}: Ecamm denied the command. Check Remote Control permissions.`, 'permission')
    }
    if (!isAcknowledgement(body, endpoint)) {
      throw new EcammError(
        `${endpoint}: unrecognized command response (${JSON.stringify(body.slice(0, 80))}); the outcome is unknown. Check Ecamm before retrying.`,
        'parse',
      )
    }
  }
}
