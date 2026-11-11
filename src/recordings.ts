import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { link, mkdir, open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { envValue } from './env.js'

const eventSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/),
  receivedAt: z.string().datetime(), machine: z.string(), path: z.string(),
  identity: z.object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }),
}).strict()
export type RecordingEvent = z.infer<typeof eventSchema>
export interface RecordingOptions { roots: string[]; inbox: string; ffprobe: string }

export function recordingOptions(env: NodeJS.ProcessEnv = process.env): RecordingOptions {
  const configuredRoots = envValue(env.ECAMM_RECORDING_ROOTS)
  const folder = envValue(env.ECAMM_RECORDING_FOLDER)
  const roots = configuredRoots
    ? z.array(z.string().min(1).refine(isAbsolute, 'Recording folders must be absolute paths')).max(20).parse(JSON.parse(configuredRoots))
    : folder ? [z.string().refine(isAbsolute, 'Recording folder must be an absolute path').parse(folder)] : []
  return {
    roots,
    inbox: envValue(env.ECAMM_RECORDING_INBOX) || join(homedir(), '.ecamm-mcp', 'recording-events'),
    ffprobe: envValue(env.ECAMM_FFPROBE) || 'ffprobe',
  }
}

/** All media access is opt-in and local. Canonicalize both roots and requested paths. */
export async function allowedRecording(path: string, roots: string[]): Promise<string> {
  if (!roots.length) throw new Error('Recording access is not configured. Set the extension Recording folder or ECAMM_RECORDING_FOLDER to its absolute path on this Mac.')
  if (!isAbsolute(path)) throw new Error('Use an absolute recording path on this Mac.')
  const canonical = await realpath(path)
  for (const root of roots) {
    let base: string
    try { base = await realpath(root) } catch { continue }
    const rel = relative(base, canonical)
    if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      if (!(await stat(canonical)).isFile()) throw new Error('The recording path must be a regular file.')
      return canonical
    }
  }
  throw new Error('Recording is outside the configured folders or its storage is unavailable.')
}

const identityOf = (s: Stats) => ({ dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs })
const eventId = (path: string, identity: RecordingEvent['identity']) =>
  createHash('sha256').update(JSON.stringify({ path, identity })).digest('hex')

/** Persist completion notifications even when no MCP client is connected. Never alter media. */
export async function receiveRecording(path: string, opts: RecordingOptions) {
  const canonical = await allowedRecording(path, opts.roots)
  const identity = identityOf(await stat(canonical))
  const id = eventId(canonical, identity)
  const event: RecordingEvent = { version: 1, id, receivedAt: new Date().toISOString(), machine: hostname(), path: canonical, identity }
  await mkdir(opts.inbox, { recursive: true, mode: 0o700 })
  const temp = join(opts.inbox, `.${randomUUID()}.tmp`)
  const destination = join(opts.inbox, `${id}.json`)
  let duplicate = false
  try {
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(event) + '\n')
      await file.sync()
    } finally { await file.close() }
    // Link is atomic and will not replace an earlier event with the same identity.
    await link(temp, destination)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    duplicate = true
  } finally { await unlink(temp).catch(() => {}) }
  return { eventId: id, duplicate, recordedPath: canonical, note: 'Completion notification saved. Media and associated tracks have not yet been verified.' }
}

async function readEvent(path: string): Promise<RecordingEvent> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = await f.stat()
    if (!s.isFile() || s.size > 16384) throw new Error('Invalid event file.')
    const event = eventSchema.parse(JSON.parse(await f.readFile('utf8')))
    if (event.id !== eventId(event.path, event.identity)) throw new Error('Invalid event identity.')
    return event
  } finally { await f.close() }
}

