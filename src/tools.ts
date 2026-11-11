import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { buildSceneSheet, type SheetCell } from './sheet.js'
import { AUDIO_BUSES, apiAudioBus, EcammClient, onAirState, planMainButton, preflight, resolveItem, scalar, summarizeInfo, yes, type BroadcastIntent, type Item, type ThumbnailRefresh, type ThumbnailStatus } from './client.js'
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
        // Anything that changes Ecamm runs one at a time, start to finish.
        return tier === 'read' ? await fn(args) : await client.exclusive(() => fn(args))
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
      const content: Result['content'] = [{ type: 'image', data: img.data, mimeType: img.mimeType }]
      if (kind === 'scene' && id !== (await client.currentScene().catch(() => id))) {
        content.push({
          type: 'text',
          text: 'This scene is not on screen right now, so this thumbnail may be out of date. Ecamm only refreshes a thumbnail while its scene is on screen. Tell the person, or use ecamm_scene_sheet for fresh pictures.',
        })
      }
      return { content }
    }),
  )

  const MAX_SHEET = 40
  const MAX_VISITS = 16

  /** Build the labeled picture and its numbered index from whatever thumbnails Ecamm has now. */
  const sceneSheet = async (scenes: Item[], extra: Record<string, unknown>, walk?: ThumbnailRefresh): Promise<Result> => {
    const onScreen = await client.currentScene().catch(() => '')
    const statusOf = (id: string): ThumbnailStatus => {
      if (id === onScreen) return 'on-screen'
      const st = walk?.status.get(id) ?? 'stored'
      // The starting scene was on screen when the walk began, so its picture was current then.
      return st === 'on-screen' ? 'refreshed' : st
    }
    const NOTE: Record<ThumbnailStatus, string | undefined> = {
      'on-screen': undefined,
      refreshed: undefined,
      visited: 'shown, redraw not confirmed',
      stored: 'stored, may be old',
    }
    const cells: SheetCell[] = []
    for (const [i, s] of scenes.slice(0, MAX_SHEET).entries()) {
      const img = await client.sceneImage(s.id)
      const st = statusOf(s.id)
      cells.push({
        label: `${i + 1}. ${label(s)}${st === 'on-screen' ? ' (on screen now)' : ''}`,
        jpeg: img?.mimeType === 'image/jpeg' ? img.data : undefined,
        note: NOTE[st],
      })
    }
    const now = scenes.find((s) => s.id === onScreen)
    const summary = {
      scenes: scenes.map((s, i) => ({ number: i + 1, scene: label(s), thumbnail: statusOf(s.id), ...(i >= MAX_SHEET ? { inPicture: false } : {}) })),
      thumbnailKey: {
        'on-screen': 'current: this scene is on screen now',
        refreshed: 'current: Ecamm was seen redrawing it during this request',
        visited: 'the scene was put on screen but a redraw was not observed, so the picture may be old',
        stored: 'whatever Ecamm last saved; age unknown',
      },
      onScreenNow: now ? label(now) : 'unknown',
      ...extra,
      about: 'Thumbnails are small stills, not a live view. A green outline is Ecamm marking the scene that is on screen. Scene names outside plain ASCII show as "?" in the picture; use the numbers to match them to this list.',
    }
    return {
      content: [
        { type: 'image', data: buildSceneSheet(cells), mimeType: 'image/jpeg' },
        { type: 'text', text: JSON.stringify(summary, null, 2) },
      ],
    }
  }

  server.registerTool(
    'ecamm_scene_sheet',
    {
      description:
        'One labeled picture of every scene, with a numbered text index, for "show me my scenes" or checking a studio remotely. Changes nothing. ' +
        'It uses the thumbnails Ecamm already has, which are only current for the scene on screen, and says which may be old. ' +
        'For current pictures of every scene the person must ask for a refresh (ecamm_refresh_scene_sheet), which switches scenes. ' +
        'The person often cannot see tool images directly: if you can send or attach files, pass this picture on to them.',
      inputSchema: {},
      annotations: ann('read', 'Picture of every scene'),
    },
    wrap('read', async () => sceneSheet(await client.scenes(), { changedEcamm: false })),
  )

  // ================= SHOW =================

  server.registerTool(
    'ecamm_refresh_scene_sheet',
    {
      description:
        'Get CURRENT pictures of every scene by putting each scene on screen in turn, then returning to the starting scene, and return the labeled sheet. ' +
        'This changes what Ecamm is showing: anything fed from Ecamm (a virtual camera, a Zoom call, a second display) sees every scene flash by, and scenes that start media will start it. ' +
        'Only use it when the person has asked for fresh pictures and understands that; otherwise use ecamm_scene_sheet, which changes nothing. ' +
        'Refused while live, recording, starting, ending, or when the state cannot be read. Stops without restoring if someone else changes the scene or starts a broadcast partway through. ' +
        'Reports whether the return to the starting scene was verified.',
      inputSchema: {},
      annotations: ann('show', 'Refresh scene pictures'),
    },
    wrap('show', async () => {
      const info = await client.info(true)
      const state = onAirState(info.ButtonLabel)
      const scenes = await client.scenes()
      const startId = await client.currentScene()
      const start = scenes.find((s) => s.id === startId)
      let refused: string | undefined
      if (state === 'on-air') refused = 'Ecamm is live or recording, and switching scenes would go out on air'
      else if (state === 'busy') refused = 'Ecamm is in the middle of starting or ending a broadcast'
      else if (state === 'unknown') refused = `Ecamm's main button reads "${scalar(info.ButtonLabel)}", so it is not clear whether it is on air`
      else if (!start) refused = 'the scene on screen could not be identified, so there would be no way to return to it'
      if (refused) return sceneSheet(scenes, { changedEcamm: false, refreshRefused: refused })

      const walk = await client.refreshSceneThumbnails(scenes.slice(0, MAX_VISITS).map((s) => s.id), startId)
      return sceneSheet(
        scenes,
        {
          changedEcamm: true,
          startedOn: label(start!),
          returnToStartingScene: walk.restore,
          ...(walk.restoreNote ? { returnNote: walk.restoreNote } : {}),
          ...(walk.stopped ? { stoppedEarly: walk.stopped } : {}),
          ...(scenes.length > MAX_VISITS ? { note: `Only the first ${MAX_VISITS} scenes are visited per request.` } : {}),
        },
        walk,
      )
    }),
  )

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
      // On a real Ecamm (4.6.2) a text overlay's title in the overlay list is its text, so
      // the list is a readback. Other overlay kinds may keep their own title: then this
      // stays unverified rather than failed.
      let titleNow: string | undefined
      const deadline = Date.now() + 1500
      while (Date.now() < deadline) {
        titleNow = (await client.overlays()).find((o) => o.id === ov.id)?.title
        if (titleNow === value) break
        await new Promise((r) => setTimeout(r, 150))
      }
      const verified = titleNow === value
      return text({
        overlay: ov.title, id: ov.id, text: value, accepted: true, verified,
        note: verified
          ? 'Ecamm now lists this overlay with the new text.'
          : 'Ecamm accepted the text update, but the overlay list does not show the new text. That is normal for overlays that keep their own name; check the rendered overlay.',
      })
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
        'Go live, start a recording, or end one. State where the person wants to end up with intent: "go_live", "record" or "end". ' +
        'Ecamm has a single button whose meaning changes with its label, so this never just clicks it: asking to go live while already live does nothing (it will not end the broadcast), ' +
        'go_live is refused in Record Only mode and record is refused in broadcast mode, and nothing is clicked while Ecamm is starting, ending, showing its end summary, or showing a label this tool cannot read. ' +
        'After clicking it watches Ecamm and reports outcome: verified, failed or unknown. Optional destination (from ecamm_list destinations), title and description apply to go_live. ' +
        'Requires confirm: true. Calls without intent are answered with what the button currently means and are never clicked.',
      inputSchema: {
        intent: z.enum(['go_live', 'record', 'end']).optional().describe('Where the person wants to end up. Required to do anything.'),
        destination: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        ...confirmArg,
      },
      annotations: ann('on-air', 'Go live / record / end'),
    },
    wrap('on-air', async (a: { intent?: BroadcastIntent; destination?: string; title?: string; description?: string; confirm?: boolean }) => {
      const before = await client.info(true)
      const buttonLabel = scalar(before.ButtonLabel).trim()
      const from = onAirState(buttonLabel)
      if (!a.intent) {
        return text({
          changed: false,
          needsIntent: true,
          mainButton: buttonLabel || null,
          state: from,
          note: 'Nothing was clicked. Call again with intent: "go_live", "record" or "end" (and confirm: true). A bare click is no longer supported because the same click starts or ends a broadcast depending on timing.',
        })
      }
      const plan = planMainButton(a.intent, buttonLabel)
      if (plan.action === 'none') {
        return text({ changed: false, intent: a.intent, alreadyInRequestedState: plan.alreadyThere, state: from, mainButton: buttonLabel || null, note: plan.why })
      }
      const starting = plan.expect === 'on-air'
      const dest = starting && a.destination ? resolveItem(await client.channels(), a.destination, 'destination') : undefined
      if (!a.confirm) {
        return dryRun(plan.what, starting && a.intent === 'go_live' ? { destination: dest?.title ?? '(scheduled/default)', title: a.title } : {})
      }
      await client.set('setClickButton', starting ? { channel: dest?.id, title: a.title, desc: a.description } : undefined)
      const after = await client.verifyTransition(plan.expect, from)
      return text({
        intent: a.intent,
        clicked: buttonLabel,
        outcome: after.outcome,
        state: after.state,
        mainButton: after.label,
        ...(after.detail ? { detail: after.detail } : {}),
        ...(after.state === 'ended' ? { note: 'Ended. Ecamm is showing its summary; dismiss it on the Mac before the next broadcast.' } : {}),
        ...(after.outcome === 'unknown' ? { doNotRepeatBlindly: 'The click was sent. Check ecamm_status before sending this again, so a second click does not undo the first.' } : {}),
      })
    }),
  )

  server.registerTool(
    'ecamm_recording',
    {
      description:
        'Pause or resume the current recording, or split into a new recording file while streaming/recording. ' +
        'action "pause" and "resume" say where to end up: pausing an already paused recording does nothing. "pause_resume" is the old toggle, kept for compatibility. Requires confirm: true.',
      inputSchema: { action: z.enum(['pause', 'resume', 'pause_resume', 'new_file']), ...confirmArg },
      annotations: ann('on-air', 'Pause / split recording'),
    },
    wrap('on-air', async ({ action, confirm }: { action: 'pause' | 'resume' | 'pause_resume' | 'new_file'; confirm?: boolean }) => {
      const info = await client.info(true)
      const pauseLabel = scalar(info.PauseButtonLabel).trim()
      if (action === 'new_file') {
        if (!confirm) return dryRun('Start a new recording file', {})
        await client.set('setStartNewRecording')
        return text({ done: action, accepted: true, verified: false, note: 'Ecamm accepted the request. The Remote API does not report whether a new file was started.' })
      }
      if (action !== 'pause_resume') {
        const isPause = /^pause/i.test(pauseLabel)
        const isResume = /^resume/i.test(pauseLabel)
        if (!isPause && !isResume) {
          return text({ changed: false, pauseButton: pauseLabel || null, note: `Ecamm's pause button reads "${pauseLabel}", so there is nothing to ${action} right now.` })
        }
        if ((action === 'pause') !== isPause) {
          return text({ changed: false, alreadyInRequestedState: true, pauseButton: pauseLabel, note: action === 'pause' ? 'The recording is already paused.' : 'The recording is already running.' })
        }
      }
      if (!confirm) return dryRun(`Click "${pauseLabel}"`, {})
      await client.set('setClickPause')
      const after = scalar((await client.info(true)).PauseButtonLabel).trim()
      return text({ done: action, clicked: pauseLabel, pauseButtonNowSays: after, verified: after !== pauseLabel })
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
