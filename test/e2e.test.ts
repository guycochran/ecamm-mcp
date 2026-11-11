import jpeg from 'jpeg-js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.js'
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
    args: [process.env.ECAMM_MCP_ENTRY ?? join(__dirname, '..', 'dist', 'index.js')],
    env: { ...process.env, HOME: home, ECAMM_HOST: `127.0.0.1:${fake.port}`, ECAMM_TRANSITION_TIMEOUT_S: '9' } as Record<string, string>,
  })
  client = new Client({ name: 'test', version: '1' })
  await client.connect(transport)
  close = () => { void client.close(); fake.server.close() }
})
afterAll(() => close?.())

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
    expect(r.json.general.ButtonLabel).toBe('New')
    expect(r.json.audio.mic.volume).toBe('100')
    const h = state.log[0].headers
    expect(h['ecammlive-uuid']).toMatch(/[0-9A-F-]{36}/)
    expect(h['ecammlive-clientname']).toBe('Claude (ecamm-mcp)')
    expect(h['user-agent']).toBe(`Claude (ecamm-mcp)/${VERSION}`)
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

  it('updates existing overlay text without changing visibility and encodes Unicode', async () => {
    const before = state.overlays['S-ME']['O-LT'].visible
    const value = 'Renée & Guy\nEcamm Fam + Q&A'
    const r = await call('ecamm_set_overlay_text', { overlay: 'lower third', text: value })
    expect(r.isError).toBeFalsy()
    expect(r.json).toMatchObject({ accepted: true, verified: false, text: value })
    expect(state.overlays['S-ME']['O-LT']).toMatchObject({ text: value, visible: before })
    const missing = await call('ecamm_set_overlay_text', { overlay: 'missing overlay', text: value })
    expect(missing.isError).toBe(true)
  }, 15000)

  it('verifies overlay text when Ecamm lists the overlay under its new text', async () => {
    await call('ecamm_switch_scene', { scene: 'Me w/comment' })
    const r = await call('ecamm_set_overlay_text', { overlay: 'Live', text: 'Renée ✓' })
    expect(r.json).toMatchObject({ accepted: true, verified: true, text: 'Renée ✓' })
    await call('ecamm_set_overlay_text', { overlay: 'Renée ✓', text: 'Live' })
    await call('ecamm_switch_scene', { scene: 'Me (full)' })
  }, 15000)

  describe('going live, recording and ending by intent', () => {
    const clicks = () => state.log.filter((l) => l.path === 'setClickButton').length
    const idle = () => {
      state.live = false
      state.busyUntil = 0
      state.buttonLabel = undefined
      state.recordOnly = false
      state.clickLagMs = undefined
      state.busyMs = 300
      state.failNextClick = false
      state.stuckBusy = false
    }

    it('never clicks without an intent, even with confirm', async () => {
      idle()
      const before = clicks()
      const r = await call('ecamm_start_stop', { confirm: true })
      expect(clicks()).toBe(before)
      expect(r.json).toMatchObject({ changed: false, needsIntent: true, mainButton: 'New', state: 'idle' })
    })

    it('go_live is a dry run without confirm, then verifies it is on air', async () => {
      idle()
      const dry = await call('ecamm_start_stop', { intent: 'go_live', destination: 'youtube' })
      expect(dry.json).toMatchObject({ dryRun: true, wouldDo: 'Go live (click "New")', destination: 'OHG YouTube' })
      expect(state.live).toBe(false)
      const ok = await call('ecamm_start_stop', { intent: 'go_live', destination: 'youtube', title: 'Office Hours', confirm: true })
      expect(ok.json).toMatchObject({ intent: 'go_live', clicked: 'New', outcome: 'verified', state: 'on-air', mainButton: 'Finish' })
      const sent = state.log.filter((l) => l.path === 'setClickButton').at(-1)!
      expect(sent.query).toMatchObject({ channel: 'CH-YT', title: 'Office Hours' })
    }, 20000)

    it('a repeated go_live does not end the broadcast', async () => {
      expect(state.live).toBe(true)
      const before = clicks()
      const again = await call('ecamm_start_stop', { intent: 'go_live', confirm: true })
      expect(clicks()).toBe(before)
      expect(state.live).toBe(true)
      expect(again.json).toMatchObject({ changed: false, alreadyInRequestedState: true, state: 'on-air' })
    }, 20000)

    it('end verifies it is off air, and a repeated end does nothing', async () => {
      const r = await call('ecamm_start_stop', { intent: 'end', confirm: true })
      expect(r.json).toMatchObject({ intent: 'end', clicked: 'Finish', outcome: 'verified', state: 'idle' })
      expect(state.live).toBe(false)
      const before = clicks()
      const again = await call('ecamm_start_stop', { intent: 'end', confirm: true })
      expect(clicks()).toBe(before)
      expect(again.json).toMatchObject({ changed: false, alreadyInRequestedState: true })
    }, 20000)

    it('refuses go_live in Record Only mode and record in broadcast mode', async () => {
      idle()
      state.recordOnly = true
      const before = clicks()
      const live = await call('ecamm_start_stop', { intent: 'go_live', confirm: true })
      expect(live.json).toMatchObject({ changed: false, alreadyInRequestedState: false })
      expect(live.json.note).toContain('Record Only')
      state.recordOnly = false
      const rec = await call('ecamm_start_stop', { intent: 'record', confirm: true })
      expect(rec.json.note).toContain('set to broadcast')
      expect(clicks()).toBe(before)
    }, 20000)

    it('record starts a recording in Record Only mode', async () => {
      idle()
      state.recordOnly = true
      const r = await call('ecamm_start_stop', { intent: 'record', confirm: true })
      expect(r.json).toMatchObject({ clicked: 'Record', outcome: 'verified', state: 'on-air' })
      await call('ecamm_start_stop', { intent: 'end', confirm: true })
      idle()
    }, 20000)

    it.each([
      ['starting or ending', () => { state.busyUntil = Date.now() + 60000 }, 'starting or ending'],
      ['the end-of-broadcast summary', () => { state.buttonLabel = 'OK' }, 'summary'],
      ['a label it cannot read', () => { state.buttonLabel = 'Aufnehmen' }, 'does not recognize'],
      ['no label at all', () => { state.buttonLabel = '' }, 'did not report'],
    ])('does not click during %s', async (_n, arrange, reason) => {
      idle()
      arrange()
      const before = clicks()
      const r = await call('ecamm_start_stop', { intent: 'go_live', confirm: true })
      expect(clicks()).toBe(before)
      expect(r.json.changed).toBe(false)
      expect(r.json.note).toContain(reason)
      idle()
    }, 20000)

    it('waits out a late transition: the label holds, then Wait, then Finish', async () => {
      idle()
      state.clickLagMs = 2500
      state.busyMs = 2500
      const r = await call('ecamm_start_stop', { intent: 'go_live', confirm: true })
      expect(r.json).toMatchObject({ outcome: 'verified', state: 'on-air' })
      await call('ecamm_start_stop', { intent: 'end', confirm: true })
      idle()
    }, 40000)

    it('reports a start that fails instead of calling "no longer Wait" success', async () => {
      idle()
      state.failNextClick = true
      state.busyMs = 2500
      const r = await call('ecamm_start_stop', { intent: 'go_live', confirm: true })
      expect(r.json).toMatchObject({ outcome: 'failed', state: 'idle' })
      expect(state.live).toBe(false)
      idle()
    }, 40000)

    it('reports unknown, with a warning not to repeat blindly, when Ecamm never settles', async () => {
      idle()
      state.stuckBusy = true
      const r = await call('ecamm_start_stop', { intent: 'go_live', confirm: true })
      expect(r.json).toMatchObject({ outcome: 'unknown', state: 'busy' })
      expect(r.json.doNotRepeatBlindly).toBeTruthy()
      expect(state.live).toBe(true) // the command WAS applied; only the confirmation timed out
      idle()
    }, 40000)
  })

  describe('one change at a time', () => {
    it('two simultaneous mute requests toggle once and both report muted', async () => {
      state.mute.mic = false
      const before = state.log.filter((l) => l.path === 'setMute').length
      const [a, b] = await Promise.all([
        call('ecamm_set_mute', { bus: 'mic', muted: true }),
        call('ecamm_set_mute', { bus: 'mic', muted: true }),
      ])
      expect(state.log.filter((l) => l.path === 'setMute').length).toBe(before + 1)
      expect(state.mute.mic).toBe(true)
      expect(a.json.nowMuted).toBe(true)
      expect(b.json.nowMuted).toBe(true)
      await call('ecamm_set_mute', { bus: 'mic', muted: false })
    }, 20000)

    it('an overlay request queued behind a scene change acts on the new scene, not the old one', async () => {
      await call('ecamm_switch_scene', { scene: 'Me (full)' })
      const logo = () => state.overlays['S-ME']['O-LOGO'].visible
      const wasVisible = logo()
      const [sw, ov] = await Promise.all([
        call('ecamm_switch_scene', { scene: 'Me + Guest Half' }),
        call('ecamm_set_overlay', { overlay: 'OHG Logo', state: 'hide' }),
      ])
      expect(sw.json.confirmed).toBe(true)
      expect(ov.isError).toBe(true) // that overlay is not in the scene now on screen
      expect(logo()).toBe(wasVisible) // and the old scene's overlay was not toggled blind
      await call('ecamm_switch_scene', { scene: 'Me (full)' })
    }, 20000)

    it('a failed command does not block the ones queued behind it', async () => {
      const [bad, good] = await Promise.all([
        call('ecamm_set_overlay', { overlay: 'No Such Overlay', state: 'show' }),
        call('ecamm_set_volume', { bus: 'mic', volume: 80 }),
      ])
      expect(bad.isError).toBe(true)
      expect(good.isError).toBeFalsy()
      expect(state.volume.mic).toBe(80)
      await call('ecamm_set_volume', { bus: 'mic', volume: 100 })
    }, 20000)

    it('reads are not held up by a long-running change', async () => {
      state.live = false; state.busyUntil = 0; state.buttonLabel = undefined; state.recordOnly = false
      state.clickLagMs = undefined; state.busyMs = 3000
      const going = call('ecamm_start_stop', { intent: 'go_live', confirm: true })
      await new Promise((r) => setTimeout(r, 300))
      const t = Date.now()
      const scenes = await call('ecamm_list_scenes')
      expect(Date.now() - t).toBeLessThan(1500)
      expect(scenes.isError).toBeFalsy()
      await going
      await call('ecamm_start_stop', { intent: 'end', confirm: true })
      state.busyMs = 300
    }, 40000)

    it('accepts the bare-word acknowledgement a real Ecamm is reported to send', async () => {
      state.bareAcks = true
      const r = await call('ecamm_set_volume', { bus: 'mic', volume: 90 })
      state.bareAcks = false
      expect(r.isError).toBeFalsy()
      expect(state.volume.mic).toBe(90)
      await call('ecamm_set_volume', { bus: 'mic', volume: 100 })
    })
  })

  it('pause and resume say where to end up, so repeating one does nothing', async () => {
    state.paused = false
    const count = () => state.log.filter((l) => l.path === 'setClickPause').length
    const p = await call('ecamm_recording', { action: 'pause', confirm: true })
    expect(p.json).toMatchObject({ clicked: 'Pause', pauseButtonNowSays: 'Resume', verified: true })
    const before = count()
    const again = await call('ecamm_recording', { action: 'pause', confirm: true })
    expect(count()).toBe(before)
    expect(again.json).toMatchObject({ changed: false, alreadyInRequestedState: true })
    const r = await call('ecamm_recording', { action: 'resume', confirm: true })
    expect(r.json.pauseButtonNowSays).toBe('Pause')
    expect(state.paused).toBe(false)
  }, 20000)


  it('encodes spaces as %20 (Ecamm does not decode +)', async () => {
    await call('ecamm_post_comment', { text: 'hello office hours', confirm: true })
    expect(state.comments).toContain('hello office hours')
    const marker = await call('ecamm_add_marker', { text: 'Q&A start' })
    expect(marker.json).toMatchObject({ accepted: true, verified: false })
    expect(state.markers).toContain('Q&A start')
    expect(state.log.find((l) => l.path === 'setAddMarker')?.query).toEqual({ text: 'Q&A start', dialogbox: 'false' })
  })

  it('uses the documented pause command and reads back the changed label', async () => {
    const r = await call('ecamm_recording', { action: 'pause_resume', confirm: true })
    expect(r.isError).toBeFalsy()
    expect(state.paused).toBe(true)
    expect(r.json.pauseButtonNowSays).toBe('Resume')
  })

  it('maps both system audio spellings to the HTTP bus for mute and volume', async () => {
    for (const bus of ['system audio', 'systemaudio']) {
      expect((await call('ecamm_set_mute', { bus, muted: true })).isError).toBeFalsy()
      expect((await call('ecamm_set_volume', { bus, volume: 42 })).isError).toBeFalsy()
    }
    expect(state.mute.systemaudio).toBe(true)
    expect(state.volume.systemaudio).toBe(42)
    expect(state.log.some((l) => l.query.bus === 'system audio')).toBe(false)
  })

  it('maps the Zoom share alias to the HTTP sharing panel', async () => {
    const r = await call('ecamm_zoom', { action: 'panel', panel: 'share' })
    expect(r.isError).toBeFalsy()
    expect(state.zoomPanel).toBe('sharing')
  })

  it('drops placeholder rows', async () => {
    expect((await call('ecamm_list', { what: 'videos' })).json).toEqual([])
  })

  it('returns thumbnails as images', async () => {
    const r = await call('ecamm_thumbnail', { kind: 'scene', ref: 'Me (full)' })
    expect(r.raw.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    expect(r.raw.content[0].data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  })

  it('warns when a thumbnail is for a scene that is not on screen', async () => {
    const r = await call('ecamm_thumbnail', { kind: 'scene', ref: 'Speaker Stage' })
    expect(r.raw.content[0]).toMatchObject({ type: 'image' })
    expect(r.raw.content[1].text).toContain('may be out of date')
    const cur = await call('ecamm_thumbnail', { kind: 'scene', ref: 'Me (full)' })
    expect(cur.raw.content).toHaveLength(1)
  })

  describe('scene sheet', () => {
    const sheet = async (args: { refresh?: boolean } = {}) => {
      const r = await call(args.refresh ? 'ecamm_refresh_scene_sheet' : 'ecamm_scene_sheet')
      return { r, meta: JSON.parse(r.raw.content[1].text!) }
    }
    const switches = () => state.log.filter((l) => l.path === 'setScene').length
    const reset = async () => {
      state.live = false
      state.busyUntil = 0
      state.buttonLabel = undefined
      state.onSetScene = undefined
      state.ignoreSceneId = undefined
      await client.callTool({ name: 'ecamm_switch_scene', arguments: { scene: 'Me (full)' } })
      state.redrawn = { 'S-ME': true }
    }
    const byScene = (meta: { scenes: { scene: string; thumbnail: string }[] }) =>
      Object.fromEntries(meta.scenes.map((s) => [s.scene, s.thumbnail]))

    it('changes nothing by default and says which pictures may be old', async () => {
      await reset()
      const before = switches()
      const { r, meta } = await sheet()
      expect(switches()).toBe(before)
      expect(r.raw.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
      expect(meta.changedEcamm).toBe(false)
      expect(byScene(meta)).toEqual({
        'Me (full)': 'on-screen', 'Guests / Me + Guest Half': 'stored', 'Guests / Speaker Stage': 'stored', 'Me w/comment': 'stored',
      })
      expect(meta.scenes.map((s: { number: number }) => s.number)).toEqual([1, 2, 3, 4])
    })

    it('refresh visits every scene, verifies the return, and yields one picture', async () => {
      await reset()
      const { r, meta } = await sheet({ refresh: true })
      const img = jpeg.decode(Buffer.from((r.raw.content[0] as { data: string }).data, 'base64'))
      expect(img.width).toBeGreaterThan(500)
      expect(img.height).toBeGreaterThan(4 * 200)
      expect(meta).toMatchObject({ changedEcamm: true, returnToStartingScene: 'verified', startedOn: 'Me (full)', onScreenNow: 'Me (full)' })
      expect(byScene(meta)).toEqual({
        'Me (full)': 'on-screen', 'Guests / Me + Guest Half': 'refreshed', 'Guests / Speaker Stage': 'refreshed', 'Me w/comment': 'refreshed',
      })
      expect(state.scene).toBe('S-ME')
    }, 30000)

    it.each([
      ['live', () => { state.live = true }, 'live or recording'],
      ['starting or ending', () => { state.busyUntil = Date.now() + 60000 }, 'starting or ending'],
      ['an unreadable button label', () => { state.buttonLabel = 'Aufnehmen' }, 'Aufnehmen'],
    ])('refuses to refresh while %s', async (_name, arrange, reason) => {
      await reset()
      arrange()
      const before = switches()
      const { meta } = await sheet({ refresh: true })
      expect(switches()).toBe(before)
      expect(meta.changedEcamm).toBe(false)
      expect(meta.refreshRefused).toContain(reason)
      await reset()
    }, 20000)

    it('stops without restoring when someone else changes the scene mid-capture', async () => {
      await reset()
      let n = 0
      state.onSetScene = () => { if (++n === 2) setTimeout(() => { state.scene = 'S-COMMENT' }, 200) }
      const { meta } = await sheet({ refresh: true })
      state.onSetScene = undefined
      expect(meta.stoppedEarly).toContain('changed by someone else')
      expect(meta.returnToStartingScene).toBe('skipped')
      expect(state.scene).toBe('S-COMMENT') // their choice stands
      expect(meta.onScreenNow).toBe('Me w/comment')
      expect(byScene(meta)['Me (full)']).toBe('refreshed') // was on screen when this began
    }, 30000)

    it('stops without restoring when a broadcast starts mid-capture', async () => {
      await reset()
      let n = 0
      state.onSetScene = () => { if (++n === 1) state.live = true }
      const { meta } = await sheet({ refresh: true })
      state.onSetScene = undefined
      const landedOn = state.scene
      state.live = false
      expect(meta.stoppedEarly).toContain('on-air')
      expect(meta.returnToStartingScene).toBe('skipped')
      expect(landedOn).not.toBe('S-ME')
    }, 30000)

    it('reports a failed return instead of claiming it', async () => {
      await reset()
      state.ignoreSceneId = 'S-ME'
      const { meta } = await sheet({ refresh: true })
      state.ignoreSceneId = undefined
      expect(meta.returnToStartingScene).toBe('failed')
      expect(meta.onScreenNow).not.toBe('Me (full)')
      await reset()
    }, 30000)
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
