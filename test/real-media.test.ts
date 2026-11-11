import { execFile } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectRecording, prepareHandoff, receiveRecording, recordingDoctor, type RecordingOptions } from '../src/recordings.js'

// Optional locally, required in the dedicated CI job. No user recordings are opened.
const ffmpeg = process.env.ECAMM_TEST_FFMPEG
const ffprobe = process.env.ECAMM_TEST_FFPROBE
const execute = promisify(execFile)

describe.runIf(Boolean(ffmpeg && ffprobe))('real media inspection', () => {
  let directory: string, program: string, silent: string, audio: string, artwork: string, hevc: string
  let opts: RecordingOptions
  const generate = async (args: string[], output: string) => {
    await execute(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', ...args, output], { timeout: 30000, maxBuffer: 1024 * 1024 })
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ecamm-real-media-'))
    opts = { roots: [directory], inbox: join(directory, 'events'), ffprobe: ffprobe! }
    program = join(directory, 'Interview Renée & guest.mp4')
    silent = join(directory, 'video-only.mp4')
    audio = join(directory, 'guest.m4a')
    artwork = join(directory, 'audio-with-artwork.m4a')
    hevc = join(directory, 'camera-hevc.mov')
    await generate(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'], program)
    await generate(['-i', program, '-map', '0:v:0', '-c', 'copy'], silent)
    await generate(['-i', program, '-map', '0:a:0', '-c', 'copy'], audio)
    await generate(['-i', program, '-c:v', 'libx265', '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-tag:v', 'hvc1', '-c:a', 'copy'], hevc)
    await generate(['-i', audio, '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-map', '0:a:0', '-map', '1:v:0', '-c:a', 'copy', '-c:v', 'mjpeg', '-frames:v', '1', '-disposition:v:0', 'attached_pic'], artwork)
  }, 90000)
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

  it('recognizes the actual inspector and a generated H.264/AAC recording', async () => {
    expect((await recordingDoctor(opts)).metadataInspectionConfigured).toBe(true)
    const result = await inspectRecording(program, opts)
    expect(result).toMatchObject({ status: 'metadata_read', hasVideo: true, hasAudio: true })
    expect(result.durationSeconds).toBeCloseTo(2, 1)
    expect(result.streams.find(s => s.codec_type === 'video')).toMatchObject({ width: 160, height: 90 })
  })
  it('flags a real program recording with no audio stream', async () => {
    const event = await receiveRecording(silent, opts)
    const result = await prepareHandoff(event.eventId, [], opts)
    expect(result.main.hasAudio).toBe(false)
    expect(result.assessment).toBe('needs_attention')
  })
  it('reads H.265 MOV media used by separate-camera recording workflows', async () => {
    const result = await inspectRecording(hevc, opts)
    expect(result).toMatchObject({ status: 'metadata_read', hasVideo: true, hasAudio: true })
    expect(result.streams.find(s => s.codec_type === 'video')?.codec_name).toBe('hevc')
  })
  it('handles real audio-only media and attached cover art correctly', async () => {
    expect(await inspectRecording(audio, opts)).toMatchObject({ hasAudio: true, hasVideo: false })
    const result = await inspectRecording(artwork, opts)
    expect(result.streams.some(s => s.disposition?.attached_pic === 1)).toBe(true)
    expect(result).toMatchObject({ hasAudio: true, hasVideo: false })
  })
  it('flags damaged media even when ffprobe returns exit code zero', async () => {
    const damaged = join(directory, 'truncated.mp4')
    await writeFile(damaged, (await readFile(program)).subarray(0, 48))
    // Some ffprobe versions reject this outright; others return an empty MP4 container.
    try {
      const inspection = await inspectRecording(damaged, opts)
      expect(inspection.status).toBe('incomplete_metadata')
      const event = await receiveRecording(damaged, opts)
      expect((await prepareHandoff(event.eventId, [], opts)).assessment).toBe('needs_attention')
    } catch (err) {
      expect(String(err)).toContain('Media inspection failed')
    }
  })
  it('builds a receipt from actual main and audio files without altering originals', async () => {
    const before = await readFile(program)
    const event = await receiveRecording(program, opts)
    const receipt = await prepareHandoff(event.eventId, [{ label: 'Guest audio', kind: 'audio', path: audio }], opts)
    expect(receipt.assessment).toBe('listed_media_metadata_checked')
    expect(await readFile(program)).toEqual(before)
  })
  it('inspects actual media through the running MCP server in read-only mode', async () => {
    const client = new Client({ name: 'real-media-test', version: '1' })
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [process.env.ECAMM_MCP_ENTRY ?? join(__dirname, '..', 'dist', 'index.js')],
        env: { ...process.env, ECAMM_RECORDING_ROOTS: '', ECAMM_RECORDING_FOLDER: directory,
          ECAMM_FFPROBE: ffprobe!, ECAMM_READ_ONLY: '1' } as Record<string, string>,
      }))
      const response = await client.callTool({ name: 'ecamm_inspect_recording', arguments: { path: hevc } })
      expect(response.isError).not.toBe(true)
      const data = JSON.parse((response.content as { text: string }[])[0].text)
      expect(data).toMatchObject({ status: 'metadata_read', hasAudio: true, hasVideo: true })
      expect(data.streams.some((s: { codec_name: string }) => s.codec_name === 'hevc')).toBe(true)
    } finally { await client.close() }
  })
})
