import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { chooseInstance, discoverEcamm, localEcammPorts, type DiscoverFn, type DiscoveredEcamm, type LocalPortsFn } from './discovery.js'
import { EcammError, EcammHttp, type QueryParams } from './http.js'
import { VERSION } from './version.js'

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

export type OnAirState = 'idle' | 'on-air' | 'busy' | 'ended'

/**
 * Ecamm has no "am I live" flag, only the main button's label. Seen on real Ecamm:
 * New / Record (idle), Finish (live or recording), Wait (starting or ending), OK (ended, summary showing).
 */
export function onAirState(buttonLabel: unknown): OnAirState {
  const b = scalar(buttonLabel).trim()
  if (/^wait/i.test(b)) return 'busy'
  if (/^ok$/i.test(b)) return 'ended'
  if (/\b(end|stop|finish)\b/i.test(b)) return 'on-air'
  return 'idle'
}

export interface PreflightCheck {
  check: string
  status: 'ok' | 'warn' | 'info'
  detail: string
}

export interface PreflightInput {
  info: Record<string, unknown>
  sceneTitle?: string
  sourceMode?: string
  destinations: { title: string }[]
  overlays: { title: string; visible?: unknown }[]
}

/**
 * Pre-show checklist built only from what Ecamm reports. "warn" means a viewer would
 * notice (silent stream, nowhere to stream to, already on air); "info" is context.
 */
