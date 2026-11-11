import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowedRecording, inspectRecording, listRecordings, mediaProbe, prepareHandoff, receiveRecording, recordingOptions, type RecordingOptions } from '../src/recordings.js'

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
      expect((await inspectRecording(movie, opts, async () => ({ format: { duration } }))).durationSeconds).toBeUndefined()
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
    expect(result.limitations.join(' ')).toContain('No automatic ISO or marker matching')
  })
  it('reports a program without audio as needing attention', async () => {
    const event = await receiveRecording(movie, opts)
    const result = await prepareHandoff(event.eventId, [], opts, async () => ({ streams: [{ codec_type: 'video' }], format: { duration: '2' } }))
    expect(result.assessment).toBe('needs_attention')
  })
  it('rejects event path traversal', async () => { await expect(prepareHandoff('../../private', [], opts, video)).rejects.toThrow('Invalid') })
  it('explains a missing media inspector', async () => { await expect(mediaProbe('/missing/ffprobe')(movie)).rejects.toThrow('requires ffprobe') })
})
