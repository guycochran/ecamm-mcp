import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { chooseInstance, discoverEcamm, type DiscoverFn, type DiscoveredEcamm } from './discovery.js'
import { EcammError, EcammHttp, type QueryParams } from './http.js'

export const AUDIO_BUSES = [
  'mic', 'mic2', 'skype', 'system audio', 'interview', 'zoom', 'soundeffects', 'movie',
  'guest_1', 'guest_2', 'guest_3', 'guest_4',
] as const
export type AudioBus = (typeof AUDIO_BUSES)[number]

export interface Item {
  id: string
  title: string
  group?: string
  [k: string]: unknown
}

// ---------- parsing helpers (shapes verified against Companion module fixtures) ----------

/** Scalars come back wrapped: ["Allowed"], ["no"], ["8A1D..."]. */
export function scalar(payload: unknown): string {
  if (Array.isArray(payload)) return payload.length ? scalar(payload[0]) : ''
  if (typeof payload === 'string') return payload
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload)
  return ''
}

export const yes = (v: unknown) => scalar(v).trim().toLowerCase() === 'yes'

function itemsOf(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[]
  if (payload && typeof payload === 'object') {
    const env = payload as Record<string, unknown>
    if (Array.isArray(env.items)) return env.items as Record<string, unknown>[]
    // getChannels is documented as a dictionary
    return Object.values(env).filter((v) => v && typeof v === 'object') as Record<string, unknown>[]
  }
  return []
}

/**
 * Flattens Ecamm's nested lists (scene groups, sound folders). Placeholder rows with an
 * empty UUID ("-No recent items-") are dropped. `extra` copies chosen fields through.
 */
export function flatten(payload: unknown, extra: (raw: Record<string, unknown>) => Record<string, unknown> = () => ({})): Item[] {
  const out: Item[] = []
  const walk = (rows: Record<string, unknown>[], group?: string) => {
    for (const raw of rows) {
      const id = String(raw.UUID ?? '').trim()
      if (!id) continue
      const title = String(raw.title ?? raw.name ?? id).trim()
      if (raw.Group === true) {
        walk(Array.isArray(raw.Children) ? (raw.Children as Record<string, unknown>[]) : [], title)
        continue
      }
      out.push({ id, title, ...(group ? { group } : {}), ...extra(raw) })
    }
  }
  walk(itemsOf(payload))
  return out
}

/**
 * Resolves a user reference ("Me + Guest", a UUID, "guest") to exactly one item:
 * exact id, then exact title (case-insensitive), then "Group / Title", then unique substring.
 */
export function resolveItem(items: Item[], ref: string, kind: string): Item {
  const q = ref.trim().toLowerCase()
  const byId = items.find((i) => i.id.toLowerCase() === q)
  if (byId) return byId
  const exact = items.filter((i) => i.title.toLowerCase() === q)
  if (exact.length === 1) return exact[0]
  const grouped = items.filter((i) => i.group && `${i.group} / ${i.title}`.toLowerCase() === q)
  if (grouped.length === 1) return grouped[0]
  const partial = items.filter((i) => i.title.toLowerCase().includes(q))
  if (partial.length === 1) return partial[0]
  const pool = exact.length > 1 ? exact : partial
  if (pool.length > 1) {
    throw new EcammError(
      `"${ref}" matches ${pool.length} ${kind}s: ${pool.map((i) => `${i.group ? i.group + ' / ' : ''}${i.title} (${i.id})`).join('; ')}. Use the id.`,
      'ambiguous',
    )
  }
  throw new EcammError(`No ${kind} matches "${ref}". Available: ${items.map((i) => i.title).join(', ') || '(none)'}`, 'not_found')
}

