#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { EcammClient } from './client.js'
import { registerTools } from './tools.js'

const env = process.env
const client = new EcammClient({
  host: env.ECAMM_HOST || undefined,
  hostname: env.ECAMM_HOSTNAME || undefined,
  clientName: env.ECAMM_CLIENT_NAME || undefined,
})

const server = new McpServer(
  { name: 'ecamm-mcp', version: '0.1.0' },
  {
    instructions:
      'Controls Ecamm Live on a Mac through its local Remote API. Start with ecamm_status. ' +
      'First connection must be approved in Ecamm Live > Settings > Remote Control. ' +
      'Tools marked on-air (go live/end, recording, public comments, profiles, Zoom meeting control) return a dry run unless confirm: true. ' +
      'Only pass confirm: true when the user has clearly asked for that exact action.',
  },
)

registerTools(server, client, { readOnly: env.ECAMM_READ_ONLY === '1' })
await server.connect(new StdioServerTransport())
