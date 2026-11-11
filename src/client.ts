import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { chooseInstance, discoverEcamm, localEcammPorts, type DiscoverFn, type DiscoveredEcamm, type LocalPortsFn } from './discovery.js'
import { EcammError, EcammHttp, type QueryParams } from './http.js'
import { VERSION } from './version.js'

export const AUDIO_BUSES = [
  'mic', 'mic2', 'skype', 'systemaudio', 'system audio', 'interview', 'zoom', 'soundeffects', 'movie',
  'guest_1', 'guest_2', 'guest_3', 'guest_4',
] as const
export type AudioBus = (typeof AUDIO_BUSES)[number]

/** Keep the original public spelling as an alias; HTTP uses systemaudio. */
export const apiAudioBus = (bus: AudioBus) => bus === 'system audio' ? 'systemaudio' : bus

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

export type OnAirState = 'idle' | 'on-air' | 'busy' | 'ended' | 'unknown'

/**
 * Ecamm has no "am I live" flag, only the main button's label. Seen on real Ecamm (English):
 * New / Record (idle), Finish (live or recording), Wait (starting or ending), OK (ended, summary showing).
 * "Go Live" is the idle label Ecamm's Stream Deck guide names; it has not been observed here.
 *
 * Anything else, including a missing label or a localized one, is 'unknown'. Unknown is never
 * treated as idle: callers must not change production state on a label they cannot read.
 */
export function onAirState(buttonLabel: unknown): OnAirState {
  const b = scalar(buttonLabel).trim()
  if (/^wait/i.test(b)) return 'busy'
  if (/^ok$/i.test(b)) return 'ended'
  if (/^(finish|end|stop)\b/i.test(b)) return 'on-air'
  if (/^(new|record|go live)$/i.test(b)) return 'idle'
  return 'unknown'
}

export type BroadcastIntent = 'go_live' | 'record' | 'end'

export type MainButtonPlan =
  | { action: 'click'; expect: 'on-air' | 'off-air'; what: string }
  | { action: 'none'; why: string; alreadyThere: boolean }

/**
 * Decide what, if anything, to do with Ecamm's one main button for a stated intent.
 *
 * The button is a toggle whose meaning depends on its label, so "click it" is never the
 * request. The request is where the person wants to end up. That makes a repeated
 * "go live" a no-op instead of an accidental "end", and refuses to click when the label
 * means something else (Wait, the end-of-broadcast OK) or cannot be read at all.
 *
 * Idle labels: "New" (or "Go Live") is a broadcast; "Record" is Record Only mode.
 */
export function planMainButton(intent: BroadcastIntent, buttonLabel: unknown): MainButtonPlan {
  const b = scalar(buttonLabel).trim()
  const state = onAirState(b)
  const none = (why: string, alreadyThere = false): MainButtonPlan => ({ action: 'none', why, alreadyThere })
  if (state === 'busy') return none(`Ecamm is in the middle of starting or ending (button reads "${b}"). Wait for it to finish, then check the status.`)
  if (state === 'unknown') {
    return none(b
      ? `Ecamm's main button reads "${b}", which this tool does not recognize, so it will not click it. If Ecamm is not in English, or this label is new, please report it.`
      : 'Ecamm did not report its main button, so this tool will not click it.')
  }
  if (intent === 'end') {
    if (state === 'on-air') return { action: 'click', expect: 'off-air', what: `End the broadcast or recording (click "${b}")` }
    return none(state === 'ended' ? 'The broadcast has already ended; Ecamm is showing its summary.' : 'Nothing is live or recording.', true)
  }
  if (state === 'on-air') return none('Ecamm is already live or recording. Nothing was clicked, because clicking now would end it.', true)
  if (state === 'ended') return none(`Ecamm is showing the summary from the last broadcast (button reads "${b}"). Dismiss it in Ecamm on the Mac, then try again.`)
  const recordOnly = /^record$/i.test(b)
  if (intent === 'go_live' && recordOnly) {
    return none('Ecamm is in Record Only mode, so its button would start a recording, not a broadcast. Switch the Mode in Ecamm, or ask to record instead.')
  }
  if (intent === 'record' && !recordOnly) {
    return none(`Ecamm is set to broadcast (button reads "${b}"), so its button would go live, not just record. Switch Ecamm's Mode to Record Only, or ask to go live instead.`)
  }
  return { action: 'click', expect: 'on-air', what: `${intent === 'record' ? 'Start recording' : 'Go live'} (click "${b}")` }
}

