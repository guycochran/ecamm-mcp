#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { EcammClient } from './client.js'
import { runCli } from './cli.js'
import { envValue, truthy } from './env.js'
import { registerTools } from './tools.js'
import { VERSION } from './version.js'
import { registerWorkflowTools } from './workflow-tools.js'
import { runRecordingCli } from './recording-cli.js'

const positiveMs = (seconds: string | undefined) => {
  const n = Number(seconds)
  return seconds !== undefined && Number.isFinite(n) && n > 0 ? n * 1000 : undefined
}

async function serve() {
  const env = process.env
  const waitS = Number(envValue(env.ECAMM_APPROVAL_WAIT_S) ?? 25)
  const client = new EcammClient({
    host: envValue(env.ECAMM_HOST),
    hostname: envValue(env.ECAMM_HOSTNAME),
    clientName: envValue(env.ECAMM_CLIENT_NAME),
    approvalWaitMs: Number.isFinite(waitS) && waitS >= 0 ? waitS * 1000 : 25_000,
    transitionTimeoutMs: positiveMs(envValue(env.ECAMM_TRANSITION_TIMEOUT_S)),
  })

  const server = new McpServer(
    { name: 'ecamm-mcp', version: VERSION },
    {
      instructions:
        'Controls Ecamm Live on a Mac through its local Remote API. Start with ecamm_status, or ecamm_prepare_session for an intent-aware preparation report. ' +
        'Recording-file tools are local, opt-in, and read-only. A completion notification or metadata check is not proof that all tracks were captured or audio is usable. ' +
        'On the first connection Ecamm Live shows an Allow / Deny dialog; the user must click Allow ' +
        '(or tick the client in Ecamm Live > Settings > Remote Control). ' +
        'Tools marked on-air (go live/end, recording, public comments, profiles, Zoom meeting control) return a dry run unless confirm: true. ' +
        'Only pass confirm: true when the user has clearly asked for that exact action. ' +
        'Going live, recording and ending take an explicit intent (go_live, record or end), never a bare click, so repeating a request cannot undo it. ' +
        'Results say whether an outcome was verified by reading Ecamm back, or only accepted.',
    },
  )

  registerTools(server, client, { readOnly: truthy(env.ECAMM_READ_ONLY) })
  registerWorkflowTools(server, client)
  await server.connect(new StdioServerTransport())
}

// No arguments = MCP server on stdio (how Claude runs it). Arguments = setup / doctor / help.
const args = process.argv.slice(2)
const run = args.length
  ? (args[0] === 'recording-complete' ? runRecordingCli(args) : runCli(args)).then((code) => process.exit(code))
  : serve()
run.catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