export function preflight(input: PreflightInput): { ready: boolean; summary: string; checks: PreflightCheck[] } {
  const { info } = input
  const { audio, mainMuted } = summarizeInfo(info)
  const checks: PreflightCheck[] = []
  const add = (check: string, status: PreflightCheck['status'], detail: string) => checks.push({ check, status, detail })

  const button = scalar(info.ButtonLabel).trim()
  const state = onAirState(button)
  if (state === 'on-air') add('On-air state', 'warn', `Main button reads "${button}", so a broadcast or recording is already running.`)
  else if (state === 'busy') add('On-air state', 'warn', `Main button reads "${button}". Ecamm is in the middle of starting or ending a broadcast.`)
  else if (state === 'ended') add('On-air state', 'warn', `Main button reads "${button}". The last broadcast ended and Ecamm is waiting for you to dismiss its summary.`)
  else add('On-air state', 'ok', `Idle. Main button reads "${button || 'unknown'}".`)

  add('Scene', input.sceneTitle ? 'ok' : 'warn', input.sceneTitle
    ? `Starting on "${input.sceneTitle}"${input.sourceMode ? ` (source: ${input.sourceMode})` : ''}.`
    : 'Could not read the current scene.')

  add('Main output', mainMuted ? 'warn' : 'ok', mainMuted ? 'Main output is MUTED. Viewers will hear nothing.' : 'Main output is unmuted.')

  const mic = audio.mic
  if (!mic) add('Mic', 'info', 'Ecamm did not report a mic bus.')
  else if (mic.muted) add('Mic', 'warn', 'Mic is MUTED.')
  else if (Number(mic.volume) === 0) add('Mic', 'warn', 'Mic volume is 0.')
  else add('Mic', 'ok', `Mic is live at volume ${mic.volume ?? 'unknown'}.`)

  for (const [bus, a] of Object.entries(audio)) {
    if (bus === 'mic') continue
    if (a.muted) add(`Audio: ${bus}`, 'info', `${bus} is muted.`)
    else if (Number(a.volume) === 0) add(`Audio: ${bus}`, 'info', `${bus} volume is 0.`)
  }

  add('Destinations', input.destinations.length ? 'ok' : 'warn', input.destinations.length
    ? `Available: ${input.destinations.map((d) => d.title).join(', ')}.`
    : 'No streaming destinations are set up in Ecamm.')

  if (yes(info.PreviewMode)) add('Preview mode', 'warn', 'Preview Mode is ON. Scene changes will not reach viewers until published.')
  if (yes(info.LiveDemo)) add('Live demo', 'warn', 'Live Demo mode is ON.')
  if (yes(info.HidingUI)) add('On-screen controls', 'info', 'Ecamm UI controls are hidden.')

  const visible = input.overlays.filter((o) => o.visible === true).map((o) => o.title)
  add('Overlays', 'info', visible.length ? `Showing now: ${visible.join(', ')}.` : 'No overlays showing in this scene.')

  const warns = checks.filter((c) => c.status === 'warn')
  return {
    ready: warns.length === 0,
    summary: warns.length === 0 ? 'Ready. Nothing to fix.' : `${warns.length} thing${warns.length === 1 ? '' : 's'} to fix: ${warns.map((w) => w.check).join(', ')}.`,
    checks,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- client ----------

export interface ClientOptions {
  /** "address:port" to skip Bonjour (port changes each Ecamm launch, so mostly for testing) */
  host?: string
  hostname?: string
  discover?: DiscoverFn
  localPorts?: LocalPortsFn
  fetchImpl?: typeof fetch
  stateDir?: string
  clientName?: string
  /**
   * How long a call waits for the user to click Allow in Ecamm before giving up.
   * Lets the very first request succeed instead of failing and needing a retry.
   */
  approvalWaitMs?: number
}

export type Permission = 'Allowed' | 'Denied' | 'Pending' | 'Not Found'

export class EcammClient {
  readonly http: EcammHttp
  private readonly discover: DiscoverFn
  private readonly localPorts: LocalPortsFn
  private instance?: DiscoveredEcamm
  private infoCache?: { at: number; data: Record<string, unknown> }
  private approved = false
  readonly clientName: string

  constructor(private readonly opts: ClientOptions = {}) {
    this.discover = opts.discover ?? discoverEcamm
    this.localPorts = opts.localPorts ?? localEcammPorts
    this.clientName = opts.clientName ?? 'Claude (ecamm-mcp)'
    this.http = new EcammHttp({
      uuid: loadUuid(opts.stateDir ?? join(homedir(), '.ecamm-mcp')),
      clientName: this.clientName,
      clientVersion: VERSION,
      deviceName: hostname(),
      timeoutMs: 4000,
      fetchImpl: opts.fetchImpl,
    })
    if (opts.host) this.http.host = opts.host
  }

  get target() {
    return { host: this.http.host, instance: this.instance }
  }

  /**
   * Finds Ecamm. When the target is this Mac (the normal case), look for Ecamm's port locally
   * first and use loopback: no Bonjour wait, and no dependence on macOS Local Network
   * permission, which Claude desktop's child processes often don't get. Otherwise Bonjour.
   */
  async locate(): Promise<DiscoveredEcamm[]> {
    const norm = (s: string) => s.toLowerCase().replace(/\.local$/, '').replace(/\.$/, '')
    const me = hostname()
    const wantsLocal = !this.opts.hostname || norm(this.opts.hostname) === norm(me)

    if (wantsLocal) {
      const loop = await this.probeLocal()
      if (loop) return [loop]
    }

    const found = await this.discover(3000)
    const { pick, reason } = chooseInstance(found, { hostname: this.opts.hostname, localHostname: me })
    if (!pick) {
      const hint = found.length
        ? ''
        : wantsLocal
          ? ''
          : ' If Bonjour works in Terminal but not here, allow Claude in System Settings > Privacy & Security > Local Network.'
      throw new EcammError(reason + hint, 'unreachable')
    }
    const local = norm(pick.hostname) === norm(me)
    this.instance = pick
    this.http.host = `${local ? '127.0.0.1' : pick.addresses[0]}:${pick.port}`
    return found
  }

  /** Tries each port Ecamm is listening on locally; keeps the first that answers the Remote API. */
  private async probeLocal(): Promise<DiscoveredEcamm | undefined> {
    const ports = await this.localPorts().catch(() => [] as number[])
    const previous = this.http.host
    for (const port of ports) {
      this.http.host = `127.0.0.1:${port}`
      try {
        const reply = await this.http.get('getConnectionStatus')
        if (Array.isArray(reply)) {
          this.instance = { name: 'Ecamm Live (this Mac)', hostname: hostname(), addresses: ['127.0.0.1'], port }
          return this.instance
        }
      } catch {
        /* not the Remote API port */
      }
    }
    this.http.host = previous
    return undefined
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
    // Ecamm pops an Allow / Deny dialog on first contact. Give the user a moment to click it
    // so the first request works instead of erroring.
    const deadline = Date.now() + (this.opts.approvalWaitMs ?? 0)
    while (perm !== 'Allowed' && perm !== 'Denied' && Date.now() < deadline) {
      await sleep(Math.min(1000, Math.max(50, deadline - Date.now())))
      perm = await this.permission()
    }
    this.approved = perm === 'Allowed'
    if (!this.approved) throw new EcammError(approvalMessage(perm, this.clientName), 'permission')
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

  /** A scene's stored thumbnail. Ecamm only refreshes it while that scene is on screen. */
  sceneImage(id: string): Promise<EcammImage | undefined> {
    return this.image('getSceneImage', id).catch(() => undefined)
  }

  /**
   * Put a scene on screen and wait for Ecamm to redraw its thumbnail. Returns false if
   * the switch never landed. The thumbnail changes when the scene goes current (Ecamm
   * outlines it), so a change is the signal; then allow a beat for the picture itself.
   */
  async visitSceneForThumbnail(id: string, maxWaitMs = 3500): Promise<boolean> {
    const before = (await this.sceneImage(id))?.data
    if (!(await this.switchScene(id))) return false
    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline) {
      await sleep(350)
      const now = (await this.sceneImage(id))?.data
      if (now && now !== before) {
        await sleep(900)
        break
      }
    }
    return true
  }

  async image(endpoint: 'getSceneImage' | 'getOverlayImage' | 'getVideoImage', id: string): Promise<EcammImage | undefined> {
    const payload = await this.get<unknown>(endpoint, { id })
    let raw = ''
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const rec = payload as Record<string, unknown>
      raw = scalar(rec.icon ?? rec.image ?? rec.data)
    } else {
      raw = scalar(payload)
    }
    if (!raw.trim()) return undefined
    return normalizeImage(raw)
  }

  /** After Go Live or Finish the button reads "Wait" for up to ~20 s. Poll until it settles. */
  async settleMainButton(timeoutMs = 45000): Promise<{ label: string; state: OnAirState; settled: boolean }> {
    const deadline = Date.now() + timeoutMs
    let label = ''
    for (;;) {
      label = scalar((await this.info(true)).ButtonLabel).trim()
      const state = onAirState(label)
      if (state !== 'busy') return { label, state, settled: true }
      if (Date.now() >= deadline) return { label, state, settled: false }
    }
  }

  /** setMode lands a beat after it returns "Done", so poll until getCurrentMode agrees. */
  async setSourceMode(mode: string): Promise<{ mode: string; confirmed: boolean }> {
    await this.set('setMode', { mode })
    const deadline = Date.now() + 2000
    let now = ''
    while (Date.now() < deadline) {
      now = scalar(await this.get('getCurrentMode')).trim()
      if (now === mode) return { mode: now, confirmed: true }
      await sleep(100)
    }
    return { mode: now, confirmed: false }
  }
}

export interface EcammImage {
  data: string
  mimeType: string
}

/**
 * Ecamm hands thumbnails back as base64 from Cocoa, which may be line-wrapped, carry a
 * data: URI prefix, or use the URL-safe alphabet. MCP clients reject anything but strict
 * base64, so clean it, check it really decodes to an image, and report the true format.
 */
export function normalizeImage(raw: string): EcammImage {
  let s = raw.trim()
  const uri = /^data:[^,]*,/i.exec(s)
  if (uri) s = s.slice(uri[0].length)
  if (s.includes('%')) {
    try { s = decodeURIComponent(s) } catch { /* not percent-encoded after all */ }
  }
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  // Real Ecamm payloads carry characters outside the base64 alphabet (line wraps, escapes).
  // Drop them and let the image signature below decide whether what is left is an image.
  const stray = [...new Set(s.replace(/[A-Za-z0-9+/=\s]/g, ''))].slice(0, 12)
  s = s.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes = Buffer.from(s, 'base64')
  const mimeType = sniffImage(bytes)
  if (!mimeType) {
    throw new EcammError(
      `Ecamm returned a thumbnail that is not a recognizable image (length ${raw.length}, starts ${JSON.stringify(raw.slice(0, 40))}, ` +
        `first bytes ${bytes.subarray(0, 8).toString('hex') || 'none'}, unexpected characters ${JSON.stringify(stray)})`,
      'parse',
    )
  }
  return { data: bytes.toString('base64'), mimeType }
}

function sniffImage(b: Buffer): string | undefined {
  const hex = b.subarray(0, 12).toString('hex')
  if (hex.startsWith('ffd8ff')) return 'image/jpeg'
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png'
  if (hex.startsWith('47494638')) return 'image/gif'
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'image/webp'
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'image/tiff'
  return undefined
}

export function approvalMessage(perm: Permission, clientName: string): string {
  return perm === 'Denied'
    ? `Ecamm Live denied "${clientName}". Turn it back on in Ecamm Live > Settings > Remote Control, then try again.`
    : `Waiting for approval. Ecamm Live is showing a "${clientName} Wants To Control Ecamm" dialog: click Allow, then try again. ` +
        `No dialog? Open Ecamm Live > Settings > Remote Control and tick "${clientName}".`
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