export interface TransitionResult {
  /** verified: reached the expected state. failed: started, then went back. unknown: could not tell. */
  outcome: 'verified' | 'failed' | 'unknown'
  state: OnAirState
  label: string
  detail?: string
}

export type ThumbnailStatus = 'on-screen' | 'refreshed' | 'visited' | 'stored'

export interface ThumbnailRefresh {
  /** Per scene id. 'refreshed' = Ecamm was seen to redraw it; 'visited' = shown, redraw not observed. */
  status: Map<string, ThumbnailStatus>
  /** Why the walk stopped early, if it did. */
  stopped?: string
  /** verified = back on the starting scene; failed = tried and it did not land; skipped = deliberately not attempted. */
  restore: 'verified' | 'failed' | 'skipped' | 'not-needed'
  restoreNote?: string
}

export interface PreflightCheck {
  check: string
  /** ok: read and fine. warn: read and a problem. unknown: could not be read. info: context only. */
  status: 'ok' | 'warn' | 'unknown' | 'info'
  detail: string
}

export interface PreflightInput {
  info: Record<string, unknown>
  sceneTitle?: string
  sourceMode?: string
  /** undefined = the list could not be read, which is not the same as an empty list. */
  destinations?: { title: string }[]
  overlays?: { title: string; visible?: unknown }[]
  /** What the person is about to do. Left out, it is inferred from the main button where that is possible. */
  intent?: 'go_live' | 'record'
}

export interface PreflightResult {
  verdict: 'problems_found' | 'incomplete' | 'no_problems_seen'
  summary: string
  intent: 'go_live' | 'record' | 'unknown'
  checks: PreflightCheck[]
  notChecked: string[]
}

const PREFLIGHT_NOT_CHECKED = [
  'Whether sound is actually reaching Ecamm. Mute and level are settings, not a signal.',
  'The camera picture.',
  'The internet connection and stream health.',
  'Which destination, event and privacy setting are selected in Ecamm.',
  'Recording settings, separate tracks and disk space.',
]

/**
 * Pre-show check built only from what Ecamm reports, and honest about the rest.
 *
 * A value Ecamm did not report is "unknown", never assumed fine: an absent mute state is
 * not unmuted, an unreadable button is not idle, and a list that failed to load is not an
 * empty list. There is no overall "ready" claim, because settings cannot show that sound,
 * picture or the connection work.
 */
