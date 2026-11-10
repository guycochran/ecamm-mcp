import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFake, type FakeState } from './fake-ecamm.js'

let client: Client
let state: FakeState
let close: () => void

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean }
  const t = r.content[0]
  return { raw: r, json: t.type === 'text' ? safeParse(t.text!) : t, isError: r.isError }
}
const safeParse = (s: string) => { try { return JSON.parse(s) } catch { return s } }

beforeAll(async () => {
  const fake = await startFake()
  state = fake.state
  const home = mkdtempSync(join(tmpdir(), 'ecamm-home-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(__dirname, '..', 'dist', 'index.js')],
    env: { ...process.env, HOME: home, ECAMM_HOST: `127.0.0.1:${fake.port}` } as Record<string, string>,
  })
  client = new Client({ name: 'test', version: '1' })
  await client.connect(transport)
  close = () => { void client.close(); fake.server.close() }
})
afterAll(() => close())

describe('ecamm-mcp end to end', () => {
  it('lists the expected tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThanOrEqual(20)
    expect(tools.map((t) => t.name)).toContain('ecamm_switch_scene')
  })

  it('registers, sends required headers, and reports status', async () => {
    const r = await call('ecamm_status')
    expect(r.isError).toBeFalsy()
    expect(r.json.currentScene.title).toBe('Me (full)')
    expect(r.json.general.ButtonLabel).toBe('Go Live')
    expect(r.json.audio.mic.volume).toBe('100')
    const h = state.log[0].headers
    expect(h['ecammlive-uuid']).toMatch(/[0-9A-F-]{36}/)
    expect(h['ecammlive-clientname']).toBe('Claude (ecamm-mcp)')
    expect(h['user-agent']).toMatch(/^Claude \(ecamm-mcp\)\/\d+\.\d+\.\d+$/)
  })

  it('preflight passes a healthy setup and flags a muted mic', async () => {
    let r = await call('ecamm_preflight')
    expect(r.json.ready).toBe(true)
    expect(r.json.checks.find((c: { check: string }) => c.check === 'Destinations').detail).toContain('OHG YouTube')
    state.mute.mic = true
    r = await call('ecamm_preflight')
    expect(r.json.ready).toBe(false)
    expect(r.json.summary).toContain('Mic')
    state.mute.mic = false
  })

  it('flattens scene groups and resolves by partial name', async () => {
    const list = (await call('ecamm_list_scenes')).json
    expect(list.map((s: { title: string }) => s.title)).toEqual(['Me (full)', 'Me + Guest Half', 'Speaker Stage', 'Me w/comment'])
    expect(list[1].group).toBe('Guests')
    const r = await call('ecamm_switch_scene', { scene: 'speaker' })
    expect(r.json).toMatchObject({ switchedTo: 'Guests / Speaker Stage', confirmed: true })
    expect(state.scene).toBe('S-STAGE')
  })

  it('refuses ambiguous names', async () => {
    const r = await call('ecamm_switch_scene', { scene: 'me' })
    expect(r.isError).toBe(true)
    expect(r.json).toMatch(/matches 3 scenes/)
  })

  it('show/hide overlay is idempotent over a toggle API', async () => {
    await call('ecamm_switch_scene', { scene: 'Me (full)' })
    let r = await call('ecamm_set_overlay', { overlay: 'logo', state: 'show' })
    expect(r.json).toMatchObject({ wasVisible: true, nowVisible: true })
    r = await call('ecamm_set_overlay', { overlay: 'lower third', state: 'show' })
    expect(r.json).toMatchObject({ wasVisible: false, nowVisible: true })
    r = await call('ecamm_set_overlay', { overlay: 'lower third', state: 'show' })
    expect(r.json.nowVisible).toBe(true)
    expect(state.overlays['S-ME']['O-LT'].visible).toBe(true)
  })

  it('mute is idempotent, per bus', async () => {
    await call('ecamm_set_mute', { muted: true, bus: 'mic' })
    await call('ecamm_set_mute', { muted: true, bus: 'mic' })
    expect(state.mute.mic).toBe(true)
    expect(state.mute.main).toBe(false)
    const r = await call('ecamm_set_mute', { muted: false, bus: 'mic' })
    expect(r.json).toMatchObject({ wasMuted: true, nowMuted: false })
  })

  it('go live is a dry run without confirm', async () => {
    const r = await call('ecamm_start_stop', { destination: 'youtube' })
    expect(r.json).toMatchObject({ dryRun: true, wouldDo: 'Click "Go Live"', destination: 'OHG YouTube' })
    expect(state.live).toBe(false)
    const ok = await call('ecamm_start_stop', { destination: 'youtube', title: 'Office Hours', confirm: true })
    expect(ok.json).toMatchObject({ clicked: 'Go Live', buttonNowSays: 'End Broadcast' })
    const sent = state.log.find((l) => l.path === 'setClickButton')!
    expect(sent.query).toMatchObject({ channel: 'CH-YT', title: 'Office Hours' })
  })

  it('encodes spaces as %20 (Ecamm does not decode +)', async () => {
    await call('ecamm_post_comment', { text: 'hello office hours', confirm: true })
    expect(state.comments).toContain('hello office hours')
    await call('ecamm_add_marker', { text: 'Q&A start' })
    expect(state.markers).toContain('Q&A start')
  })

  it('drops placeholder rows', async () => {
    expect((await call('ecamm_list', { what: 'videos' })).json).toEqual([])
  })

  it('returns thumbnails as images', async () => {
    const r = await call('ecamm_thumbnail', { kind: 'scene', ref: 'Me (full)' })
    expect(r.raw.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    expect(r.raw.content[0].data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  })

  it('waits for the source mode to land before reporting it', async () => {
    const r = await call('ecamm_set_source_mode', { mode: 'screen' })
    expect(r.json).toEqual({ mode: 'screen', confirmed: true })
  })

  it('zoom end_for_all needs confirm', async () => {
    const r = await call('ecamm_zoom', { action: 'end_for_all' })
    expect(r.json.dryRun).toBe(true)
    expect(state.log.some((l) => l.path === 'setZoomLeave')).toBe(false)
  })
})
