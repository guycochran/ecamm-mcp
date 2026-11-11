import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const entry = process.env.ECAMM_MCP_ENTRY ?? join(__dirname, '..', 'dist', 'index.js')
let directory: string, movie: string, env: Record<string, string>, client: Client
function complete(input: string, args: string[] = []) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'recording-complete', ...args], { env, stdio: 'pipe' })
    let out = '', err = ''
    child.stdout.on('data', b => { out += b }); child.stderr.on('data', b => { err += b })
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ecamm-recording-e2e-'))
  const root = join(directory, 'recordings'); await mkdir(root)
  movie = join(root, 'Renée $(never execute).mp4'); await writeFile(movie, 'test fixture')
  const probe = join(directory, 'probe')
  // A deterministic stand-in tests process arguments and MCP wiring, not real media decoding.
  await writeFile(probe, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('-protocol_whitelist') || !args.includes('-format_whitelist') || fs.readFileSync(args.at(-1), 'utf8') !== 'test fixture') process.exit(2);
console.log(JSON.stringify({streams:[{codec_type:'video'},{codec_type:'audio'}],format:{duration:'2.5'}}));\n`)
  await chmod(probe, 0o700)
  env = { ...process.env, ECAMM_RECORDING_FOLDER: root, ECAMM_RECORDING_ROOTS: '', ECAMM_RECORDING_INBOX: join(directory, 'inbox'), ECAMM_FFPROBE: probe, ECAMM_READ_ONLY: '1' } as Record<string, string>
  client = new Client({ name: 'recording-test', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }))
})
afterAll(async () => { await client?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

describe('completion helper and MCP integration without a running Ecamm', () => {
  it('round-trips stdin, durable events, metadata inspection and handoff in read-only mode', async () => {
    const completed = await complete(JSON.stringify({ path: movie }))
    expect(completed.code).toBe(0)
    const eventId = JSON.parse(completed.out).eventId
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args })
      expect(r.isError).not.toBe(true)
      return JSON.parse((r.content as { text: string }[])[0].text)
    }
    expect((await call('ecamm_list_recordings')).events[0].id).toBe(eventId)
    expect(await call('ecamm_inspect_recording', { path: movie })).toMatchObject({ durationSeconds: 2.5, hasAudio: true })
    expect(await call('ecamm_prepare_edit_handoff', { event_id: eventId, expected_assets: [{ label: 'Guest audio', kind: 'audio' }] })).toMatchObject({ assessment: 'needs_attention', assets: [{ status: 'needs_file' }] })
    expect(await readFile(movie, 'utf8')).toBe('test fixture')
    const again = await complete(movie + '\n', ['--path-stdin'])
    expect(again.code).toBe(0); expect(JSON.parse(again.out).duplicate).toBe(true)
  })
  it('rejects malformed, oversized, and unauthorized completion input', async () => {
    expect((await complete('{')).code).toBe(1)
    expect((await complete('x'.repeat(20000))).code).toBe(1)
    const outside = join(directory, 'outside.mp4'); await writeFile(outside, 'outside')
    expect((await complete(JSON.stringify({ path: outside }))).code).toBe(1)
  })
  it('returns a readable error without ffprobe output or file contents', async () => {
    const r = await client.callTool({ name: 'ecamm_inspect_recording', arguments: { path: '/outside-allowed-folder.mp4' } })
    expect(r.isError).toBe(true)
  })
})
