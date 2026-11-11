import { describe, expect, it } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EcammClient } from '../src/client.js'
import { registerTools } from '../src/tools.js'

// Test the server-side boundary independently of Ecamm connectivity or tool descriptions.
describe('read-only command boundary', () => {
  const registered: { name: string; readOnly: boolean; run: (args: Record<string, unknown>) => Promise<unknown> }[] = []
  const server = {
    registerTool(name: string, config: { annotations: { readOnlyHint: boolean } }, run: typeof registered[number]['run']) {
      registered.push({ name, readOnly: config.annotations.readOnlyHint, run })
    },
  } as unknown as McpServer
  const client = new Proxy({}, { get() { throw new Error('Read-only mutation reached the client') } }) as EcammClient
  registerTools(server, client, { readOnly: true })

  it.each(registered.filter((t) => !t.readOnly))('blocks $name before contacting Ecamm', async ({ run }) => {
    const result = await run({ action: 'end_for_all', confirm: true })
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('read-only mode') }] })
  })

  it.each(['panel', 'toggle_video', 'new_meeting'])('also blocks Zoom %s', async (action) => {
    const result = await registered.find((t) => t.name === 'ecamm_zoom')!.run({ action, panel: 'sharing', confirm: true })
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('read-only mode') }] })
  })
})