export async function listRecordings(opts: RecordingOptions, limit = 20) {
  let names: string[]
  try { names = await readdir(opts.inbox) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], warnings: [] }
    throw err
  }
  const files = names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))
  if (files.length > 5000) throw new Error('The recording inbox exceeds 5,000 events. Archive older event files before listing it.')
  const events: RecordingEvent[] = []
  const warnings: string[] = []
  for (const name of files) {
    try {
      const event = await readEvent(join(opts.inbox, name))
      if (`${event.id}.json` !== name) throw new Error('Event filename mismatch.')
      events.push(event)
    } catch { warnings.push(`Could not read event ${name}.`) }
  }
  return {
    events: events.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, Math.max(1, Math.min(100, limit))),
    warnings, note: 'Notifications only; file availability and media quality are not verified by this list.',
  }
}

const probeSchema = z.object({
  streams: z.array(z.object({
    codec_type: z.string().optional(), codec_name: z.string().optional(),
    width: z.number().optional(), height: z.number().optional(), channels: z.number().optional(),
    disposition: z.object({ attached_pic: z.number().optional() }).optional(),
  })).max(256).default([]),
  format: z.object({ duration: z.string().optional(), format_name: z.string().optional() }).optional(),
})
export type Probe = (path: string) => Promise<unknown>

export function mediaProbe(executable: string): Probe {
  return path => new Promise((resolve, reject) => {
    execFile(executable, ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,wav,mp3,aac,flac,ogg', '-show_entries',
      'format=duration,format_name:stream=codec_type,codec_name,width,height,channels:stream_disposition=attached_pic', '-of', 'json', path],
    { timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Media inspection requires ffprobe. Install it or configure ECAMM_FFPROBE with its executable path.'
          : 'Media inspection failed or timed out. The file may still be finishing or may be unreadable.'))
        return
      }
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('Media inspector returned invalid JSON.')) }
    })
  })
}

export async function inspectRecording(path: string, opts: RecordingOptions, probe: Probe = mediaProbe(opts.ffprobe)) {
  const canonical = await allowedRecording(path, opts.roots)
  const before = await stat(canonical)
  const media = probeSchema.parse(await probe(canonical))
  const after = await stat(canonical)
  const changed = before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev
  const rawDuration = Number(media.format?.duration)
  const durationSeconds = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined
  return {
    path: canonical, inspectedAt: new Date().toISOString(), bytes: after.size,
    identity: identityOf(after), status: changed ? 'changing' as const : 'metadata_read' as const,
    durationSeconds, format: media.format?.format_name,
    streams: media.streams,
    hasVideo: media.streams.some(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1),
    hasAudio: media.streams.some(s => s.codec_type === 'audio'),
    limitations: [
      'Metadata inspection does not prove complete decoding, finalization, synchronization, or audible speech.',
      ...(changed ? ['The file changed during inspection; inspect it again after recording finishes.'] : []),
    ],
  }
}

export interface Marker { seconds: number; timecode: string; text: string }

/**
 * Ecamm's marker file, as written by 4.6.2 beside a recording: one marker per line,
 * HH:MM:SS, then a tab and the text when there is any. Ecamm adds "Start" at 00:00:00.
 * Anything that does not fit is returned as unparsed and the file is called unrecognized,
 * so a different or future layout is never half-read as if it were understood.
 */
export function parseMarkerFile(text: string): { format: 'ecamm-markers-v1' | 'unrecognized'; markers: Marker[]; unparsed: string[] } {
  const markers: Marker[] = []
  const unparsed: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line) continue
    const m = /^(\d{2,3}):([0-5]\d):([0-5]\d)(?:\t(.*))?$/.exec(line)
    if (!m) { unparsed.push(line.slice(0, 200)); continue }
    markers.push({ seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), timecode: `${m[1]}:${m[2]}:${m[3]}`, text: m[4] ?? '' })
  }
  return { format: markers.length && !unparsed.length ? 'ecamm-markers-v1' : 'unrecognized', markers, unparsed: unparsed.slice(0, 20) }
}

