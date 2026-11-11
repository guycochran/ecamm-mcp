/**
 * Terminal commands for people, not for Claude:
 *   ecamm-mcp setup    connect Claude desktop and get the Allow dialog up in Ecamm Live
 *   ecamm-mcp doctor   print what's working and what isn't (paste this when asking for help)
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { EcammClient, type Permission } from './client.js'
import { envValue } from './env.js'
import { VERSION } from './version.js'

const say = (s = '') => console.log(s)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const claudeConfigPath = (home = homedir()) =>
  join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')

export interface ServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface ConfigResult {
  status: 'written' | 'unchanged' | 'no-claude' | 'unreadable'
  path: string
  backup?: string
  detail?: string
}

/**
 * Adds (or updates) the "ecamm" server in Claude desktop's config. Leaves every other
 * setting alone, keeps a backup, and refuses to touch a file it can't parse.
 */
export function writeClaudeConfig(entry: ServerEntry, path = claudeConfigPath()): ConfigResult {
  if (!existsSync(dirname(path))) return { status: 'no-claude', path }
  let config: Record<string, unknown> = {}
  let backup: string | undefined
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8')
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
        config = parsed as Record<string, unknown>
      } catch (err) {
        return { status: 'unreadable', path, detail: err instanceof Error ? err.message : String(err) }
      }
    }
    const servers = config.mcpServers as Record<string, unknown> | undefined
    const previous = servers?.ecamm as ServerEntry | undefined
    if (previous?.env && typeof previous.env === 'object' && !Array.isArray(previous.env)) {
      entry = { ...entry, env: { ...previous.env, ...entry.env } }
    }
    if (servers && JSON.stringify(servers.ecamm) === JSON.stringify(entry)) return { status: 'unchanged', path }
    backup = `${path}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(path, backup)
  }
  const servers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {}
  config.mcpServers = { ...servers, ecamm: entry }
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return { status: 'written', path, backup }
}

/** Removes the "ecamm" server from Claude desktop's config (with a backup). */
export function removeFromClaudeConfig(path = claudeConfigPath()): ConfigResult {
  if (!existsSync(path)) return { status: 'no-claude', path }
  let config: Record<string, unknown>
  try {
    config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (err) {
    return { status: 'unreadable', path, detail: err instanceof Error ? err.message : String(err) }
  }
  const servers = config?.mcpServers as Record<string, unknown> | undefined
  if (!servers || typeof servers !== 'object' || !('ecamm' in servers)) return { status: 'unchanged', path }
  const backup = `${path}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(path, backup)
  delete servers.ecamm
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return { status: 'written', path, backup }
}

const selfPath = () => {
  try { return realpathSync(process.argv[1]) } catch { return process.argv[1] }
}

const openEcamm = () =>
  new Promise<boolean>((resolve) => {
    if (process.platform !== 'darwin') return resolve(false)
    execFile('/usr/bin/open', ['-a', 'Ecamm Live'], { timeout: 10_000 }, (err) => resolve(!err))
  })

async function findEcamm(client: EcammClient, tries: number): Promise<boolean> {
  const pinned = Boolean(envValue(process.env.ECAMM_HOST))
  for (let i = 0; i < tries; i++) {
    try {
      // A fixed ECAMM_HOST skips discovery, so just check that it answers.
      if (pinned) await client.permission()
      else await client.locate()
      return true
    } catch { /* not up yet */ }
    if (i < tries - 1) await sleep(1000)
  }
  return false
}

/** Fires the request that makes Ecamm show its Allow / Deny dialog, then waits for the click. */
async function getApproved(client: EcammClient, waitMs: number): Promise<Permission> {
  let perm = await client.permission()
  if (perm === 'Not Found') {
    try { await client.http.get('getInfo') } catch { /* the request is what registers us */ }
    perm = await client.permission()
  }
  if (perm === 'Allowed' || perm === 'Denied') return perm
  say()
  say('  >>> Look at Ecamm Live now. It is asking:')
  say(`      "${client.clientName} Wants To Control Ecamm"`)
  say('      Click Allow.')
  say()
  say('      (No dialog? Ecamm Live > Settings > Remote Control, tick the box.)')
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(1000)
    perm = await client.permission()
    if (perm === 'Allowed' || perm === 'Denied') break
  }
  return perm
}

function newClient() {
  const env = process.env
  return new EcammClient({
    host: envValue(env.ECAMM_HOST),
    hostname: envValue(env.ECAMM_HOSTNAME),
    clientName: envValue(env.ECAMM_CLIENT_NAME),
  })
}