/** getInfo flattened into something readable, with VOLUME_* and MUTE_* grouped. */
export function summarizeInfo(info: Record<string, unknown>) {
  const audio: Record<string, { volume?: string; muted?: boolean }> = {}
  const zoom: Record<string, unknown> = {}
  const general: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(info)) {
    const m = /^(VOLUME|MUTE)_(.+)$/.exec(k)
    if (m) {
      const bus = m[2].toLowerCase()
      audio[bus] ??= {}
      if (m[1] === 'VOLUME') audio[bus].volume = String(v)
      else audio[bus].muted = yes(v)
    } else if (k.startsWith('Zoom')) zoom[k] = v
    else general[k] = v
  }
  return { general, mainMuted: yes(info.Mute), audio, zoom: Object.keys(zoom).length ? zoom : undefined }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- client ----------

export interface ClientOptions {
  /** "address:port" to skip Bonjour (port changes each Ecamm launch, so mostly for testing) */
  host?: string
  hostname?: string
  discover?: DiscoverFn
  fetchImpl?: typeof fetch
  stateDir?: string
  clientName?: string
}

export type Permission = 'Allowed' | 'Denied' | 'Pending' | 'Not Found'

export class EcammClient {
  readonly http: EcammHttp
  private readonly discover: DiscoverFn
  private instance?: DiscoveredEcamm
  private infoCache?: { at: number; data: Record<string, unknown> }
  private approved = false
  readonly clientName: string

  constructor(private readonly opts: ClientOptions = {}) {
    this.discover = opts.discover ?? discoverEcamm
    this.clientName = opts.clientName ?? 'Claude (ecamm-mcp)'
    this.http = new EcammHttp({
      uuid: loadUuid(opts.stateDir ?? join(homedir(), '.ecamm-mcp')),
      clientName: this.clientName,
      clientVersion: '0.1.0',
      deviceName: hostname(),
      timeoutMs: 4000,
      fetchImpl: opts.fetchImpl,
    })
    if (opts.host) this.http.host = opts.host
  }

  get target() {
    return { host: this.http.host, instance: this.instance }
  }

  async locate(): Promise<DiscoveredEcamm[]> {
    const found = await this.discover(3000)
    const { pick, reason } = chooseInstance(found, { hostname: this.opts.hostname, localHostname: hostname() })
    if (!pick) throw new EcammError(reason, 'unreachable')
    // Prefer loopback when Ecamm is on this Mac; otherwise first IPv4 it advertised.
    const local = pick.hostname.toLowerCase().replace(/\.local$/, '') === hostname().toLowerCase().replace(/\.local$/, '')
    this.instance = pick
    this.http.host = `${local ? '127.0.0.1' : pick.addresses[0]}:${pick.port}`
    return found
  }

  async permission(): Promise<Permission> {
    const v = scalar(await this.http.get('getConnectionStatus')).trim()
    return (['Allowed', 'Denied', 'Pending'].includes(v) ? v : 'Not Found') as Permission
  }

  /** Makes sure we have a host and Ecamm has approved this client. Rediscovers once on failure. */
  async ensureReady(): Promise<void> {
    if (!this.http.host) await this.locate()
    let perm: Permission
    try {
      perm = await this.permission()
    } catch (err) {
      if (this.opts.host || !(err instanceof EcammError) || !['unreachable', 'timeout'].includes(err.kind)) throw err
      // Ecamm relaunched on a new port, or moved: find it again.
      await this.locate()
      perm = await this.permission()
    }
    if (perm === 'Not Found') {
      // Any request registers the client and pops it into Ecamm's Remote Control list.
      try { await this.http.get('getInfo') } catch { /* side effect is the point */ }
      perm = await this.permission()
    }
    this.approved = perm === 'Allowed'
    if (!this.approved) {
      throw new EcammError(
        perm === 'Denied'
          ? `Ecamm Live denied "${this.clientName}". Re-enable it in Ecamm Live > Settings > Remote Control.`
          : `Waiting for approval: in Ecamm Live open Settings > Remote Control and tick "${this.clientName}", then retry.`,
        'permission',
      )
    }
  }

  async get<T = unknown>(endpoint: string, params?: QueryParams): Promise<T> {
    await this.ensureReady()
    return this.http.get<T>(endpoint, params)
  }