const MARKER_LIMITS = [
  'Times are as Ecamm wrote them. In one real recording (Ecamm 4.6.2) they counted recorded time, so a pause did not add to them, and a marker dropped while paused got the time of the pause.',
  'After a split into a new file, the new file\'s marker times did not restart at zero in that one recording: they carried on from the earlier part. Such a time is later than the file is long. Check one marker against the picture before relying on them for an edit.',
]

/** Markers timed later than the recording is long. Seen in the second file of a split session. */
export function markersPastEnd(markers: { seconds: number }[], durationSeconds: number | undefined): number {
  if (!durationSeconds) return 0
  return markers.filter((m) => m.seconds > durationSeconds + 1).length
}

/** Read a marker file inside the configured recording folders. Never writes. */
export async function readMarkers(path: string, opts: RecordingOptions) {
  const canonical = await allowedRecording(path, opts.roots)
  if (extname(canonical).toLowerCase() !== '.txt') throw new Error('Marker files end in .txt and sit beside the recording with the same name.')
  if ((await stat(canonical)).size > 262144) throw new Error('That file is larger than a marker file should be (256 KB limit).')
  const parsed = parseMarkerFile(await readFile(canonical, 'utf8'))
  const titled = parsed.markers.filter((m) => m.text)
  return {
    path: canonical, ...parsed,
    // A convenience for descriptions. YouTube has its own rules for chapters (first at 0:00, minimum count and spacing).
    chapterLines: parsed.format === 'ecamm-markers-v1' ? titled.map((m) => `${m.timecode.replace(/^00:/, '')} ${m.text}`) : [],
    limitations: parsed.format === 'ecamm-markers-v1' ? MARKER_LIMITS : ['This file does not match the marker layout this tool knows. Nothing was inferred from it.'],
  }
}

/**
 * Files Ecamm saves beside a recording under exactly the same name: markers (.txt) and
 * shown comments (.srt). Only an exact name match counts. Separate-track files are not
 * looked for, because their naming has not been observed.
 */
export async function sidecarsOf(recordingPath: string, opts: RecordingOptions) {
  const base = recordingPath.slice(0, recordingPath.length - extname(recordingPath).length)
  const found: { markers?: Awaited<ReturnType<typeof readMarkers>>; comments?: { path: string }; problems: string[] } = { problems: [] }
  for (const [ext, kind] of [['.txt', 'markers'], ['.srt', 'comments']] as const) {
    let canonical: string
    try { canonical = await allowedRecording(base + ext, opts.roots) } catch { continue } // not there, or not ours to read
    if (kind === 'comments') found.comments = { path: canonical }
    else try { found.markers = await readMarkers(canonical, opts) } catch (err) { found.problems.push(err instanceof Error ? err.message : String(err)) }
  }
  return found
}