export function preflight(input: PreflightInput): PreflightResult {
  const { info } = input
  const { audio } = summarizeInfo(info)
  const checks: PreflightCheck[] = []
  const add = (check: string, status: PreflightCheck['status'], detail: string) => checks.push({ check, status, detail })
  const reported = (key: string) => scalar(info[key]).trim() !== ''

  const button = scalar(info.ButtonLabel).trim()
  const state = onAirState(button)
  if (state === 'on-air') add('On-air state', 'warn', `Main button reads "${button}", so a broadcast or recording is already running.`)
  else if (state === 'busy') add('On-air state', 'warn', `Main button reads "${button}". Ecamm is in the middle of starting or ending.`)
  else if (state === 'ended') add('On-air state', 'warn', `Main button reads "${button}". The last session ended and Ecamm is waiting for its summary to be dismissed.`)
  else if (state === 'unknown') add('On-air state', 'unknown', button
    ? `Main button reads "${button}", which this tool does not recognize, so it cannot tell whether Ecamm is on air.`
    : 'Ecamm did not report its main button, so this tool cannot tell whether it is on air.')
  else add('On-air state', 'ok', `Idle. Main button reads "${button}".`)

  const intent: PreflightResult['intent'] = input.intent
    ?? (state !== 'idle' ? 'unknown' : /^record$/i.test(button) ? 'record' : 'go_live')

  if (input.sceneTitle) add('Scene', 'ok', `On "${input.sceneTitle}"${input.sourceMode ? ` (source: ${input.sourceMode})` : ''}.`)
  else add('Scene', 'unknown', 'Could not read the current scene.')

  if (!reported('Mute')) add('Main output', 'unknown', 'Ecamm did not report whether the main output is muted.')
  else if (yes(info.Mute)) add('Main output', 'warn', 'Main output is muted in Ecamm.')
  else add('Main output', 'ok', 'Main output is not muted.')

  const mic = audio.mic
  if (!mic || mic.muted === undefined) add('Mic', 'unknown', 'Ecamm did not report a mute state for the mic.')
  else if (mic.muted) add('Mic', 'warn', 'Mic is muted in Ecamm.')
  else if (mic.volume !== undefined && Number(mic.volume) === 0) add('Mic', 'warn', 'Mic level is set to 0.')
  else add('Mic', 'ok', `Mic is not muted${mic.volume !== undefined ? `, level ${mic.volume}` : ''}. This is a setting; it does not show that sound is arriving.`)

  for (const [bus, a] of Object.entries(audio)) {
    if (bus === 'mic') continue
    if (a.muted) add(`Audio: ${bus}`, 'info', `${bus} is muted.`)
    else if (a.volume !== undefined && Number(a.volume) === 0) add(`Audio: ${bus}`, 'info', `${bus} level is 0.`)
  }

  if (intent === 'record') add('Destinations', 'info', 'Not needed for a recording.')
  else if (!input.destinations) add('Destinations', 'unknown', 'The destination list could not be read.')
  else if (!input.destinations.length) add('Destinations', intent === 'go_live' ? 'warn' : 'info', 'No streaming destinations are set up in Ecamm.')
  else add('Destinations', intent === 'go_live' ? 'ok' : 'info', `Set up: ${input.destinations.map((d) => d.title).join(', ')}. This does not show which one is selected or test the connection.`)

  if (!reported('PreviewMode')) add('Preview mode', 'unknown', 'Ecamm did not report Preview Mode.')
  else if (yes(info.PreviewMode)) add('Preview mode', 'warn', 'Preview Mode is on. Scene changes will not reach viewers until published.')
  if (yes(info.LiveDemo)) add('Live demo', 'warn', 'Live Demo mode is on.')
  if (yes(info.HidingUI)) add('On-screen controls', 'info', 'Ecamm UI controls are hidden.')

  if (!input.overlays) add('Overlays', 'unknown', 'The overlay list could not be read.')
  else {
    const visible = input.overlays.filter((o) => o.visible === true).map((o) => o.title)
    add('Overlays', 'info', visible.length ? `Showing now: ${visible.join(', ')}.` : 'No overlays showing in this scene.')
  }

  const names = (status: PreflightCheck['status']) => checks.filter((c) => c.status === status).map((c) => c.check)
  const warns = names('warn')
  const unknowns = names('unknown')
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const summary = warns.length
    ? `${plural(warns.length, 'problem')} in what Ecamm reports: ${warns.join(', ')}.${unknowns.length ? ` Could not read: ${unknowns.join(', ')}.` : ''}`
    : unknowns.length
      ? `No problems seen, but ${plural(unknowns.length, 'thing')} could not be read: ${unknowns.join(', ')}.`
      : 'No problems seen in what Ecamm reports. That covers settings only; see notChecked for what this cannot tell you.'
  return {
    verdict: warns.length ? 'problems_found' : unknowns.length ? 'incomplete' : 'no_problems_seen',
    summary,
    intent,
    checks,
    notChecked: PREFLIGHT_NOT_CHECKED,
  }
}

const INFO_INTERVAL_MS = 2000
const MAX_QUEUED_MUTATIONS = 32

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
  /** How long to watch Ecamm after Go Live / End before reporting an unknown outcome. Default 45 s. */
  transitionTimeoutMs?: number
}

