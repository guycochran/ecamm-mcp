import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type EcammClient, scalar } from './client.js'
import { inspectRecording, listRecordings, prepareHandoff, readMarkers, recordingDoctor, recordingOptions } from './recordings.js'

const intentSchema = z.enum(['record_only', 'stream_and_record', 'stream_only', 'present'])
export type SessionIntent = z.infer<typeof intentSchema>
type Check = { name: string; status: 'observed' | 'needs_check' | 'unavailable'; detail: string }

export function sessionChecks(info: Record<string, unknown>, intent: SessionIntent): Check[] {
  const checks: Check[] = []
  const button = scalar(info.ButtonLabel).trim()
  checks.push({ name: 'Session state', status: 'needs_check', detail: button
    ? `Ecamm's main button reads "${button}". This does not independently establish streaming, recording, or other output state.`
    : 'Ecamm did not report a recognizable session state.' })
  for (const [name, key] of [['Primary microphone', 'MUTE_MIC'], ['Guest audio', 'MUTE_INTERVIEW']]) {
    const value = scalar(info[key]).toLowerCase()
    checks.push({ name, status: value === 'yes' ? 'needs_check' : value === 'no' ? 'observed' : 'unavailable',
      detail: value === 'yes' ? 'Reported muted.' : value === 'no' ? 'Reported unmuted. This does not verify an audio signal.' : 'Mute state is unavailable.' })
  }
  checks.push({ name: 'Output intent', status: 'needs_check', detail: intent === 'record_only'
    ? 'In Ecamm’s Mode menu, confirm Stream is off and Record is on. Source mode (camera/screen/video) does not verify this.'
    : intent === 'stream_and_record' ? 'Confirm Stream and Record are both enabled in Ecamm’s Mode menu.'
      : intent === 'stream_only' ? 'Confirm the intended streaming destination and whether recording should be disabled.'
        : 'Confirm the intended presentation/virtual camera output and any recording requirement.' })
  if (intent === 'record_only' || intent === 'stream_and_record') {
    checks.push({ name: 'Recording tracks', status: 'needs_check', detail: 'Confirm required separate audio/video tracks in Recording preferences, then make and inspect a short test recording. These settings are not exposed by the reviewed API.' })
  }
  return checks
}

export async function prepareSession(client: EcammClient, intent: SessionIntent, requestedScenes: string[]) {
  // Readiness is established once before concurrent reads to avoid parallel first-use permission flows.
  await client.ensureReady()
  const results = await Promise.allSettled([client.info(true), client.scenes(), client.cameras(), ...(intent.startsWith('stream') ? [client.channels()] : [])])
  const info = results[0].status === 'fulfilled' ? results[0].value as Record<string, unknown> : {}
  const checks = sessionChecks(info, intent)
  const lists: Record<string, unknown> = {}
  for (const [index, key] of ['status', 'scenes', 'sources', 'destinations'].entries()) {
    const result = results[index]
    if (!result) continue
    if (result.status === 'rejected') checks.push({ name: key, status: 'unavailable', detail: `Could not read ${key}. Retry the connection check before relying on this plan.` })
    else if (index !== 0) lists[key] = result.value
  }
  const scenes = results[1].status === 'fulfilled' ? results[1].value as { id: string; title: string }[] : undefined
  for (const ref of requestedScenes) {
    const matches = scenes?.filter(s => s.id === ref || s.title.toLowerCase() === ref.toLowerCase())
    checks.push({ name: `Scene: ${ref}`, status: matches?.length === 1 ? 'observed' : 'needs_check',
      detail: !matches ? 'Scene list unavailable.' : matches.length === 1 ? `Found ${matches[0].title} (${matches[0].id}). Contents and source availability are not verified.`
        : matches.length > 1 ? 'More than one scene matches. Use the scene ID.' : 'Scene not found. Create or import it in Ecamm first.' })
  }
  if (intent.startsWith('stream') && results[3]?.status === 'fulfilled') {
    const destinations = results[3].value as unknown[]
    checks.push({ name: 'Streaming destination', status: 'needs_check', detail: destinations.length
      ? 'Destinations are available. Confirm the selected event and destination; availability does not establish connectivity.' : 'No streaming destinations were returned.' })
  }
  return { intent, checkedAt: new Date().toISOString(), checks, ...lists, changedProduction: false,
    note: 'Preparation report only. Operator checks remain outstanding; no global ready-to-broadcast claim is made.' }
}

export function registerWorkflowTools(server: McpServer, client: EcammClient) {
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
  const safe = <A>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try { return result(await fn(args)) } catch (err) {
      return { ...result({ error: err instanceof Error ? err.message : String(err) }), isError: true }
    }
  }
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  server.registerTool('ecamm_recording_status', {
    description: 'Check local recording-folder configuration, completion inbox location, and ffprobe availability without opening recordings or contacting Ecamm. Does not verify the completion Shortcut is enabled.',
    inputSchema: {}, annotations,
  }, safe(async () => recordingDoctor(recordingOptions())))
  server.registerTool('ecamm_prepare_session', {
    description: 'Read-only preparation for recording, streaming, or presenting. Lists observed facts and required human checks without changing scenes, settings, or output. Use instead of a streaming-only preflight for interviews recorded for later editing.',
    inputSchema: { intent: intentSchema, scenes: z.array(z.string().min(1).max(256)).max(100).default([]) }, annotations,
  }, safe(async ({ intent, scenes }) => prepareSession(client, intent, scenes)))
  server.registerTool('ecamm_list_recordings', {
    description: 'List local recording-completion notifications saved by the optional Shortcut helper. Does not scan for or guess the newest recording, and does not verify files.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) }, annotations,
  }, safe(async ({ limit }) => listRecordings(recordingOptions(), limit)))
  server.registerTool('ecamm_inspect_recording', {
    description: 'Inspect local recording metadata without changing the file. Requires configured ECAMM_RECORDING_ROOTS and ffprobe. Reports audio/video stream presence, not audible speech or finalization. Paths belong to this MCP Mac, not a remote Ecamm Mac.',
    inputSchema: { path: z.string().min(1).max(4096) }, annotations,
  }, safe(async ({ path }) => inspectRecording(path, recordingOptions())))
  server.registerTool('ecamm_read_markers', {
    description: 'Read the marker file Ecamm saves beside a recording (same name, .txt) and return each marker with its time and text. Requires the recording folder to be configured. Read-only. Understands the layout Ecamm 4.6.2 writes; any other layout is reported as unrecognized, not guessed at. Times count recorded time (a pause adds nothing). In the later file of a split session they carry on from the earlier part and are not offsets into that file; this was seen once and no correction is applied.',
    inputSchema: { path: z.string().min(1).max(4096) }, annotations,
  }, safe(async ({ path }) => readMarkers(path, recordingOptions())))
  server.registerTool('ecamm_prepare_edit_handoff', {
    description: 'Return a recording receipt for a known completion event and explicitly supplied associated files. List every expected separate track; omit its path to flag it as needing a file. Does not match tracks automatically, copy/upload files, or launch an editor.',
    inputSchema: {
      event_id: z.string().regex(/^[a-f0-9]{64}$/),
      expected_assets: z.array(z.object({ label: z.string().min(1).max(256), kind: z.enum(['program', 'video', 'audio']), path: z.string().min(1).max(4096).optional() })).max(32).default([]),
    }, annotations,
  }, safe(async ({ event_id, expected_assets }) => prepareHandoff(event_id, expected_assets, recordingOptions())))
}
