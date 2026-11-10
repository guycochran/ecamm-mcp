#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { EcammClient } from './client.js'
import { runCli } from './cli.js'
import { envValue, truthy } from './env.js'
import { registerTools } from './tools.js'
import { VERSION } from './version.js'

async function serve() {
  const env = process.env
  const waitS = Number(envValue(env.ECAMM_APPROVAL_WAIT_S) ?? 25)
  const client = new EcammClient({
    host: envValue(env.ECAMM_HOST),
    hostname: envValue(env.ECAMM_HOSTNAME),
    clientName: envValue(env.ECAMM_CLIENT_NAME),
    approvalWaitMs: Number.isFinite(waitS) && waitS >= 0 ? waitS * 1000 : 25_000,
  })

  const server = new McpServer(
    { name: 'ecamm-mcp', version: VERSION },
    {
      instructions:
        'Controls Ecamm Live on a Mac through its local Remote API. Start with ecamm_status, or ecamm_preflight before a show. ' +
        'On the first connection Ecamm Live shows an Allow / Deny dialog; the user must click Allow ' +
        '(or tick the client in Ecamm Live > Settings > Remote Control). ' +
        'Tools marked on-air (go live/end, recording, public comments, profiles, Zoom meeting control) return a dry run unless confirm: true. ' +
        'Only pass confirm: true when the user has clearly asked for that exact action.',
    },
  )

  registerTools(server, client, { readOnly: truthy(env.ECAMM_READ_ONLY) })
  await server.connect(new StdioServerTransport())
}

// No arguments = MCP server on stdio (how Claude runs it). Arguments = setup / doctor / help.
const args = process.argv.slice(2)
const run = args.length ? runCli(args).then((code) => process.exit(code)) : serve()
run.catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
