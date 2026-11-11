import { createServer, type IncomingMessage, type Server } from 'node:http'
import jpeg from 'jpeg-js'

/**
 * Minimal stand-in for Ecamm Live's Remote API, shaped like the real responses captured in
 * the Companion module fixtures: scalars wrapped in arrays, lists in {items}, "Done" for sets,
 * toggle-only commands, a ~400 ms scene switch, and the Not Found -> Pending -> Allowed flow.
 */
export interface FakeState {
  /** Scenes whose thumbnail Ecamm has redrawn since launch. The rest are stale. */
  redrawn: Record<string, boolean>
  busyUntil?: number
  mode?: string
  permission: 'Not Found' | 'Pending' | 'Allowed' | 'Denied'
  autoApprove: boolean
  scene: string
  mute: Record<string, boolean>
  volume: Record<string, number>
  overlays: Record<string, Record<string, { title: string; visible: boolean }>>
  live: boolean
  log: { path: string; query: Record<string, string>; headers: IncomingMessage['headers'] }[]
  comments: string[]
  markers: string[]
}

const SCENES = [
  { title: 'Me (full)', UUID: 'S-ME', Children: [], Locked: false },
  {
    title: 'Guests', UUID: 'G-1', Group: true,
    Children: [
      { title: 'Me + Guest Half', UUID: 'S-HALF', Children: [] },
      { title: 'Speaker Stage', UUID: 'S-STAGE', Children: [] },
    ],
  },
  { title: 'Me w/comment', UUID: 'S-COMMENT', Children: [] },
]

/** 96x96 letterboxed still: gray if stale, a per-scene color once redrawn, green outline while on screen. */
function sceneJpeg(id: string, state: FakeState): string {
  const n = 96
  const data = Buffer.alloc(n * n * 4)
  const hue = [...id].reduce((a, c) => a + c.charCodeAt(0), 0)
  const color = state.redrawn[id] ? [60 + (hue * 7) % 180, 60 + (hue * 13) % 180, 60 + (hue * 29) % 180] : [90, 90, 90]
  const current = state.scene === id
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4
      const bar = y < 21 || y >= 75
      const edge = !bar && current && (y < 25 || y >= 71 || x < 4 || x >= n - 4)
      const c = bar ? [0, 0, 0] : edge ? [100, 255, 80] : color
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255
    }
  }
  return Buffer.from(jpeg.encode({ data, width: n, height: n }, 85).data).toString('base64')
}

export function startFake(): Promise<{ server: Server; port: number; state: FakeState }> {
  const state: FakeState = {
    permission: 'Not Found',
    autoApprove: true,
    scene: 'S-ME',
    redrawn: { 'S-ME': true },
    mute: { main: false, mic: false, soundeffects: false },
    volume: { mic: 100, soundeffects: 59 },
    overlays: {
      'S-ME': { 'O-LT': { title: 'Lower Third Guy', visible: false }, 'O-LOGO': { title: 'OHG Logo', visible: true } },
      'S-HALF': { 'O-LT2': { title: 'Lower Third Guest', visible: false } },
    },
    live: false,
    log: [],
    comments: [],
    markers: [],
  }
  let pendingScene: string | undefined

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.slice(1)
    const q = Object.fromEntries(url.searchParams)
    state.log.push({ path, query: q, headers: req.headers })
    const json = (v: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(v))
    }
    const done = () => json(['Done'])

    if (!req.headers['ecammlive-uuid'] || !req.headers['ecammlive-clientname']) {
      res.writeHead(400); return res.end('missing headers')
    }
    if (path === 'getConnectionStatus') return json([state.permission])
    if (state.permission === 'Not Found') {
      state.permission = state.autoApprove ? 'Allowed' : 'Pending'
      return json({}) // unapproved getInfo answers {}
    }
    if (state.permission !== 'Allowed') return json({})

    const bus = q.bus ?? 'main'
    const ov = () => state.overlays[state.scene] ?? {}
    switch (path) {
      case 'getInfo':
        return json({
          ButtonLabel: state.busyUntil && Date.now() < state.busyUntil ? 'Wait' : state.live ? 'Finish' : 'New',
          PauseButtonLabel: 'None',
          CurrentScene: state.scene,
          Viewers: state.live ? '12' : '0',
          PreviewMode: 'no', HidingUI: 'no', LiveDemo: 'no',
          Mute: state.mute.main ? 'yes' : 'no',
          MUTE_MIC: state.mute.mic ? 'yes' : 'no',
          VOLUME_MIC: String(state.volume.mic),
          MUTE_SOUNDEFFECTS: state.mute.soundeffects ? 'yes' : 'no',
          VOLUME_SOUNDEFFECTS: String(state.volume.soundeffects),
        })
      case 'getSceneList': return json({ items: SCENES })
      case 'getCurrentScene': return json([state.scene])
      case 'setScene':
        pendingScene = q.id
        setTimeout(() => {
          if (!pendingScene) return
          state.scene = pendingScene
          const id = pendingScene
          // Like real Ecamm: the thumbnail is redrawn a moment after the scene goes on screen.
          setTimeout(() => { state.redrawn[id] = true }, 300)
        }, 400)
        return done()
      case 'getOverlayList':
        return json({ items: Object.entries(ov()).map(([UUID, o]) => ({ UUID, title: o.title, Visible: o.visible })) })
      case 'setOverlay': { const o = ov()[q.id]; if (o) o.visible = !o.visible; return done() }
      case 'getMute': return json([state.mute[bus] ? 'yes' : 'no'])
      case 'setMute': state.mute[bus] = !state.mute[bus]; return done()
      case 'getVolume': return json([String(state.volume[bus] ?? 'N/A')])
      case 'setVolume': state.volume[bus] = Number(q.volume); return done()
      case 'getCurrentMode': return json([state.mode ?? 'cam'])
      case 'setMode': setTimeout(() => { state.mode = q.mode }, 250); return done()
      case 'getChannels': return json({ items: [{ title: 'OHG YouTube', UUID: 'CH-YT' }] })
      case 'getProfileList': return json({ items: [{ title: 'Default Show', UUID: 'P-1' }] })
      case 'getVideoList': return json({ items: [{ title: '-No recent items-', UUID: '' }] })
      case 'setClickButton': state.live = !state.live; state.busyUntil = Date.now() + 2500; return done()
      case 'setComment': state.comments.push(q.text); return done()
      case 'setMarker': state.markers.push(q.text ?? ''); return done()
      case 'getSceneImage': return json({ icon: 'data:image/jpg;base64,' + sceneJpeg(q.id, state).replace(/(.{76})/g, '$1\r\n') })
      default:
        if (path.startsWith('set')) return done()
        res.writeHead(404); return res.end('unknown')
    }
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, state })
    }),
  )
}
