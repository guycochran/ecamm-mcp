import { describe, expect, it } from 'vitest'
import { EcammClient, flatten, resolveItem, scalar, summarizeInfo } from '../src/client.js'
import { chooseInstance } from '../src/discovery.js'
import { buildQuery } from '../src/http.js'
import { startFake } from './fake-ecamm.js'
import { mkdtempSync } from 'node:fs'
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
    await expect(c.scenes()).rejects.toThrow(/Settings > Remote Control/)
    expect(fake.state.permission).toBe('Pending')
    fake.state.permission = 'Allowed' // human clicks approve
    expect((await c.scenes()).length).toBe(4)
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
