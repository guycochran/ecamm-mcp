/**
 * Thin HTTP transport for the Ecamm Live Remote API (v4.4).
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
    readonly kind: 'unreachable' | 'timeout' | 'http' | 'parse' | 'permission' | 'not_found' | 'ambiguous' | 'blocked',
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

  /** Commands answer "Done", which is deliberately not parsed. */
  async set(endpoint: string, params?: QueryParams): Promise<void> {
    await this.raw(endpoint, params)
  }
}