  async set(endpoint: string, params?: QueryParams): Promise<void> {
    await this.ensureReady()
    this.infoCache = undefined
    await this.http.set(endpoint, params)
  }

  /** Ecamm asks clients not to call getInfo more than every 2 s. */
  async info(fresh = false): Promise<Record<string, unknown>> {
    const now = Date.now()
    if (!fresh && this.infoCache && now - this.infoCache.at < 2000) return this.infoCache.data
    if (fresh && this.infoCache) {
      const wait = 2000 - (now - this.infoCache.at)
      if (wait > 0) await sleep(wait)
    }
    const data = await this.get<Record<string, unknown>>('getInfo')
    this.infoCache = { at: Date.now(), data: data && typeof data === 'object' && !Array.isArray(data) ? data : {} }
    return this.infoCache.data
  }

  // ---- lists ----
  scenes = async () => flatten(await this.get('getSceneList'), (r) => ({ locked: r.Locked === true }))
  overlays = async () => flatten(await this.get('getOverlayList'), (r) => ({ visible: r.Visible === true }))
  cameras = async () => flatten(await this.get('getInputs'))
  videos = async () => flatten(await this.get('getVideoList'))
  sounds = async () =>
    flatten(await this.get('getSoundList'), (r) => (typeof r.Duration === 'number' ? { duration: r.Duration } : {}))
  audioFilters = async () => flatten(await this.get('getAudioFilterList'), (r) => ('Enabled' in r ? { enabled: r.Enabled } : {}))
  profiles = async () => flatten(await this.get('getProfileList'))
  channels = async () => flatten(await this.get('getChannels'))
  currentScene = async () => scalar(await this.get('getCurrentScene')).trim()

  /**
   * setScene returns in ~30 ms but the switch lands ~400 ms later, so poll until it shows.
   */
  async switchScene(id: string): Promise<boolean> {
    await this.set('setScene', { id })
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      if ((await this.currentScene()) === id) return true
      await sleep(50)
    }
    return false
  }

  /** Mute is a toggle in Ecamm. Read, toggle only if needed, read back. */
  async setMuted(bus: AudioBus | undefined, muted: boolean): Promise<{ before: boolean; after: boolean }> {
    const params = bus ? { bus } : undefined
    const before = yes(await this.get('getMute', params))
    if (before !== muted) await this.set('setMute', params)
    const after = yes(await this.http.get('getMute', params))
    return { before, after }
  }

  /** Overlay show/hide is a toggle; overlays belong to the current scene only. */
  async setOverlayVisible(id: string, visible: boolean | 'toggle'): Promise<{ before: boolean; after: boolean | undefined }> {
    const list = await this.overlays()
    const ov = list.find((o) => o.id === id)
    if (!ov) throw new EcammError(`Overlay ${id} is not in the current scene`, 'not_found')
    const before = ov.visible === true
    if (visible === 'toggle' || before !== visible) await this.set('setOverlay', { id })
    let after: boolean | undefined
    const target = visible === 'toggle' ? !before : visible
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      after = (await this.overlays()).find((o) => o.id === id)?.visible === true
      if (after === target) break
      await sleep(100)
    }
    return { before, after }
  }

  async image(endpoint: 'getSceneImage' | 'getOverlayImage' | 'getVideoImage', id: string): Promise<string | undefined> {
    const payload = await this.get<unknown>(endpoint, { id })
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const icon = (payload as Record<string, unknown>).icon
      if (typeof icon === 'string') return icon
    }
    const s = scalar(payload)
    return s || undefined
  }
}

function loadUuid(dir: string): string {
  const file = join(dir, 'client-uuid')
  try {
    if (existsSync(file)) {
      const v = readFileSync(file, 'utf8').trim()
      if (v) return v
    }
    mkdirSync(dir, { recursive: true })
    const id = randomUUID().toUpperCase()
    writeFileSync(file, id)
    return id
  } catch {
    // Unwritable home: still works, but Ecamm will ask for approval each launch.
    return randomUUID().toUpperCase()
  }
}
