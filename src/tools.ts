import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AUDIO_BUSES, apiAudioBus, EcammClient, preflight, resolveItem, scalar, summarizeInfo, yes, type Item } from './client.js'
import { EcammError } from './http.js'

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
type Result = { content: Content[]; isError?: boolean }

const text = (v: unknown): Result => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
})

/**
 * Safety tiers (same idea as the Showrunner pre-flight):
 *   read    - never changes anything
 *   show    - changes what's on screen or in the mix (scenes, overlays, mutes)
 *   on-air  - starts/stops a broadcast or recording, posts publicly, ends a Zoom.
 *             Requires confirm: true, otherwise returns a dry run.
 * ECAMM_READ_ONLY=1 blocks show and on-air tiers entirely.
 */
type Tier = 'read' | 'show' | 'on-air'

export function registerTools(server: McpServer, client: EcammClient, opts: { readOnly: boolean }) {
  const wrap =
    <A>(tier: Tier, fn: (args: A) => Promise<Result>) =>
    async (args: A): Promise<Result> => {
      try {
        if (tier !== 'read' && opts.readOnly) {
          throw new EcammError('ecamm-mcp is in read-only mode (ECAMM_READ_ONLY=1).', 'blocked')
        }
        return await fn(args)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
      }
    }

  const ann = (tier: Tier, title: string) => ({
    title,
    readOnlyHint: tier === 'read',
    destructiveHint: tier === 'on-air',
    openWorldHint: false,
  })

  const confirmArg = {
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true to actually do it. Without it you get a dry run describing what would happen.'),
  }

  const dryRun = (what: string, extra: Record<string, unknown> = {}) =>
    text({ dryRun: true, wouldDo: what, ...extra, note: 'Call again with confirm: true to do it.' })

  const label = (i: Item) => (i.group ? `${i.group} / ${i.title}` : i.title)

  // ================= READ =================

  server.registerTool(
    'ecamm_status',
    {
      description:
        'Connection, approval state, and live status of Ecamm Live: start/pause button labels (tells you if live or recording), current scene, viewers, preview mode, mutes, volumes, Zoom state.',
      inputSchema: {},
      annotations: ann('read', 'Ecamm status'),
    },
    wrap('read', async () => {
      const info = await client.info(true)
      const scenes = await client.scenes().catch(() => [] as Item[])
      const cur = String(info.CurrentScene ?? '')
      const scene = scenes.find((s) => s.id === cur)
      return text({
        connectedTo: client.target.host,
        machine: client.target.instance?.hostname,
        approved: true,
        currentScene: scene ? { id: scene.id, title: label(scene) } : cur,
        sourceMode: (await client.get('getCurrentMode').catch(() => undefined)) ?? undefined,
        ...summarizeInfo(info),
      })
    }),
  )

  server.registerTool(
    'ecamm_preflight',
    {
      description:
        'Pre-show checklist. One read-only call that reports whether Ecamm is ready to go live and flags problems: already on air, main output or mic muted, mic at 0, no destination, Preview Mode left on. Run it before going live or when the user asks "am I ready?"',
      inputSchema: {},
      annotations: ann('read', 'Pre-show check'),
    },
    wrap('read', async () => {
      const info = await client.info(true)
      const [scenes, destinations, overlays, mode] = await Promise.all([
        client.scenes().catch(() => [] as Item[]),
        client.channels().catch(() => [] as Item[]),
        client.overlays().catch(() => [] as Item[]),
        client.get('getCurrentMode').catch(() => undefined),
      ])
      const scene = scenes.find((s) => s.id === String(info.CurrentScene ?? ''))
      return text(
        preflight({
          info,
          sceneTitle: scene ? label(scene) : undefined,
          sourceMode: scalar(mode) || undefined,
          destinations,
          overlays,
        }),
      )
    }),
  )

  server.registerTool(
    'ecamm_discover',
    {
      description:
        'Browse the network (Bonjour) for running Ecamm Live instances and (re)connect. Use if Ecamm was relaunched or you need to see which Macs are running it.',
      inputSchema: {},
      annotations: ann('read', 'Find Ecamm Live'),
    },
    wrap('read', async () => {
      const found = await client.locate()
      let permission: string = 'unknown'
      try { permission = await client.permission() } catch (e) { permission = String((e as Error).message) }
      return text({ found, connectedTo: client.target.host, permission, clientName: client.clientName })
    }),
  )

  server.registerTool(
    'ecamm_list_scenes',
    { description: 'All scenes (flattened out of scene groups) with ids, and which is live.', inputSchema: {}, annotations: ann('read', 'List scenes') },
    wrap('read', async () => {
      const [scenes, cur] = await Promise.all([client.scenes(), client.currentScene()])
      return text(scenes.map((s) => ({ ...s, current: s.id === cur })))
    }),
  )

  server.registerTool(
    'ecamm_list_overlays',
    {
      description: 'Overlays in the CURRENT scene (Ecamm cannot report other scenes) with visibility.',
      inputSchema: {},
      annotations: ann('read', 'List overlays'),
    },
    wrap('read', async () => text(await client.overlays())),
  )

  server.registerTool(
    'ecamm_list',
    {
      description: 'List cameras, videos (recent), sounds, audio filters, profiles, or streaming destinations.',
      inputSchema: {
        what: z.enum(['cameras', 'videos', 'sounds', 'audio_filters', 'profiles', 'destinations']),
      },
      annotations: ann('read', 'List Ecamm items'),
    },
    wrap('read', async ({ what }: { what: string }) => {
      const map: Record<string, () => Promise<unknown>> = {
        cameras: async () => ({ default: await client.get('getDefaultCamera'), items: await client.cameras() }),
        videos: client.videos,
        sounds: client.sounds,
        audio_filters: client.audioFilters,
        profiles: client.profiles,
        destinations: client.channels,
      }
      return text(await map[what]())
    }),
  )

  server.registerTool(
    'ecamm_thumbnail',
    {
      description: "Ecamm's last thumbnail image of a scene, overlay, or video. Scene/overlay by name or id; video by file path.",
      inputSchema: { kind: z.enum(['scene', 'overlay', 'video']), ref: z.string() },
      annotations: ann('read', 'Get thumbnail'),
    },
    wrap('read', async ({ kind, ref }: { kind: 'scene' | 'overlay' | 'video'; ref: string }) => {
      let id = ref
      if (kind === 'scene') id = resolveItem(await client.scenes(), ref, 'scene').id
      if (kind === 'overlay') id = resolveItem(await client.overlays(), ref, 'overlay').id
      const ep = ({ scene: 'getSceneImage', overlay: 'getOverlayImage', video: 'getVideoImage' } as const)[kind]
      const img = await client.image(ep, id)
      if (!img) return text(`No thumbnail available for ${kind} ${ref}`)
      return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }] }
    }),
  )

  // ================= SHOW =================

  server.registerTool(
    'ecamm_switch_scene',
    {
      description: 'Take a scene live, by name (partial ok if unique), "Group / Scene", or id. Waits until Ecamm confirms the switch.',
      inputSchema: { scene: z.string() },
      annotations: ann('show', 'Switch scene'),
    },
    wrap('show', async ({ scene }: { scene: string }) => {
      const target = resolveItem(await client.scenes(), scene, 'scene')
      const ok = await client.switchScene(target.id)
      return text({ switchedTo: label(target), id: target.id, confirmed: ok })
    }),
  )

  server.registerTool(
    'ecamm_step_scene',
    { description: 'Go to the next or previous scene.', inputSchema: { direction: z.enum(['next', 'previous']) }, annotations: ann('show', 'Next/previous scene') },
    wrap('show', async ({ direction }: { direction: 'next' | 'previous' }) => {
      await client.set(direction === 'next' ? 'setNext' : 'setPrev')
      await new Promise((r) => setTimeout(r, 500))
      const cur = await client.currentScene()
      const s = (await client.scenes()).find((x) => x.id === cur)
      return text({ nowOn: s ? label(s) : cur })
    }),
  )

  server.registerTool(
    'ecamm_set_overlay',
    {
      description: 'Show, hide, or toggle an overlay in the current scene, by name or id. Show/hide is idempotent.',
      inputSchema: { overlay: z.string(), state: z.enum(['show', 'hide', 'toggle']) },
      annotations: ann('show', 'Show/hide overlay'),
    },
    wrap('show', async ({ overlay, state }: { overlay: string; state: 'show' | 'hide' | 'toggle' }) => {
      const ov = resolveItem(await client.overlays(), overlay, 'overlay')
      const r = await client.setOverlayVisible(ov.id, state === 'toggle' ? 'toggle' : state === 'show')
      return text({ overlay: ov.title, wasVisible: r.before, nowVisible: r.after })
    }),
  )

  server.registerTool(
    'ecamm_set_overlay_text',
    {
      description: 'Replace the text of an existing text or fixed overlay in the CURRENT scene, preserving its styling. Does not create or show the overlay. Requires an Ecamm version supporting setOverlayText. Reports acceptance, not verified rendered text.',
      inputSchema: { overlay: z.string().trim().min(1), text: z.string().min(1) },
      annotations: ann('show', 'Update overlay text'),
    },
    wrap('show', async ({ overlay, text: value }: { overlay: string; text: string }) => {
      const ov = resolveItem(await client.overlays(), overlay, 'overlay')
      await client.set('setOverlayText', { id: ov.id, text: value })
      return text({ overlay: ov.title, id: ov.id, text: value, accepted: true, verified: false,
        note: 'Ecamm accepted the text update. Check the rendered overlay; the Remote API does not provide text readback.' })
    }),
  )

  server.registerTool(
    'ecamm_set_mute',
    {
      description: 'Mute or unmute. Omit bus for the main output mute. Idempotent (reads state first, since Ecamm only toggles).',
      inputSchema: { muted: z.boolean(), bus: z.enum(AUDIO_BUSES).optional() },
      annotations: ann('show', 'Mute/unmute'),
    },
    wrap('show', async ({ muted, bus }: { muted: boolean; bus?: (typeof AUDIO_BUSES)[number] }) => {
      const r = await client.setMuted(bus, muted)
      return text({ bus: bus ?? 'main', wasMuted: r.before, nowMuted: r.after })
    }),
  )

  server.registerTool(
    'ecamm_set_volume',
    {
      description: 'Set a bus volume 0-100.',
      inputSchema: { bus: z.enum(AUDIO_BUSES), volume: z.number().min(0).max(100) },
      annotations: ann('show', 'Set volume'),
    },
    wrap('show', async ({ bus, volume }: { bus: (typeof AUDIO_BUSES)[number]; volume: number }) => {
      const wireBus = apiAudioBus(bus)
      const before = await client.get('getVolume', { bus: wireBus })
      await client.set('setVolume', { bus: wireBus, volume: Math.round(volume) })
      const after = await client.get('getVolume', { bus: wireBus })
      return text({ bus, before, after })
    }),
  )

  server.registerTool(
    'ecamm_set_camera',
    { description: 'Pick the camera input, by name or id.', inputSchema: { camera: z.string() }, annotations: ann('show', 'Set camera') },
    wrap('show', async ({ camera }: { camera: string }) => {
      const cam = resolveItem(await client.cameras(), camera, 'camera')
      await client.set('setInput', { id: cam.id })
      return text({ camera: cam.title, id: cam.id })
    }),
  )

  server.registerTool(
    'ecamm_set_source_mode',
    { description: 'Switch source mode: camera, screen share, or video playback.', inputSchema: { mode: z.enum(['cam', 'screen', 'video']) }, annotations: ann('show', 'Set source mode') },
    wrap('show', async ({ mode }: { mode: string }) => {
      return text(await client.setSourceMode(mode))
    }),
  )

  server.registerTool(
    'ecamm_play_video',
    { description: 'Play a video file (full path, see ecamm_list videos).', inputSchema: { path: z.string() }, annotations: ann('show', 'Play video') },
    wrap('show', async ({ path }: { path: string }) => {
      await client.set('setVideo', { id: path })
      return text({ playing: path })
    }),
  )

  server.registerTool(
    'ecamm_sound',
    {
      description: 'Sound effects: play (by name or id, optional volume 0-100 and loop/restart), stop, pause, or set volume of the playing sound.',
      inputSchema: {
        action: z.enum(['play', 'stop', 'pause', 'volume']),
        sound: z.string().optional().describe('Required for play'),
        volume: z.number().min(0).max(100).optional(),
        mode: z.enum(['restart', 'loop', 'stop']).optional().describe('Playback behavior for play'),
      },
      annotations: ann('show', 'Sound effects'),
    },
    wrap('show', async (a: { action: string; sound?: string; volume?: number; mode?: string }) => {
      if (a.action === 'play') {
        if (!a.sound) throw new EcammError('sound is required for play', 'not_found')
        const s = resolveItem(await client.sounds(), a.sound, 'sound')
        await client.set('setSound', { id: s.id, volume: a.volume ?? 100, action: a.mode ?? 'restart' })
        return text({ playing: s.title })
      }
      if (a.action === 'volume') {
        if (a.volume === undefined) throw new EcammError('volume is required', 'not_found')
        await client.set('setSoundVolume', { volume: Math.round(a.volume) })
        return text({ soundVolume: a.volume })
      }
      await client.set(a.action === 'stop' ? 'setSoundStop' : 'setSoundPause')
      return text({ done: a.action })
    }),
  )

  server.registerTool(
    'ecamm_toggle_audio_filter',
    { description: 'Toggle an audio filter on/off, by name or id.', inputSchema: { filter: z.string() }, annotations: ann('show', 'Toggle audio filter') },
    wrap('show', async ({ filter }: { filter: string }) => {
      const f = resolveItem(await client.audioFilters(), filter, 'audio filter')
      await client.set('setAudioFilter', { id: f.id })
      return text({ toggled: f.title })
    }),
  )

  server.registerTool(
    'ecamm_toggle',
    {
      description:
        'Toggle a feature: pip, preview_mode, publish_preview (takes the Preview Mode layout live), hide_ui (on-screen controls), live_demo. Returns state where Ecamm reports it.',
      inputSchema: { feature: z.enum(['pip', 'preview_mode', 'publish_preview', 'hide_ui', 'live_demo']) },
      annotations: ann('show', 'Toggle feature'),
    },
    wrap('show', async ({ feature }: { feature: string }) => {
      const ep = { pip: 'setPIP', preview_mode: 'setPreviewMode', publish_preview: 'setPublish', hide_ui: 'setHideShowUI', live_demo: 'setLiveDemo' }[feature]!
      await client.set(ep)
      const info = await client.info(true)
      return text({
        toggled: feature,
        previewMode: yes(info.PreviewMode),
        hidingUI: yes(info.HidingUI),
        liveDemo: yes(info.LiveDemo),
      })
    }),
  )

  server.registerTool(
    'ecamm_comment_overlay',
    { description: 'Show the most recent viewer comment as an overlay, or hide it.', inputSchema: { state: z.enum(['show', 'hide']) }, annotations: ann('show', 'Comment overlay') },
    wrap('show', async ({ state }: { state: 'show' | 'hide' }) => {
      await client.set(state === 'show' ? 'setShowComment' : 'setHideComment')
      return text({ commentOverlay: state })
    }),
  )

  server.registerTool(
    'ecamm_add_marker',
    { description: 'Drop a chapter/edit marker in the current recording or broadcast.', inputSchema: { text: z.string().optional() }, annotations: ann('show', 'Add marker') },
    wrap('show', async ({ text: t }: { text?: string }) => {
      await client.set('setAddMarker', { text: t, dialogbox: 'false' })
      return text({ marker: t ?? '(untitled)', accepted: true, verified: false,
        note: 'Ecamm accepted the marker request. The Remote API does not verify that it was saved to the recording marker file.' })
    }),
  )

  // ================= ON-AIR (confirm required) =================

  server.registerTool(
    'ecamm_start_stop',
    {
      description:
        'Click the main Go Live / Record / End button. This STARTS OR ENDS a live broadcast or recording, depending on its current label. Waits until Ecamm finishes starting or ending and reports the resulting state (on-air, idle, ended). Optional destination (from ecamm_list destinations) and title/description for a new broadcast. Requires confirm: true.',
      inputSchema: {
        destination: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        ...confirmArg,
      },
      annotations: ann('on-air', 'Go live / record / end'),
    },
    wrap('on-air', async (a: { destination?: string; title?: string; description?: string; confirm?: boolean }) => {
      const before = await client.info(true)
      const dest = a.destination ? resolveItem(await client.channels(), a.destination, 'destination') : undefined
      if (!a.confirm) {
        return dryRun(`Click "${before.ButtonLabel}"`, { destination: dest?.title ?? '(scheduled/default)', title: a.title })
      }
      await client.set('setClickButton', { channel: dest?.id, title: a.title, desc: a.description })
      const after = await client.settleMainButton()
      return text({
        clicked: before.ButtonLabel,
        buttonNowSays: after.label,
        state: after.state,
        confirmed: after.settled,
        ...(after.settled ? {} : { note: 'Ecamm still says "Wait". Check ecamm_status in a few seconds.' }),
        ...(after.state === 'ended' ? { note: 'Broadcast ended. Ecamm is showing its summary; click OK there to finish up.' } : {}),
      })
    }),
  )

  server.registerTool(
    'ecamm_recording',
    {
      description: 'Pause/resume the current recording, or split into a new recording file while streaming/recording. Requires confirm: true.',
      inputSchema: { action: z.enum(['pause_resume', 'new_file']), ...confirmArg },
      annotations: ann('on-air', 'Pause / split recording'),
    },
    wrap('on-air', async ({ action, confirm }: { action: string; confirm?: boolean }) => {
      const info = await client.info(true)
      if (!confirm) return dryRun(action === 'pause_resume' ? `Click "${info.PauseButtonLabel}"` : 'Start a new recording file', {})
      await client.set(action === 'pause_resume' ? 'setClickPause' : 'setStartNewRecording')
      const after = await client.info(true)
      return text({ done: action, pauseButtonNowSays: after.PauseButtonLabel })
    }),
  )

  server.registerTool(
    'ecamm_post_comment',
    {
      description: 'Post a PUBLIC chat comment to the live Twitch, YouTube, or Facebook Page broadcast. Requires confirm: true.',
      inputSchema: { text: z.string().min(1), ...confirmArg },
      annotations: ann('on-air', 'Post public comment'),
    },
    wrap('on-air', async ({ text: t, confirm }: { text: string; confirm?: boolean }) => {
      if (!confirm) return dryRun('Post public comment', { text: t })
      await client.set('setComment', { text: t })
      return text({ posted: t })
    }),
  )

  server.registerTool(
    'ecamm_set_profile',
    {
      description: 'Switch Ecamm to a different Profile (swaps the whole scene set). Requires confirm: true.',
      inputSchema: { profile: z.string(), ...confirmArg },
      annotations: ann('on-air', 'Switch profile'),
    },
    wrap('on-air', async ({ profile, confirm }: { profile: string; confirm?: boolean }) => {
      const p = resolveItem(await client.profiles(), profile, 'profile')
      if (!confirm) return dryRun(`Switch to profile "${p.title}"`)
      await client.set('setProfile', { id: p.id })
      return text({ profile: p.title })
    }),
  )

  const ZOOM_SAFE = {
    toggle_video: 'setZoomVideo',
    toggle_audio: 'setZoomAudio',
    raise_hand: 'setZoomRaiseHand',
    fullscreen: 'setZoomFullScreen',
    prev_gallery: 'setZoomPrevGallery',
    next_gallery: 'setZoomNextGallery',
    gallery_speaker: 'setZoomGallerySpeaker',
    spotlight_self: 'setSpotlightSelf',
  } as const
  const ZOOM_CONFIRM = {
    new_meeting: 'setZoomNew',
    leave: 'setZoomLeave',
    end_for_all: 'setZoomLeave',
    mute_all: 'setZoomMuteAll',
    cloud_record: 'setZoomCloudRecord',
    local_record: 'setZoomLocalRecord',
    pause_record: 'setZoomPauseRecord',
  } as const

  server.registerTool(
    'ecamm_zoom',
    {
      description:
        'Ecamm for Zoom controls. View/self actions run directly; new_meeting, leave, end_for_all, mute_all and recording actions need confirm: true. panel shows meeting|chat|participants|share.',
      inputSchema: {
        action: z.enum(['panel', ...Object.keys(ZOOM_SAFE), ...Object.keys(ZOOM_CONFIRM)] as [string, ...string[]]),
        panel: z.enum(['meeting', 'chat', 'participants', 'share', 'sharing']).optional(),
        usePersonalMeetingId: z.boolean().optional(),
        ...confirmArg,
      },
      annotations: ann('on-air', 'Zoom controls'),
    },
    async (a: { action: string; panel?: string; usePersonalMeetingId?: boolean; confirm?: boolean }) => {
      const tier: Tier = a.action in ZOOM_CONFIRM ? 'on-air' : 'show'
      return wrap(tier, async () => {
        if (a.action === 'panel') {
          if (!a.panel) throw new EcammError('panel is required', 'not_found')
          await client.set('setZoomPanel', { panel: a.panel === 'share' ? 'sharing' : a.panel })
          return text({ panel: a.panel })
        }
        if (a.action in ZOOM_SAFE) {
          await client.set(ZOOM_SAFE[a.action as keyof typeof ZOOM_SAFE])
        } else {
          if (!a.confirm) return dryRun(`Zoom: ${a.action}`)
          const params =
            a.action === 'new_meeting' ? { pmi: String(a.usePersonalMeetingId ?? true) }
            : a.action === 'leave' ? { end: 'false' }
            : a.action === 'end_for_all' ? { end: 'true' }
            : undefined
          await client.set(ZOOM_CONFIRM[a.action as keyof typeof ZOOM_CONFIRM], params)
        }
        const info = await client.info(true)
        return text({ done: a.action, zoom: summarizeInfo(info).zoom })
      })(a)
    },
  )
}
