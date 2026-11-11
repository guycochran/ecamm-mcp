import { z } from 'zod'
import { AUDIO_BUSES, apiAudioBus, type EcammClient, type Item, resolveItem, scalar } from './client.js'

/**
 * A cue is a short, ordered list of ordinary preparation steps: pick a scene, show or hide
 * an overlay, change a title, set a mute or a level, wait.
 *
 * What it deliberately cannot do: go live, record, end, post a public comment, switch
 * profiles or touch a Zoom meeting. Those stay separate, explicit requests.
 *
 * It is bounded (12 steps, 60 s of waiting), runs inside one mutation-queue section so
 * nothing from this process interleaves with it, stops at the first step that fails or
 * when someone else changes the scene, and never claims to roll anything back.
 */
export const MAX_CUE_STEPS = 12
export const MAX_CUE_WAIT_S = 60

export const cueStepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('scene'), scene: z.string().min(1).max(256) }),
  z.object({ do: z.literal('overlay'), overlay: z.string().min(1).max(256), state: z.enum(['show', 'hide']) }),
  z.object({ do: z.literal('overlay_text'), overlay: z.string().min(1).max(256), text: z.string().min(1).max(2000) }),
  z.object({ do: z.literal('mute'), muted: z.boolean(), bus: z.enum(AUDIO_BUSES).optional() }),
  z.object({ do: z.literal('volume'), bus: z.enum(AUDIO_BUSES), volume: z.number().min(0).max(100) }),
  z.object({ do: z.literal('wait'), seconds: z.number().min(0.1).max(30) }),
])
export type CueStep = z.infer<typeof cueStepSchema>

const sceneLabel = (i: Item) => (i.group ? `${i.group} / ${i.title}` : i.title)

export function describeStep(step: CueStep): string {
  switch (step.do) {
    case 'scene': return `Switch to scene "${step.scene}"`
    case 'overlay': return `${step.state === 'show' ? 'Show' : 'Hide'} overlay "${step.overlay}"`
    case 'overlay_text': return `Set overlay "${step.overlay}" text to "${step.text}"`
    case 'mute': return `${step.muted ? 'Mute' : 'Unmute'} ${step.bus ?? 'main output'}`
    case 'volume': return `Set ${step.bus} level to ${Math.round(step.volume)}`
    case 'wait': return `Wait ${step.seconds} s`
  }
}

export interface PlannedStep {
  number: number
  what: string
  /** yes: the thing it refers to exists now. later: can only be checked once its scene is on screen. */
  checked: 'yes' | 'later' | 'not-needed'
  problem?: string
}

export interface CuePlan {
  ok: boolean
  steps: PlannedStep[]
  problems: string[]
  startingScene: string
}

/** Check every reference that can be checked without changing anything. */
export async function planCue(client: EcammClient, steps: CueStep[]): Promise<CuePlan> {
  const [scenes, currentId] = await Promise.all([client.scenes(), client.currentScene()])
  const current = scenes.find((s) => s.id === currentId)
  const problems: string[] = []
  if (!current) problems.push('The current scene could not be identified. Check Ecamm before running a cue.')
  const totalWait = steps.reduce((n, s) => n + (s.do === 'wait' ? s.seconds : 0), 0)
  if (totalWait > MAX_CUE_WAIT_S) problems.push(`The waits add up to ${totalWait} s; the limit is ${MAX_CUE_WAIT_S} s.`)

  // Ecamm only lists overlays for the scene on screen, so an overlay named after a scene
  // change cannot be checked until the cue is running.
  let overlaysNow: Item[] | undefined
  let sceneChanged = false
  let textChanged = false
  const planned: PlannedStep[] = []
  for (const [i, step] of steps.entries()) {
    const p: PlannedStep = { number: i + 1, what: describeStep(step), checked: 'not-needed' }
    try {
      if (step.do === 'scene') {
        p.what = `Switch to scene "${sceneLabel(resolveItem(scenes, step.scene, 'scene'))}"`
        p.checked = 'yes'
        sceneChanged = true
      } else if (step.do === 'overlay' || step.do === 'overlay_text') {
        if (sceneChanged || textChanged) p.checked = 'later'
        else {
          overlaysNow ??= await client.overlays()
          resolveItem(overlaysNow, step.overlay, 'overlay')
          p.checked = 'yes'
        }
        if (step.do === 'overlay_text') textChanged = true
      }
    } catch (err) {
      p.problem = err instanceof Error ? err.message : String(err)
      problems.push(`Step ${p.number}: ${p.problem}`)
    }
    planned.push(p)
  }
  return { ok: problems.length === 0, steps: planned, problems, startingScene: current ? sceneLabel(current) : currentId }
}

export interface StepOutcome {
  number: number
  what: string
  /** verified: read back from Ecamm. accepted: Ecamm took it, nothing to read back. failed / not_run speak for themselves. */
  outcome: 'verified' | 'accepted' | 'failed' | 'not_run'
  detail?: string
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('Cue cancelled.')); return }
  const cancel = () => { clearTimeout(timer); reject(new Error('Cue cancelled.')) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, ms)
  signal?.addEventListener('abort', cancel, { once: true })
})

