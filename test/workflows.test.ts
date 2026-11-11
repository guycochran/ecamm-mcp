import { describe, expect, it } from 'vitest'
import type { EcammClient } from '../src/client.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prepareSession, registerWorkflowTools, sessionChecks } from '../src/workflow-tools.js'

describe('session preparation', () => {
  it('does not turn absent or N/A audio fields into an unmuted claim', () => {
    for (const info of [{}, { MUTE_MIC: 'N/A' }]) {
      expect(sessionChecks(info, 'record_only').find(c => c.name === 'Primary microphone')?.status).toBe('unavailable')
    }
  })
  it('keeps recording-only preparation independent of streaming destinations', async () => {
    const client = {
      ensureReady: async () => {}, info: async () => ({ ButtonLabel: 'Record', MUTE_MIC: 'no' }),
      scenes: async () => [{ id: '1', title: 'Interview' }, { id: '2', title: 'Interview' }], cameras: async () => [],
      channels: () => { throw new Error('Must not query destinations for record-only') },
    } as unknown as EcammClient
    const result = await prepareSession(client, 'record_only', ['Interview', 'Missing'])
    expect(result.changedProduction).toBe(false)
    expect(result.checks.find(c => c.name === 'Scene: Interview')?.detail).toContain('More than one')
    expect(result.checks.find(c => c.name === 'Scene: Missing')?.detail).toContain('not found')
    expect(result.checks.some(c => c.name === 'Streaming destination')).toBe(false)
    expect(result.checks.find(c => c.name === 'Output intent')?.detail).toContain('Stream is off')
  })
  it('keeps failed reads distinct from empty lists', async () => {
    const client = { ensureReady: async () => {}, info: async () => ({}), scenes: async () => { throw new Error('offline') }, cameras: async () => [], channels: async () => [] } as unknown as EcammClient
    const result = await prepareSession(client, 'stream_and_record', ['Opening'])
    expect(result.checks.find(c => c.name === 'scenes')?.status).toBe('unavailable')
    expect(result.checks.find(c => c.name === 'Scene: Opening')?.detail).toContain('unavailable')
    expect(result.checks.find(c => c.name === 'Streaming destination')?.detail).toContain('No streaming')
  })
  it('registers only read-only workflow tools', () => {
    const tools: string[] = []
    const server = { registerTool: (name: string, config: { annotations: { readOnlyHint: boolean } }) => {
      expect(config.annotations.readOnlyHint).toBe(true); tools.push(name)
    } } as unknown as McpServer
    registerWorkflowTools(server, {} as EcammClient)
    expect(tools).toHaveLength(7)
    expect(tools).toContain('ecamm_browse_recordings')
  })
})
