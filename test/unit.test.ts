import { describe, expect, it } from 'vitest'
import { EcammClient, flatten, resolveItem, scalar, summarizeInfo } from '../src/client.js'
import { chooseInstance, parseLsofPorts } from '../src/discovery.js'
import { buildQuery } from '../src/http.js'
import { startFake } from './fake-ecamm.js'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { removeFromClaudeConfig, writeClaudeConfig } from '../src/cli.js'
import { envValue, truthy } from '../src/env.js'
import { VERSION } from '../src/version.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('helpers', () => {
  it('buildQuery uses %20 not +', () => {
    expect(buildQuery({ text: 'a b&c', skip: undefined })).toBe('?text=a%20b%26c')
  })
  it('scalar unwraps', () => {
    expect(scalar(['Allowed'])).toBe('Allowed')
    expect(scalar({})).toBe('')
  })
  it('flatten handles groups and placeholders', () => {
    const items = flatten({ items: [{ title: 'G', UUID: 'g', Group: true, Children: [{ title: 'A', UUID: 'a' }] }, { title: '-No recent items-', UUID: '' }] })
    expect(items).toEqual([{ id: 'a', title: 'A', group: 'G' }])
  })
  it('resolveItem prefers exact over partial', () => {
    const items = [{ id: '1', title: 'Cam' }, { id: '2', title: 'Cam Wide' }]
    expect(resolveItem(items, 'cam', 'camera').id).toBe('1')
    expect(resolveItem(items, 'wide', 'camera').id).toBe('2')
    expect(() => resolveItem(items, 'zzz', 'camera')).toThrow(/No camera/)
  })
  it('summarizeInfo groups audio', () => {
    const s = summarizeInfo({ VOLUME_MIC: '80', MUTE_MIC: 'yes', Mute: 'no', ZoomInMeeting: 'yes', Viewers: '3' })
    expect(s.audio.mic).toEqual({ volume: '80', muted: true })
    expect(s.zoom).toEqual({ ZoomInMeeting: 'yes' })
    expect(s.general.Viewers).toBe('3')
  })
})

describe('chooseInstance', () => {
  const a = { name: 'Ecamm Live Remote', hostname: 'Mac-Mini-M2.local', addresses: ['192.168.9.20'], port: 59089 }
  const b = { name: 'Ecamm Live Remote (2)', hostname: 'Mac-Mini-M4.local', addresses: ['192.168.8.151'], port: 60001 }
  it('prefers this Mac', () => expect(chooseInstance([a, b], { localHostname: 'Mac-Mini-M4' }).pick).toBe(b))
  it('honors ECAMM_HOSTNAME', () => expect(chooseInstance([a, b], { hostname: 'mac-mini-m2.local' }).pick).toBe(a))
  it('refuses to guess between two', () => expect(chooseInstance([a, b], {}).pick).toBeUndefined())
  it('takes a lone instance', () => expect(chooseInstance([a], {}).pick).toBe(a))
})

describe('approval flow', () => {
  it('registers then tells the user to approve when pending', async () => {
    const fake = await startFake()
    fake.state.autoApprove = false
    const c = new EcammClient({ host: `127.0.0.1:${fake.port}`, stateDir: mkdtempSync(join(tmpdir(), 'ec-')) })
    await expect(c.scenes()).rejects.toThrow(/click Allow.*Settings > Remote Control/)
    expect(fake.state.permission).toBe('Pending')
    fake.state.permission = 'Allowed' // human clicks approve
    expect((await c.scenes()).length).toBe(4)
    fake.server.close()
  })

  it('waits for the Allow click so the first call succeeds', async () => {
    const fake = await startFake()
    fake.state.autoApprove = false
    const c = new EcammClient({
      host: `127.0.0.1:${fake.port}`, stateDir: mkdtempSync(join(tmpdir(), 'ec-')), approvalWaitMs: 5000,
    })
    setTimeout(() => { fake.state.permission = 'Allowed' }, 300) // human clicks Allow mid-call
    expect((await c.scenes()).length).toBe(4)
    fake.server.close()
  })

  it('stops waiting as soon as the user clicks Deny', async () => {
    const fake = await startFake()
    fake.state.autoApprove = false
    const c = new EcammClient({
      host: `127.0.0.1:${fake.port}`, stateDir: mkdtempSync(join(tmpdir(), 'ec-')), approvalWaitMs: 20_000,
    })
    setTimeout(() => { fake.state.permission = 'Denied' }, 200)
    const started = Date.now()
    await expect(c.scenes()).rejects.toThrow(/denied/)
    expect(Date.now() - started).toBeLessThan(5000)
    fake.server.close()
  })

  it('rediscovers when Ecamm relaunches on a new port', async () => {
    const dead = await startFake()
    const deadPort = dead.port
    await new Promise((r) => dead.server.close(r))
    const live = await startFake()
    let browses = 0
    const c = new EcammClient({
      stateDir: mkdtempSync(join(tmpdir(), 'ec-')),
      localPorts: async () => [],
      discover: async () => {
        browses++
        const port = browses === 1 ? deadPort : live.port
        return [{ name: 'Ecamm Live Remote', hostname: 'only-mac.local', addresses: ['127.0.0.1'], port }]
      },
    })
    expect((await c.scenes()).length).toBe(4)
    expect(browses).toBe(2)
    expect(c.target.host).toBe(`127.0.0.1:${live.port}`)
    live.server.close()
  })

  it('persists the client UUID so Ecamm does not re-ask', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ec-'))
    const h1 = new EcammClient({ stateDir: dir }).http.headers()['EcammLive-UUID']
    const h2 = new EcammClient({ stateDir: dir }).http.headers()['EcammLive-UUID']
    expect(h1).toBe(h2)
  })
})