export type Permission = 'Allowed' | 'Denied' | 'Pending' | 'Not Found'

export class EcammClient {
  readonly http: EcammHttp
  private readonly discover: DiscoverFn
  private readonly localPorts: LocalPortsFn
  private instance?: DiscoveredEcamm
  private infoCache?: { at: number; data: Record<string, unknown> }
  /** When getInfo was last SENT. Kept apart from the cache so clearing the cache never shortens Ecamm's 2 s interval. */
  private infoSentAt = 0
  private infoChain: Promise<unknown> = Promise.resolve()
  private mutations: Promise<unknown> = Promise.resolve()
  private mutationsWaiting = 0
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
      this.infoSentAt = Date.now() // counts toward Ecamm's 2 s getInfo interval
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

  /**
   * Ecamm asks clients not to call getInfo more than every 2 s. Requests are sent one at
   * a time, at least 2 s apart, however many callers ask at once. fresh = true means
   * "sent after I asked", so a caller that has just changed something never gets an older
   * answer; callers that arrive while such a request is pending share it.
   */
  info(fresh = false): Promise<Record<string, unknown>> {
    const askedAt = Date.now()
    if (!fresh && this.infoCache && askedAt - this.infoCache.at < INFO_INTERVAL_MS) return Promise.resolve(this.infoCache.data)
    const run = this.infoChain.then(async () => {
      const c = this.infoCache
      if (c && (fresh ? c.at >= askedAt : Date.now() - c.at < INFO_INTERVAL_MS)) return c.data
      const wait = INFO_INTERVAL_MS - (Date.now() - this.infoSentAt)
      if (wait > 0) await sleep(wait)
      const sentAt = Date.now()
      this.infoSentAt = sentAt
      const data = await this.get<Record<string, unknown>>('getInfo')
      this.infoCache = { at: sentAt, data: data && typeof data === 'object' && !Array.isArray(data) ? data : {} }
      return this.infoCache.data
    })
    this.infoChain = run.catch(() => undefined)
    return run
  }

