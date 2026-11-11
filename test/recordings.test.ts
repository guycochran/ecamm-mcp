import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowedRecording, inspectRecording, listRecordings, mediaProbe, parseMarkerFile, prepareHandoff, readMarkers, receiveRecording, recordingDoctor, recordingOptions, sidecarsOf, type RecordingOptions } from '../src/recordings.js'

const video = async () => ({ streams: [{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio', channels: 2 }], format: { duration: '12.5', format_name: 'mov,mp4' } })
let directory: string, root: string, movie: string, opts: RecordingOptions
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ecamm-recordings-'))
  root = join(directory, 'recordings'); await mkdir(root)
  movie = join(root, 'Interview Renée $(do not run).mp4'); await writeFile(movie, 'fixture')
  opts = { roots: [root], inbox: join(directory, 'inbox'), ffprobe: 'ffprobe' }
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('recording folder boundary', () => {
  it('requires opt-in roots', async () => { await expect(allowedRecording(movie, [])).rejects.toThrow('not configured') })
  it('accepts a regular file with spaces and unicode', async () => { expect(await allowedRecording(movie, [root])).toContain('Renée') })
  it('rejects directories and relative paths', async () => {
    await expect(allowedRecording(root, [root])).rejects.toThrow()
    await expect(allowedRecording('movie.mp4', [root])).rejects.toThrow('absolute')
  })
  it('rejects sibling prefixes and symlinks escaping the root', async () => {
    const other = join(directory, 'recordings-other'); await mkdir(other)
    const path = join(other, 'movie.mp4'); await writeFile(path, 'private')
    await expect(allowedRecording(path, [root])).rejects.toThrow('outside')
    const link = join(root, 'escape.mp4'); await symlink(path, link)
    await expect(allowedRecording(link, [root])).rejects.toThrow('outside')
  })
  it('accepts a reachable root even if a different configured drive is offline', async () => {
    expect(await allowedRecording(movie, ['/missing/ecamm-volume', root])).toContain('Renée')
  })
  it('validates configuration rather than silently widening access', () => {
    expect(recordingOptions({}).roots).toEqual([])
    expect(() => recordingOptions({ ECAMM_RECORDING_ROOTS: '["relative"]' })).toThrow()
    expect(() => recordingOptions({ ECAMM_RECORDING_ROOTS: 'not json' })).toThrow()
  })
  it('treats unfilled desktop extension settings as unset', () => {
    const options = recordingOptions({ ECAMM_RECORDING_FOLDER: '${user_config.recording_folder}', ECAMM_FFPROBE: '${user_config.ffprobe}' })
    expect(options.roots).toEqual([])
    expect(options.ffprobe).toBe('ffprobe')
  })
})

describe('persistent completion inbox', () => {
  it('is empty before the first notification', async () => { expect((await listRecordings(opts)).events).toEqual([]) })
  it('deduplicates simultaneous events and preserves one complete record', async () => {
    const received = await Promise.all(Array.from({ length: 8 }, () => receiveRecording(movie, opts)))
    expect(new Set(received.map(r => r.eventId)).size).toBe(1)
    expect(received.filter(r => !r.duplicate)).toHaveLength(1)
    const files = await readdir(opts.inbox)
    expect(files).toHaveLength(1)
    const event = JSON.parse(await readFile(join(opts.inbox, files[0]), 'utf8'))
    expect(event.path).toContain('Renée')
    expect((await listRecordings({ ...opts })).events).toHaveLength(1)
    expect(await readFile(movie, 'utf8')).toBe('fixture')
  })
  it('ignores temporary files and reports malformed records', async () => {
    await mkdir(opts.inbox)
    await writeFile(join(opts.inbox, '.pending.tmp'), 'partial')
    await writeFile(join(opts.inbox, `${'a'.repeat(64)}.json`), '{}')
    const result = await listRecordings(opts)
    expect(result.events).toHaveLength(0); expect(result.warnings).toHaveLength(1)
  })
  it('does not follow event symlinks', async () => {
    await mkdir(opts.inbox)
    await symlink(movie, join(opts.inbox, `${'a'.repeat(64)}.json`))
    expect((await listRecordings(opts)).warnings).toHaveLength(1)
  })
  it('retains events after storage disappears but inspection fails', async () => {
    const event = await receiveRecording(movie, opts)
    await rm(movie)
    expect((await listRecordings(opts)).events).toHaveLength(1)
    await expect(prepareHandoff(event.eventId, [], opts, video)).rejects.toThrow()
  })
  it('rejects a replaced recording associated with an old event', async () => {
    const event = await receiveRecording(movie, opts)
    await rename(movie, join(root, 'original.mp4'))
    await writeFile(movie, 'replacement')
    await expect(prepareHandoff(event.eventId, [], opts, video)).rejects.toThrow('replaced')
    expect((await receiveRecording(movie, opts)).eventId).not.toBe(event.eventId)
  })
})

describe('inspection and edit receipts', () => {
  it('does not mistake album artwork for a guest video recording', async () => {
    const result = await inspectRecording(movie, opts, async () => ({
      streams: [{ codec_type: 'audio' }, { codec_type: 'video', disposition: { attached_pic: 1 } }], format: { duration: '12' },
    }))
    expect(result.hasVideo).toBe(false)
    expect(result.hasAudio).toBe(true)
  })
  it('does not count hard links as separate recording tracks', async () => {
    const event = await receiveRecording(movie, opts)
    const alias = join(root, 'guest.mp4'); await link(movie, alias)
    const result = await prepareHandoff(event.eventId, [{ label: 'Guest', kind: 'video', path: alias }], opts, video)
    expect(result.assets[0].status).toBe('duplicate_file')
  })
  it('diagnoses unavailable dependencies without opening media or creating the inbox', async () => {
    const result = await recordingDoctor({ ...opts, roots: [root, movie, '/missing/volume'], ffprobe: '/missing/ffprobe' })
    expect(result.folders.map(f => f.status)).toEqual(['available', 'not_a_folder', 'unavailable'])
    expect(result.inspector.status).toBe('unavailable')
    expect(result.metadataInspectionConfigured).toBe(false)
    expect(result.completionHook).toBe('not_verified')
    expect(result.inbox.status).toBe('not_created')
    await expect(readdir(opts.inbox)).rejects.toThrow()
  })
  it('reports metadata without claiming audible speech or completion', async () => {
    const result = await inspectRecording(movie, opts, video)
    expect(result).toMatchObject({ status: 'metadata_read', durationSeconds: 12.5, hasVideo: true, hasAudio: true })
    expect(result.limitations.join(' ')).toContain('audible speech')
  })
  it('detects a file growing while inspected', async () => {
    const result = await inspectRecording(movie, opts, async () => { await writeFile(movie, 'larger recording fixture'); return video() })
    expect(result.status).toBe('changing')
  })
  it('does not turn a missing or invalid duration into a successful check', async () => {
    for (const duration of ['N/A', '-1', '0', 'Infinity']) {
      const result = await inspectRecording(movie, opts, async () => ({ format: { duration } }))
      expect(result.durationSeconds).toBeUndefined()
      expect(result.status).toBe('incomplete_metadata')
    }
  })
  it('flags missing, mismatched, duplicate and unreadable expected assets', async () => {
    const event = await receiveRecording(movie, opts)
    const audio = join(root, 'guest.m4a'); await writeFile(audio, 'audio')
    const result = await prepareHandoff(event.eventId, [
      { label: 'Guest video', kind: 'video' },
      { label: 'Another guest video', kind: 'video', path: audio },
      { label: 'Host separate video', kind: 'video', path: movie },
      { label: 'Missing audio', kind: 'audio', path: join(root, 'missing.m4a') },
    ], opts, async path => path.endsWith('.m4a') ? { streams: [{ codec_type: 'audio' }], format: { duration: '12' } } : video())
    expect(result.assets.map(a => a.status)).toEqual(['needs_file', 'needs_check', 'duplicate_file', 'unavailable'])
    expect(result.assessment).toBe('needs_attention')
  })
  it('checks provided assets but never infers all tracks exist', async () => {
    const event = await receiveRecording(movie, opts)
    const audio = join(root, 'guest.m4a'); await writeFile(audio, 'audio')
    const result = await prepareHandoff(event.eventId, [{ label: 'Guest audio', kind: 'audio', path: audio }], opts, video)
    expect(result.assessment).toBe('listed_media_metadata_checked')
    expect(result.limitations.join(' ')).toContain('No separate-track (ISO) matching')
  })
  it('reports a program without audio as needing attention', async () => {
    const event = await receiveRecording(movie, opts)
    const result = await prepareHandoff(event.eventId, [], opts, async () => ({ streams: [{ codec_type: 'video' }], format: { duration: '2' } }))
    expect(result.assessment).toBe('needs_attention')
  })
  it('rejects event path traversal', async () => { await expect(prepareHandoff('../../private', [], opts, video)).rejects.toThrow('Invalid') })
  it('explains a missing media inspector', async () => { await expect(mediaProbe('/missing/ffprobe')(movie)).rejects.toThrow('requires ffprobe') })
})

describe('marker files, from the layout a real Ecamm 4.6.2 wrote', () => {
  const fixture = () => readFile(join(__dirname, 'fixtures', 'ecamm-markers-4.6.2.txt'), 'utf8')

  it('parses time, tab, text, and a marker with no text', async () => {
    const parsed = parseMarkerFile(await fixture())
    expect(parsed.format).toBe('ecamm-markers-v1')
    expect(parsed.markers).toEqual([
      { seconds: 0, timecode: '00:00:00', text: 'Start' },
      { seconds: 54, timecode: '00:00:54', text: '' },
      { seconds: 72, timecode: '00:01:12', text: 'segment two' },
    ])
  })
  it('keeps tabs and unicode inside marker text, and tolerates CRLF', () => {
    const parsed = parseMarkerFile('00:00:00\tStart\r\n01:02:03\tRenée\tQ&A ✓\r\n')
    expect(parsed.markers[1]).toEqual({ seconds: 3723, timecode: '01:02:03', text: 'Renée\tQ&A ✓' })
  })
  it('calls any other layout unrecognized instead of half-reading it', () => {
    for (const text of ['', 'Start at 0:00\n', '00:00:00 Start\n', '0:00\tStart\n', '00:00:00\tStart\nnot a marker\n', '{"markers":[]}']) {
      expect(parseMarkerFile(text).format).toBe('unrecognized')
    }
    expect(parseMarkerFile('00:00:00\tStart\nnot a marker\n').unparsed).toEqual(['not a marker'])
  })
  it('reads a marker file only inside the recording folder, and only a .txt', async () => {
    const markers = join(root, 'Interview Renée $(do not run).txt')
    await writeFile(markers, await fixture())
    const read = await readMarkers(markers, opts)
    expect(read.markers).toHaveLength(3)
    expect(read.chapterLines).toEqual(['00:00 Start', '01:12 segment two'])
    expect(read.limitations.join(' ')).toMatch(/pause/)
    await expect(readMarkers(movie, opts)).rejects.toThrow('.txt')
    const outside = join(directory, 'elsewhere.txt'); await writeFile(outside, await fixture())
    await expect(readMarkers(outside, opts)).rejects.toThrow('outside')
  })
  it('attaches sidecars only on an exact name match beside the recording', async () => {
    expect(await sidecarsOf(movie, opts)).toEqual({ problems: [] })
    await writeFile(join(root, 'Interview Renée $(do not run).txt'), await fixture())
    await writeFile(join(root, 'Interview Renée $(do not run).srt'), '1\n00:00:43,000 --> 00:00:48,000\n@ExampleViewer: test\n\n')
    await writeFile(join(root, 'Interview Renée $(do not run) 2.txt'), await fixture()) // near miss: must not attach
    const found = await sidecarsOf(movie, opts)
    expect(found.markers?.markers).toHaveLength(3)
    expect(found.comments?.path).toContain('.srt')
  })
})