async function setup(flags: Set<string>): Promise<number> {
  say(`ecamm-mcp ${VERSION} setup`)
  say()

  // 1. Claude desktop
  if (flags.has('--no-claude')) {
    say('1. Claude desktop: skipped (--no-claude)')
  } else {
    const entry: ServerEntry = { command: process.execPath, args: [selfPath()] }
    const r = writeClaudeConfig(entry)
    if (r.status === 'written') {
      say('1. Claude desktop: connected.')
      if (r.backup) say(`   (Your old config is saved at ${r.backup})`)
    } else if (r.status === 'unchanged') {
      say('1. Claude desktop: already connected.')
    } else if (r.status === 'no-claude') {
      say('1. Claude desktop: not found on this Mac. Get it at https://claude.ai/download and run this again.')
      say('   Using another MCP app? Point it at this command:')
      say(`   "${entry.command}" "${entry.args[0]}"`)
    } else {
      say(`1. Claude desktop: could not read ${r.path} (${r.detail}).`)
      say('   Nothing was changed. Fix or remove that file and run this again, or add this by hand under "mcpServers":')
      say(`   "ecamm": ${JSON.stringify(entry)}`)
    }
  }

  // 2. Ecamm Live approval
  const client = newClient()
  let found = await findEcamm(client, 1)
  if (!found && !flags.has('--no-open')) {
    say('2. Ecamm Live is not running. Opening it...')
    if (await openEcamm()) found = await findEcamm(client, 45)
  }
  if (!found) {
    say('2. Ecamm Live: not found. That is fine for now.')
    say('   Open Ecamm Live, then ask Claude "what is my Ecamm status?" and click Allow when Ecamm asks.')
  } else {
    const perm = await getApproved(client, 180_000)
    if (perm === 'Allowed') say('2. Ecamm Live: allowed. Claude can control Ecamm on this Mac.')
    else if (perm === 'Denied') {
      say('2. Ecamm Live: this was denied. Turn it on in Ecamm Live > Settings > Remote Control.')
    } else {
      say('2. Ecamm Live: still waiting for Allow. You can click it any time, or tick the box in')
      say('   Ecamm Live > Settings > Remote Control.')
    }
  }

  say()
  say('Last step: quit Claude completely (Cmd+Q) and open it again.')
  say('Then ask Claude: "What\'s my Ecamm status?"')
  return 0
}

async function doctor(): Promise<number> {
  say(`ecamm-mcp ${VERSION} doctor`)
  say(`  node        ${process.version} (${process.execPath})`)
  say(`  platform    ${process.platform} ${process.arch}`)
  say(`  server      ${selfPath()}`)

  const cfg = claudeConfigPath()
  let claude = 'config not found (Claude desktop not installed, or you use the extension)'
  if (existsSync(cfg)) {
    try {
      const entry = (JSON.parse(readFileSync(cfg, 'utf8')).mcpServers ?? {}).ecamm
      claude = entry ? `connected -> ${[entry.command, ...(entry.args ?? [])].join(' ')}` : 'config found, no "ecamm" entry (run setup)'
    } catch {
      claude = `config is not valid JSON: ${cfg}`
    }
  }
  say(`  claude      ${claude}`)

  const client = newClient()
  let ok = false
  try {
    if (!(await findEcamm(client, 1))) await client.locate() // rethrows with the real reason
    say(`  ecamm       found at ${client.target.host}`)
    const perm = await client.permission()
    say(`  permission  ${perm}${perm === 'Allowed' ? '' : '  <- allow it in Ecamm Live > Settings > Remote Control'}`)
    if (perm === 'Allowed') {
      const info = await client.info()
      say(`  button      ${String(info.ButtonLabel ?? '?')}`)
      ok = true
    }
  } catch (err) {
    say(`  ecamm       ${err instanceof Error ? err.message : String(err)}`)
  }
  say()
  say(ok ? 'All good.' : 'Not ready yet. See the lines above.')
  return ok ? 0 : 1
}

function uninstall(): number {
  const r = removeFromClaudeConfig()
  if (r.status === 'written') say('Removed Ecamm from Claude desktop. Quit and reopen Claude.')
  else if (r.status === 'unreadable') say(`Could not read ${r.path} (${r.detail}). Remove the "ecamm" entry by hand.`)
  else say('Claude desktop had no Ecamm entry.')
  say(`To finish, delete the folder ${join(homedir(), '.ecamm-mcp')}`)
  say('and untick "Claude (ecamm-mcp)" in Ecamm Live > Settings > Remote Control.')
  return 0
}

const HELP = `ecamm-mcp ${VERSION}  MCP server for Ecamm Live

  ecamm-mcp            run the MCP server (this is what Claude runs; you rarely need it)
  ecamm-mcp setup      connect Claude desktop and bring up the Allow dialog in Ecamm Live
                         --no-claude   don't touch Claude desktop's config
                         --no-open     don't launch Ecamm Live if it's closed
  ecamm-mcp doctor     check the connection (paste the output when asking for help)
  ecamm-mcp recording-doctor  check local recording folders, inbox, and ffprobe
  ecamm-mcp recording-complete [--path-stdin]  save a completion event from stdin
  ecamm-mcp uninstall  disconnect from Claude desktop
  ecamm-mcp --version
`

export async function runCli(args: string[]): Promise<number> {
  const [cmd, ...rest] = args
  const flags = new Set(rest)
  switch (cmd) {
    case 'setup': return setup(flags)
    case 'doctor': return doctor()
    case 'uninstall': return uninstall()
    case '--version': case '-v': say(VERSION); return 0
    case '--help': case '-h': case 'help': say(HELP); return 0
    default:
      console.error(`Unknown command "${cmd}".\n`)
      console.error(HELP)
      return 2
  }
}
