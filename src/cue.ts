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
  const totalWait = steps.reduce((n, s) => n + (s.do === 'wait' ? s.seconds : 0), 0)
  if (totalWait > MAX_CUE_WAIT_S) problems.push(`The waits add up to ${totalWait} s; the limit is ${MAX_CUE_WAIT_S} s.`)

  // Ecamm only lists overlays for the scene on screen, so an overlay named after a scene
  // change cannot be checked until the cue is running.
  let overlaysNow: Item[] | undefined
  let sceneChanged = false
  const planned: PlannedStep[] = []
  for (const [i, step] of steps.entries()) {
    const p: PlannedStep = { number: i + 1, what: describeStep(step), checked: 'not-needed' }
    try {
      if (step.do === 'scene') {
        p.what = `Switch to scene "${sceneLabel(resolveItem(scenes, step.scene, 'scene'))}"`
        p.checked = 'yes'
        sceneChanged = true
      } else if (step.do === 'overlay' || step.do === 'overlay_text') {
        if (sceneChanged) p.checked = 'later'
        else {
          overlaysNow ??= await client.overlays()
          resolveItem(overlaysNow, step.overlay, 'overlay')
          p.checked = 'yes'
        }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Run a planned cue. Call from inside the mutation queue; this takes no lock of its own.
 * Stops at the first failure, and stops without touching anything further if the scene on
 * screen is not the one this cue last put there.
 */
export async function runCue(client: EcammClient, steps: CueStep[]): Promise<{ steps: StepOutcome[]; completed: number; stopped?: string; sceneNow: string }> {
  const scenes = await client.scenes()
  let expected = await client.currentScene()
  const out: StepOutcome[] = steps.map((s, i) => ({ number: i + 1, what: describeStep(s), outcome: 'not_run' as const }))
  let stopped: string | undefined

  for (const [i, step] of steps.entries()) {
    const o = out[i]
    const now = await client.currentScene().catch(() => undefined)
    if (now !== expected) {
      stopped = `Before step ${o.number}, the scene on screen was not the one this cue left it on. Someone else changed it, so the cue stopped and left their choice alone.`
      break
    }
    try {
      if (step.do === 'wait') {
        await sleep(step.seconds * 1000)
        o.outcome = 'verified'
      } else if (step.do === 'scene') {
        const target = resolveItem(scenes, step.scene, 'scene')
        if (await client.switchScene(target.id)) { o.outcome = 'verified'; expected = target.id }
        else { o.outcome = 'failed'; o.detail = 'Ecamm did not switch to that scene.' }
      } else if (step.do === 'overlay') {
        const ov = resolveItem(await client.overlays(), step.overlay, 'overlay')
        const want = step.state === 'show'
        const r = await client.setOverlayVisible(ov.id, want)
        if (r.after === want) o.outcome = 'verified'
        else { o.outcome = 'failed'; o.detail = `Ecamm still lists "${ov.title}" as ${r.after ? 'showing' : 'hidden'}.` }
      } else if (step.do === 'overlay_text') {
        const ov = resolveItem(await client.overlays(), step.overlay, 'overlay')
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
        const after = Number(scalar(await client.get('getVolume', { bus })))
        if (after === want) o.outcome = 'verified'
        else { o.outcome = 'failed'; o.detail = `Ecamm reports ${step.bus} at ${Number.isFinite(after) ? after : 'an unreadable level'}.` }
      }
    } catch (err) {
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