describe('loopback discovery (no Bonjour, no Local Network permission)', () => {
  it('parses lsof -F output', () => {
    expect(parseLsofPorts('p123\ncEcamm Live\nf9\nn*:64364\nf10\nn127.0.0.1:64364\nn[::1]:50000\n')).toEqual([64364, 50000])
    expect(parseLsofPorts('')).toEqual([])
  })

  it('uses the local port that answers the Remote API and never browses', async () => {
    const live = await startFake()
    let browsed = false
    const c = new EcammClient({
      stateDir: mkdtempSync(join(tmpdir(), 'ec-')),
      localPorts: async () => [1, live.port], // first port is junk
      discover: async () => { browsed = true; return [] },
    })
    expect((await c.scenes()).length).toBe(4)
    expect(browsed).toBe(false)
    expect(c.target.host).toBe(`127.0.0.1:${live.port}`)
    live.server.close()
  })

  it('skips loopback when ECAMM_HOSTNAME names another Mac', async () => {
    let probed = false
    const c = new EcammClient({
      stateDir: mkdtempSync(join(tmpdir(), 'ec-')),
      hostname: 'some-other-mac.local',
      localPorts: async () => { probed = true; return [] },
      discover: async () => [],
    })
    await expect(c.scenes()).rejects.toThrow(/Local Network/)
    expect(probed).toBe(false)
  })

  it('falls back to Bonjour when nothing local answers', async () => {
    const live = await startFake()
    const c = new EcammClient({
      stateDir: mkdtempSync(join(tmpdir(), 'ec-')),
      localPorts: async () => [],
      discover: async () => [{ name: 'Ecamm Live Remote', hostname: 'only-mac.local', addresses: ['127.0.0.1'], port: live.port }],
    })
    expect((await c.scenes()).length).toBe(4)
    live.server.close()
  })
})

describe('setup: Claude desktop config', () => {
  const entry = { command: '/usr/local/bin/node', args: ['/Users/me/.ecamm-mcp/ecamm-mcp.cjs'] }
  const claudeDir = () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'claude-')), 'Claude')
    mkdirSync(dir)
    return join(dir, 'claude_desktop_config.json')
  }

  it('creates the config when Claude is installed but has none', () => {
    const path = claudeDir()
    expect(writeClaudeConfig(entry, path).status).toBe('written')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: { ecamm: entry } })
  })

  it('keeps other servers and settings, and backs up first', () => {
    const path = claudeDir()
    const before = { globalShortcut: 'Cmd+Space', mcpServers: { resolve: { command: 'node', args: ['x.js'] } } }
    writeFileSync(path, JSON.stringify(before))
    const r = writeClaudeConfig(entry, path)
    expect(r.status).toBe('written')
    expect(JSON.parse(readFileSync(r.backup!, 'utf8'))).toEqual(before)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      globalShortcut: 'Cmd+Space',
      mcpServers: { resolve: before.mcpServers.resolve, ecamm: entry },
    })
  })

  it('is a no-op the second time', () => {
    const path = claudeDir()
    writeClaudeConfig(entry, path)
    expect(writeClaudeConfig(entry, path)).toMatchObject({ status: 'unchanged' })
  })

  it('never overwrites a config it cannot parse', () => {
    const path = claudeDir()
    writeFileSync(path, '{ "mcpServers": { oops')
    expect(writeClaudeConfig(entry, path).status).toBe('unreadable')
    expect(readFileSync(path, 'utf8')).toBe('{ "mcpServers": { oops')
  })

  it('uninstall removes only the ecamm entry', () => {
    const path = claudeDir()
    writeFileSync(path, JSON.stringify({ mcpServers: { resolve: { command: 'node' } } }))
    writeClaudeConfig(entry, path)
    expect(removeFromClaudeConfig(path).status).toBe('written')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: { resolve: { command: 'node' } } })
    expect(removeFromClaudeConfig(path).status).toBe('unchanged')
  })

  it('says so when Claude desktop is not installed', () => {
    expect(writeClaudeConfig(entry, join(tmpdir(), 'nope-' + Date.now(), 'cfg.json')).status).toBe('no-claude')
  })
})

describe('env and version', () => {
  it('treats unfilled extension settings as unset', () => {
    expect(envValue('${user_config.hostname}')).toBeUndefined()
    expect(envValue('  ')).toBeUndefined()
    expect(envValue(' Mac-Mini.local ')).toBe('Mac-Mini.local')
    expect(truthy('true')).toBe(true)
    expect(truthy('1')).toBe(true)
    expect(truthy('false')).toBe(false)
    expect(truthy('${user_config.read_only}')).toBe(false)
  })

  it('version.ts, package.json and the extension manifest agree', () => {
    const read = (f: string) => JSON.parse(readFileSync(join(__dirname, '..', f), 'utf8')).version
    expect(read('package.json')).toBe(VERSION)
    expect(read('mcpb/manifest.json')).toBe(VERSION)
  })
})
