import { describe, expect, it, vi } from 'vitest'
import { EcammClient, preflight, summarizeInfo } from '../src/client.js'
import { planCue, runCue } from '../src/cue.js'

function studio() {
  const overlay = { id: 'title-id', title: 'Lower third', visible: false }
  const writes: string[] = []
  const client = {
    scenes: async () => [{ id: 'scene-id', title: 'Interview' }],
    currentScene: async () => 'scene-id',
    overlays: async () => [{ ...overlay }],
    setOverlayText: async (_id: string, text: string) => { overlay.title = text; writes.push('text'); return true },
    setOverlayVisible: async (id: string, visible: boolean) => { expect(id).toBe(overlay.id); overlay.visible = visible; writes.push('visibility'); return { after: visible } },
    set: async () => { writes.push('volume') },
    get: async () => [],
  } as unknown as EcammClient
  return { client, writes, overlay }
}

describe('cue integration edge cases', () => {
  it('keeps the same overlay reference after setting text changes its displayed name', async () => {
    const { client, writes } = studio()
    const result = await runCue(client, [
      { do: 'overlay_text', overlay: 'Lower third', text: 'Renée' },
      { do: 'overlay', overlay: 'Lower third', state: 'show' },
    ])
    expect(result.completed).toBe(2)
    expect(writes).toEqual(['text', 'visibility'])
  })
  it('does not reject a future overlay name before the text step has run', async () => {
    const { client } = studio()
    const plan = await planCue(client, [
      { do: 'overlay_text', overlay: 'Lower third', text: 'Renée' },
      { do: 'overlay', overlay: 'Renée', state: 'show' },
    ])
    expect(plan.ok).toBe(true)
    expect(plan.steps[1].checked).toBe('later')
  })
  it('does not retarget a different overlay if the bound overlay disappears', async () => {
    const { client, writes } = studio()
    client.setOverlayText = async () => {
      writes.push('text')
      client.overlays = async () => [{ id: 'replacement', title: 'Lower third', visible: false }]
      return true
    }
    const result = await runCue(client, [
      { do: 'overlay_text', overlay: 'Lower third', text: 'Renée' },
      { do: 'overlay', overlay: 'Lower third', state: 'show' },
    ])
    expect(result.steps[1].outcome).toBe('failed')
    expect(writes).toEqual(['text'])
  })
  it('does not verify a zero volume from an empty API reply', async () => {
    const { client } = studio()
    const result = await runCue(client, [{ do: 'volume', bus: 'mic', volume: 0 }])
    expect(result.steps[0].outcome).toBe('failed')
  })
  it('refuses to run when the starting scene cannot be identified', async () => {
    const { client, writes } = studio()
    client.currentScene = async () => ''
    expect((await planCue(client, [{ do: 'volume', bus: 'mic', volume: 20 }])).ok).toBe(false)
    const result = await runCue(client, [{ do: 'volume', bus: 'mic', volume: 20 }])
    expect(result.completed).toBe(0)
    expect(writes).toEqual([])
  })
})

describe('unknown toggle state', () => {
  it('keeps explicit N/A states and missing overlay visibility unknown in preflight', () => {
    const result = preflight({ info: { ButtonLabel: 'Record', Mute: 'N/A', MUTE_MIC: 'N/A', VOLUME_MIC: 'N/A', PreviewMode: 'N/A' },
      sceneTitle: 'Interview', overlays: [{ title: 'Title' }], destinations: [] })
    expect(result.verdict).toBe('incomplete')
    expect(result.checks.filter(c => c.status === 'unknown').map(c => c.check)).toEqual(['Main output', 'Mic', 'Preview mode', 'Overlays'])
    expect(summarizeInfo({ MUTE_MIC: 'N/A', Mute: 'N/A' })).toMatchObject({ mainMuted: undefined, audio: { mic: { muted: undefined } } })
  })
  it('reports an unknown result after a mute request instead of claiming unmuted', async () => {
    const client = Object.create(EcammClient.prototype) as EcammClient
    client.get = vi.fn().mockResolvedValue(['yes'])
    client.set = vi.fn()
    Object.defineProperty(client, 'http', { value: { get: async () => ['N/A'] } })
    await expect(client.setMuted('mic', false)).rejects.toThrow(/outcome is unknown/)
    expect(client.set).toHaveBeenCalledTimes(1)
  })
  it('never toggles a microphone whose current state is N/A', async () => {
    const client = Object.create(EcammClient.prototype) as EcammClient
    client.get = vi.fn().mockResolvedValue(['N/A'])
    client.set = vi.fn()
    await expect(client.setMuted('mic', true)).rejects.toThrow(/unknown|unavailable|unreadable/i)
    expect(client.set).not.toHaveBeenCalled()
  })
  it('never toggles an overlay with unknown visibility', async () => {
    const client = Object.create(EcammClient.prototype) as EcammClient
    client.overlays = async () => [{ id: 'overlay', title: 'Title' }]
    client.set = vi.fn()
    await expect(client.setOverlayVisible('overlay', true)).rejects.toThrow(/unknown|unavailable|unreadable/i)
    expect(client.set).not.toHaveBeenCalled()
  })
  it('does not interpret an overlay disappearing as verified hidden', async () => {
    const client = Object.create(EcammClient.prototype) as EcammClient
    client.overlays = vi.fn().mockResolvedValueOnce([{ id: 'overlay', title: 'Title', visible: true }]).mockResolvedValue([])
    client.set = vi.fn()
    expect((await client.setOverlayVisible('overlay', false)).after).toBeUndefined()
  })
})