  /**
   * One mutation at a time. Wraps a whole operation (read, decide, change, verify), so two
   * requests cannot interleave and double-toggle a mute or act on a scene that just changed.
   * Take it at the tool boundary only, never inside another exclusive section.
   *
   * This orders commands from this process. Ecamm itself, a Stream Deck or another client
   * can still change things in between, which is why operations read back what happened.
   */
  async exclusive<T>(fn: () => Promise<T>, maxWaitMs = 90_000): Promise<T> {
    if (this.mutationsWaiting >= MAX_QUEUED_MUTATIONS) {
      throw new EcammError('Too many Ecamm commands are already waiting. Nothing was sent for this one; try again shortly.', 'busy')
    }
    this.mutationsWaiting++
    const previous = this.mutations
    let release!: () => void
    this.mutations = new Promise<void>((r) => (release = r))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timedOut = await Promise.race([
        previous.then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), maxWaitMs))),
      ])
      if (timedOut) {
        throw new EcammError('An earlier Ecamm command is still running. Nothing was sent for this one; check Ecamm, then try again.', 'busy')
      }
      return await fn()
    } finally {
      if (timer) clearTimeout(timer)
      this.mutationsWaiting--
      // A request that gave up waiting must still not let later ones jump ahead of the one it was waiting on.
      void previous.then(release)
    }
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

  /**
   * Replace an existing overlay's text. Returns true when Ecamm then lists the overlay under
   * the new text, which a real Ecamm 4.6.2 does for plain text overlays. false means
   * accepted but not confirmed, which is normal for overlays that keep their own name.
   */
  async setOverlayText(id: string, value: string): Promise<boolean> {
    await this.set('setOverlayText', { id, text: value })
    const deadline = Date.now() + 1500
    for (;;) {
      if ((await this.overlays()).find((o) => o.id === id)?.title === value) return true
      if (Date.now() >= deadline) return false
      await sleep(150)
    }
  }

  /** Mute is a toggle in Ecamm. Read, toggle only if needed, read back. */
  async setMuted(bus: AudioBus | undefined, muted: boolean): Promise<{ before: boolean; after: boolean }> {
    const params = bus ? { bus: apiAudioBus(bus) } : undefined
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
   * Walk the given scenes so Ecamm redraws their thumbnails, then go back to the start.
   *
   * This changes what Ecamm shows, so it is only for an explicit request. It re-checks
   * before every step and stops, without restoring, if anything it did not do itself has
   * changed: someone picked another scene or profile, or a broadcast or recording started.
   * Restoring over a person's own change would be worse than leaving it.
   */
  async refreshSceneThumbnails(sceneIds: string[], startId: string, maxWaitMs = 3500): Promise<ThumbnailRefresh> {
    const status = new Map<string, ThumbnailStatus>([[startId, 'on-screen']])
    let expected = startId
    const blocker = async (): Promise<string | undefined> => {
      const cur = await this.currentScene().catch(() => undefined)
      if (cur === undefined) return 'Ecamm stopped answering'
      if (cur !== expected) return 'the scene was changed by someone else during capture'
      const state = onAirState((await this.info()).ButtonLabel)
      if (state !== 'idle' && state !== 'ended') return `Ecamm's state changed to "${state}" during capture`
      return undefined
    }

    for (const id of sceneIds) {
      if (id === startId) continue
      const stop = await blocker()
      if (stop) return { status, stopped: stop, restore: 'skipped', restoreNote: 'Left as found, so a change someone else made is not overwritten.' }
      const before = (await this.sceneImage(id))?.data
      if (!(await this.switchScene(id))) continue // never landed; expected is unchanged and re-checked next loop
      expected = id
      status.set(id, 'visited')
      const deadline = Date.now() + maxWaitMs
      while (Date.now() < deadline) {
        await sleep(350)
        const now = (await this.sceneImage(id))?.data
        if (now && now !== before) {
          status.set(id, 'refreshed')
          await sleep(900) // the outline appears first; give the picture itself a beat
          break
        }
      }
    }

    if (expected === startId) return { status, restore: 'not-needed' }
    const stop = await blocker()
    if (stop) return { status, stopped: stop, restore: 'skipped', restoreNote: 'Left as found, so a change someone else made is not overwritten.' }
    await this.switchScene(startId)
    const back = (await this.currentScene().catch(() => undefined)) === startId
    return back
      ? { status, restore: 'verified' }
      : { status, restore: 'failed', restoreNote: 'Ecamm did not return to the starting scene. Check which scene is on screen.' }
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
  /**
   * After clicking the main button, watch until Ecamm reaches the state that was asked for.
   * "No longer says Wait" is not success: a failed start goes Wait and then back to idle.
   * The label can also stay put for a moment before Wait appears, so an unchanged label is
   * only read as "nothing happened" after a grace period.
   */
  async verifyTransition(expect: 'on-air' | 'off-air', from: OnAirState): Promise<TransitionResult> {
    const timeoutMs = this.opts.transitionTimeoutMs ?? 45_000
    const graceMs = Math.min(10_000, timeoutMs)
    const started = Date.now()
    const reached = (s: OnAirState) => (expect === 'on-air' ? s === 'on-air' : s === 'idle' || s === 'ended')
    let sawBusy = false
    for (;;) {
      const label = scalar((await this.info(true)).ButtonLabel).trim()
      const state = onAirState(label)
      const elapsed = Date.now() - started
      if (reached(state)) return { outcome: 'verified', state, label }
      if (state === 'busy') sawBusy = true
      else if (state === from && sawBusy) {
        return { outcome: 'failed', state, label, detail: `Ecamm started the change and then went back to "${label}".` }
      } else if (state === from && elapsed >= graceMs) {
        return { outcome: 'unknown', state, label, detail: `The button still reads "${label}". The click may not have registered, or Ecamm may be waiting on a dialog.` }
      }
      if (elapsed >= timeoutMs) {
        return { outcome: 'unknown', state, label, detail: `Gave up waiting after ${Math.round(timeoutMs / 1000)} s; the button reads "${label}". Check Ecamm before sending this again.` }
      }
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