export interface ExpectedAsset { label: string; kind: 'program' | 'video' | 'audio'; path?: string }
export async function prepareHandoff(eventIdValue: string, assets: ExpectedAsset[], opts: RecordingOptions, probe?: Probe) {
  if (!/^[a-f0-9]{64}$/.test(eventIdValue)) throw new Error('Invalid recording event ID.')
  const event = await readEvent(join(opts.inbox, `${eventIdValue}.json`))
  if (event.id !== eventIdValue) throw new Error('Event ID mismatch.')
  const main = await inspectRecording(event.path, opts, probe)
  if (JSON.stringify(main.identity) !== JSON.stringify(event.identity)) throw new Error('The original recording has been replaced. This event cannot identify the replacement session.')
  const inspected = new Map([[main.path, main]])
  const fileIdentities = new Set([`${main.identity.dev}:${main.identity.ino}`])
  const result = []
  const deadline = Date.now() + 45000
  for (const asset of assets) {
    if (!asset.path) { result.push({ ...asset, status: 'needs_file' }); continue }
    if (Date.now() >= deadline) { result.push({ ...asset, status: 'pending', detail: 'Inspection time budget reached; inspect this asset separately.' }); continue }
    try {
      const canonical = await allowedRecording(asset.path, opts.roots)
      if (inspected.has(canonical)) {
        result.push({ ...asset, status: 'duplicate_file', detail: 'This file already represents the main recording or another expected asset.' })
        continue
      }
      const media = await inspectRecording(canonical, opts, probe)
      const identity = `${media.identity.dev}:${media.identity.ino}`
      if (fileIdentities.has(identity)) {
        result.push({ ...asset, status: 'duplicate_file', detail: 'This path is a hard link to an already listed file, not a separate recording.' })
        continue
      }
      inspected.set(canonical, media)
      fileIdentities.add(identity)
      const matches = asset.kind === 'audio' ? media.hasAudio : asset.kind === 'video' ? media.hasVideo : media.hasAudio && media.hasVideo
      result.push({ ...asset, status: media.status === 'changing' ? 'pending' : !matches || !media.durationSeconds ? 'needs_check' : 'metadata_checked', media })
    } catch (err) { result.push({ ...asset, status: 'unavailable', detail: err instanceof Error ? err.message : String(err) }) }
  }
  const sidecars = await sidecarsOf(main.path, opts)
  const past = sidecars.markers ? markersPastEnd(sidecars.markers.markers, main.durationSeconds) : 0
  if (past) sidecars.problems.push(`${past} marker time(s) are later than this recording is long. This file is probably a later part of a split session and its marker times carry on from the earlier part. They are not offsets into this file; no correction was applied.`)
  return {
    version: 1, event, main, assets: result, sidecars,
    assessment: main.status === 'changing' || !main.hasVideo || !main.hasAudio || !main.durationSeconds || result.some(a => a.status !== 'metadata_checked')
      ? 'needs_attention' : 'listed_media_metadata_checked',
    limitations: ['Only explicitly supplied media files were associated with this session. No separate-track (ISO) matching was performed.',
      'Marker and comment files are attached only when they sit beside the main recording under exactly the same name.',
      'An empty expected-assets list does not establish that all session tracks are present.',
      'This receipt neither transfers files nor verifies backup, editing import, or audio/video synchronization.'],
  }
}

/** Diagnose setup without opening recordings, writing files, or contacting Ecamm. */
export async function recordingDoctor(opts: RecordingOptions) {
  const folders = await Promise.all(opts.roots.map(async path => {
    try {
      const canonical = await realpath(path)
      const info = await stat(canonical)
      return { path, canonical, status: info.isDirectory() ? 'available' : 'not_a_folder' }
    } catch { return { path, status: 'unavailable' } }
  }))
  const inspector = await new Promise<{ status: string; version?: string; detail?: string }>(resolve => {
    execFile(opts.ffprobe, ['-version'], { timeout: 5000, maxBuffer: 65536, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve({ status: 'unavailable', detail: 'Set the media inspector location to an installed ffprobe executable.' })
      const firstLine = stdout.split(/\r?\n/, 1)[0]
      resolve(/^ffprobe version\s/.test(firstLine)
        ? { status: 'available', version: firstLine.slice(0, 256) }
        : { status: 'unrecognized', detail: 'The configured executable did not identify itself as ffprobe.' })
    })
  })
  let inboxStatus = 'not_created'
  try { inboxStatus = (await stat(opts.inbox)).isDirectory() ? 'exists' : 'not_a_folder' } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') inboxStatus = 'unavailable'
  }
  return {
    machine: hostname(), folders, inspector, inbox: { path: opts.inbox, status: inboxStatus },
    metadataInspectionConfigured: inspector.status === 'available' && folders.some(f => f.status === 'available'),
    completionHook: 'not_verified',
    limitations: ['This checks configuration only, not recording quality, folder write permission, or whether Ecamm has the completion Shortcut enabled.',
      'The Shortcut helper and MCP must use the same recording folders and inbox on this Mac.'],
  }
}
