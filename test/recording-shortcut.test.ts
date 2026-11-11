import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { recordingShortcut } from '../src/recording-shortcut.js'

const run = promisify(execFile)
const entry = process.env.ECAMM_MCP_ENTRY ?? join(__dirname, '..', 'dist', 'index.js')
let temp: string
async function fixture() {
  temp = await mkdtemp(join(tmpdir(), 'ecamm-shortcut-'))
  const root = join(temp, "Renée's $(touch SHOULD_NOT_EXIST) `false` recordings")
  await mkdir(root)
  return { roots: [root], inbox: join(temp, "inbox's space"), ffprobe: '/missing/ffprobe' }
}
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }) })

describe('recording Shortcut generation', () => {
  it('round-trips hostile fixed paths and stdin through a real shell without ffprobe or an MCP session', async () => {
    const opts = await fixture()
    const media = join(opts.roots[0], "Guest's $(touch INJECTED) `false`.mov")
    await writeFile(media, 'original')
    const helper = join(temp, 'complete.sh')
    await writeFile(helper, await recordingShortcut(opts, process.execPath, entry))
    const execute = () => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn('/bin/sh', [helper], { cwd: temp, env: { ...process.env, ECAMM_RECORDING_ROOTS: '["/wrong"]', ECAMM_RECORDING_INBOX: '/wrong' } })
      let out = '', err = ''
      child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b)
      child.on('error', reject); child.on('close', code => resolve({ code, out, err }))
      child.stdin.on('error', () => {}); child.stdin.end(media + '\n')
    })
    const first = await execute()
    expect(first.err).toBe(''); expect(first.code).toBe(0)
    const event = JSON.parse(first.out)
    expect(event.duplicate).toBe(false)
    expect(JSON.parse((await execute()).out).duplicate).toBe(true)
    const saved = JSON.parse(await readFile(join(opts.inbox, event.eventId + '.json'), 'utf8'))
    expect(saved.path).toBe(await realpath(media))
    expect(await readFile(media, 'utf8')).toBe('original')
    await expect(readFile(join(temp, 'INJECTED'))).rejects.toThrow()
    await expect(readFile(join(temp, 'SHOULD_NOT_EXIST'))).rejects.toThrow()
  })
  it('CLI emits the helper and nothing else on stdout', async () => {
    const opts = await fixture()
    const result = await run(process.execPath, [entry, 'recording-shortcut'], { env: { ...process.env, ECAMM_RECORDING_ROOTS: JSON.stringify(opts.roots), ECAMM_RECORDING_INBOX: opts.inbox, ECAMM_FFPROBE: opts.ffprobe } })
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(await recordingShortcut(opts, process.execPath, entry))
    await expect(readFile(opts.inbox)).rejects.toThrow()
  })
  it('refuses missing roots, nonfolders, and relative inboxes without emitting a usable script', async () => {
    const opts = await fixture()
    await expect(recordingShortcut({ ...opts, roots: [] }, process.execPath, entry)).rejects.toThrow('recording folder')
    const file = join(temp, 'file'); await writeFile(file, '')
    await expect(recordingShortcut({ ...opts, roots: [file] }, process.execPath, entry)).rejects.toThrow('not a directory')
    await expect(recordingShortcut({ ...opts, inbox: 'relative' }, process.execPath, entry)).rejects.toThrow('absolute')
    await expect(recordingShortcut({ ...opts, ffprobe: 'bad\0path' }, process.execPath, entry)).rejects.toThrow('NUL')
  })
})