/**
 * Run a planned cue. Call from inside the mutation queue; this takes no lock of its own.
 * Stops at the first failure, and stops without touching anything further if the scene on
 * screen is not the one this cue last put there.
 */
export async function runCue(client: EcammClient, steps: CueStep[], signal?: AbortSignal): Promise<{ steps: StepOutcome[]; completed: number; stopped?: string; sceneNow: string }> {
  const out: StepOutcome[] = steps.map((s, i) => ({ number: i + 1, what: describeStep(s), outcome: 'not_run' as const }))
  const cancellation = 'The caller cancelled this cue. No further steps were started; an action already sent may still finish. Check Ecamm before retrying.'
  if (signal?.aborted) return { steps: out, completed: 0, stopped: cancellation, sceneNow: 'unknown' }
  const scenes = await client.scenes()
  let expected = await client.currentScene()
  let stopped: string | undefined
  if (!expected || !scenes.some(s => s.id === expected)) {
    return { steps: out, completed: 0, stopped: 'The starting scene is unknown; nothing was run.', sceneNow: 'unknown' }
  }
  // Plain text overlays can change their list title when text changes. Keep the
  // already-resolved object identity for subsequent uses of the original reference.
  const overlayIds = new Map<string, string>()
  const overlayFor = async (ref: string) => {
    const key = `${expected}:${ref.trim().toLowerCase()}`
    const current = await client.overlays()
    const id = overlayIds.get(key)
    const overlay = id ? current.find(item => item.id === id) : resolveItem(current, ref, 'overlay')
    if (!overlay) throw new Error(`The previously selected overlay "${ref}" is no longer in this scene.`)
    overlayIds.set(key, overlay.id)
    return overlay
  }

  for (const [i, step] of steps.entries()) {
    const o = out[i]
    if (signal?.aborted) { stopped = cancellation; break }
    const now = await client.currentScene().catch(() => undefined)
    if (signal?.aborted) { stopped = cancellation; break }
    if (now !== expected) {
      stopped = `Before step ${o.number}, the scene on screen was not the one this cue left it on. Someone else changed it, so the cue stopped and left their choice alone.`
      break
    }
    try {
      if (step.do === 'wait') {
        await sleep(step.seconds * 1000, signal)
        o.outcome = 'verified'
      } else if (step.do === 'scene') {
        const target = resolveItem(scenes, step.scene, 'scene')
        if (await client.switchScene(target.id)) { o.outcome = 'verified'; expected = target.id }
        else { o.outcome = 'failed'; o.detail = 'Ecamm did not switch to that scene.' }
      } else if (step.do === 'overlay') {
        const ov = await overlayFor(step.overlay)
        if (signal?.aborted) { stopped = cancellation; break }
        const want = step.state === 'show'
        const r = await client.setOverlayVisible(ov.id, want)
        if (r.after === want) o.outcome = 'verified'
        else { o.outcome = 'failed'; o.detail = r.after === undefined ? `Visibility of "${ov.title}" could not be read back. Check Ecamm before retrying.` : `Ecamm still lists "${ov.title}" as ${r.after ? 'showing' : 'hidden'}.` }
      } else if (step.do === 'overlay_text') {
        const ov = await overlayFor(step.overlay)
        if (signal?.aborted) { stopped = cancellation; break }
        const verified = await client.setOverlayText(ov.id, step.text)
        o.outcome = verified ? 'verified' : 'accepted'
        if (!verified) o.detail = 'Ecamm accepted the text but does not list the overlay under it. Normal for overlays that keep their own name; check the picture.'
      } else if (step.do === 'mute') {
        const r = await client.setMuted(step.bus, step.muted)
        if (r.after === step.muted) o.outcome = 'verified'
        else { o.outcome = 'failed'; o.detail = `Ecamm still reports ${step.bus ?? 'the main output'} as ${r.after ? 'muted' : 'not muted'}.` }
      } else {
        const bus = apiAudioBus(step.bus)
        const want = Math.round(step.volume)
        await client.set('setVolume', { bus, volume: want })
        const raw = scalar(await client.get('getVolume', { bus })).trim()
        const after = raw === '' ? NaN : Number(raw)
        if (after === want) o.outcome = 'verified'
        else { o.outcome = 'failed'; o.detail = `Ecamm reports ${step.bus} at ${Number.isFinite(after) ? after : 'an unreadable level'}.` }
      }
    } catch (err) {
      if (signal?.aborted && step.do === 'wait') { stopped = cancellation; break }
      o.outcome = 'failed'
      o.detail = err instanceof Error ? err.message : String(err)
    }
    if (o.outcome === 'failed') {
      stopped = `Step ${o.number} failed, so the remaining steps were not run.`
      break
    }
  }
  const sceneNowId = await client.currentScene().catch(() => '')
  const sceneNow = scenes.find((s) => s.id === sceneNowId)
  return { steps: out, completed: out.filter((s) => s.outcome === 'verified' || s.outcome === 'accepted').length, stopped, sceneNow: sceneNow ? sceneLabel(sceneNow) : 'unknown' }
}
