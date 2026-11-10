#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { EcammClient } from './client.js'
import { registerTools } from './tools.js'
import { VERSION } from './version.js'

/** Blank, or a "${user_config.x}" placeholder the desktop extension left unfilled, both mean unset. */
const setting = (name: string): string | undefined => {
  const v = (process.env[name] ?? '').trim()
  return v && !v.startsWith('${') ? v : undefined
}
const on = (name: string) => ['1', 'true', 'yes', 'on'].includes((setting(name) ?? '').toLowerCase())

const client = new EcammClient({
  host: setting('ECAMM_HOST'),
  hostname: setting('ECAMM_HOSTNAME'),
  clientName: setting('ECAMM_CLIENT_NAME'),
})

const server = new McpServer(
  { name: 'ecamm-mcp', version: VERSION },
  {
    instructions:
      'Controls Ecamm Live on a Mac through its local Remote API. Start with ecamm_status, or ecamm_preflight before a show. ' +
      'First connection must be approved in Ecamm Live > Settings > Remote Control. ' +
      'Tools marked on-air (go live/end, recording, public comments, profiles, Zoom meeting control) return a dry run unless confirm: true. ' +
      'Only pass confirm: true when the user has clearly asked for that exact action.',
  },
)

registerTools(server, client, { readOnly: on('ECAMM_READ_ONLY') })
await server.connect(new StdioServerTransport())
