import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { expect, it, vi } from 'vitest'
import { EcammClient } from '../src/client.js'
import { runCue } from '../src/cue.js'
import { registerTools } from '../src/tools.js'

function studio() {
  return {
    scenes: vi.fn(async () => [{ id: 'one', title: 'One' }]),
    currentScene: vi.fn(async () => 'one'),
    overlays: vi.fn(async () => [{ id: 'title', title: 'Title', visible: false }]),
    set: vi.fn(async () => {}),
    get: vi.fn(async () => '20'),
    setOverlayVisible: vi.fn(async () => ({ after: true })),
  }
}
it('does nothing for an already-cancelled cue', async () => {
  const client = studio(), controller = new AbortController(); controller.abort()
  const r = await runCue(client as unknown as EcammClient, [{ do: 'volume', bus: 'mic', volume: 20 }], controller.signal)
  expect(r.completed).toBe(0); expect(r.stopped).toContain('cancelled')
  expect(client.scenes).not.toHaveBeenCalled(); expect(client.set).not.toHaveBeenCalled()
})
it('interrupts a wait without running later actions', async () => {
  vi.useFakeTimers()
  try {
    const client = studio(), controller = new AbortController()
    const running = runCue(client as unknown as EcammClient, [{ do: 'wait', seconds: 30 }, { do: 'volume', bus: 'mic', volume: 20 }], controller.signal)
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    const r = await running
    expect(r.completed).toBe(0); expect(r.steps.map(s => s.outcome)).toEqual(['not_run', 'not_run'])
    expect(r.stopped).toContain('cancelled'); expect(client.set).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
it('rechecks cancellation after resolving an overlay and before sending a change', async () => {
  const client = studio(), controller = new AbortController()
  client.overlays.mockImplementation(async () => { controller.abort(); return [{ id: 'title', title: 'Title', visible: false }] })
  const r = await runCue(client as unknown as EcammClient, [{ do: 'overlay', overlay: 'Title', state: 'show' }], controller.signal)
  expect(r.completed).toBe(0); expect(client.setOverlayVisible).not.toHaveBeenCalled()
})
it('skips a cancelled request when it reaches the mutation queue and lets the next request run', async () => {
  const client = new EcammClient({ host: '127.0.0.1:1' })
  const handlers = new Map<string, Function>()
  const server = { registerTool: (name: string, _config: unknown, handler: Function) => handlers.set(name, handler) }
  registerTools(server as unknown as McpServer, client, { readOnly: false })
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const first = client.exclusive(() => barrier)
  const controller = new AbortController()
  const waiting = handlers.get('ecamm_run_cue')!({ steps: [{ do: 'wait', seconds: 0.1 }] }, { signal: controller.signal })
  controller.abort(); release(); await first
  const r = await waiting
  expect(r.isError).toBe(true); expect(r.content[0].text).toContain('cancelled before execution')
  expect(await client.exclusive(async () => 'next request')).toBe('next request')
})
it('does not start scene refresh after cancellation', async () => {
  const client = new EcammClient({ host: '127.0.0.1:1' })
  const controller = new AbortController(); controller.abort()
  const r = await client.refreshSceneThumbnails(['one', 'two'], 'one', 3500, controller.signal)
  expect(r.restore).toBe('skipped'); expect(r.stopped).toContain('cancelled')
})
it('cancels refresh after reading a thumbnail without switching scenes', async () => {
  const client = new EcammClient({ host: '127.0.0.1:1' }), controller = new AbortController()
  client.currentScene = vi.fn(async () => 'one')
  client.info = vi.fn(async () => ({ ButtonLabel: 'New' }))
  client.sceneImage = vi.fn(async () => { controller.abort(); return undefined })
  client.switchScene = vi.fn(async () => true)
  const r = await client.refreshSceneThumbnails(['one', 'two'], 'one', 3500, controller.signal)
  expect(r.restore).toBe('skipped'); expect(client.switchScene).not.toHaveBeenCalled()
})
