import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startFake } from './fake-ecamm.js'

it('prepares a recording-only session through MCP without any production writes', async () => {
  const fake = await startFake()
  const client = new Client({ name: 'prepare-test', version: '1' })
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [process.env.ECAMM_MCP_ENTRY ?? join(__dirname, '..', 'dist', 'index.js')],
      env: { ...process.env, ECAMM_HOST: `127.0.0.1:${fake.port}`, ECAMM_READ_ONLY: '1' } as Record<string, string>,
    }))
    const response = await client.callTool({ name: 'ecamm_prepare_session', arguments: { intent: 'record_only', scenes: ['Me (full)', 'Missing scene'] } })
    expect(response.isError).not.toBe(true)
    const result = JSON.parse((response.content as { text: string }[])[0].text)
    expect(result).toMatchObject({ changedProduction: false, intent: 'record_only' })
    expect(result.checks.find((c: { name: string }) => c.name === 'Scene: Me (full)').status).toBe('observed')
    expect(result.checks.find((c: { name: string }) => c.name === 'Scene: Missing scene').status).toBe('needs_check')
    expect(fake.state.log.some(l => l.path.startsWith('set'))).toBe(false)
    expect(fake.state.log.some(l => l.path === 'getChannels')).toBe(false)
  } finally {
    await client.close()
    await new Promise<void>(resolve => fake.server.close(() => resolve()))
  }
})
