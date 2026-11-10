import { execFile } from 'node:child_process'
import { Bonjour } from 'bonjour-service'

/**
 * Ports Ecamm Live is listening on, found with lsof on this Mac.
 *
 * Why: macOS Local Network privacy blocks Bonjour for a Node process launched by Claude
 * desktop (Terminal has the permission, the child process does not), so discovery comes
 * back empty. Loopback needs no such permission, so when Ecamm is on this Mac we find its
 * port locally and skip the network entirely.
 */
export type LocalPortsFn = () => Promise<number[]>

export function parseLsofPorts(output: string): number[] {
  const ports = new Set<number>()
  for (const line of output.split('\n')) {
    // -F output: "n*:64364", "n127.0.0.1:64364", "n[::1]:64364"
    const m = /^n.*:(\d+)$/.exec(line.trim())
    if (m) ports.add(Number(m[1]))
  }
  return [...ports]
}

export const localEcammPorts: LocalPortsFn = () =>
  new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve([])
    execFile(
      '/usr/sbin/lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', 'Ecamm', '-Fn'],
      { timeout: 3000 },
      // lsof exits 1 when nothing matches; that just means no ports.
      (_err, stdout) => resolve(parseLsofPorts(String(stdout ?? ''))),
    )
  })

/** Ecamm publishes _ecammliveremote._tcp and binds a NEW port on every launch. */
export interface DiscoveredEcamm {
  name: string
  hostname: string
  addresses: string[]
  port: number
}

export type DiscoverFn = (windowMs: number) => Promise<DiscoveredEcamm[]>

const isIpv4 = (a: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)

export const discoverEcamm: DiscoverFn = async (windowMs) => {
  const bonjour = new Bonjour()
  const found = new Map<string, DiscoveredEcamm>()
  const browser = bonjour.find({ type: 'ecammliveremote', protocol: 'tcp' }, (svc) => {
    const addresses = (svc.addresses ?? []).filter(isIpv4)
    if (!addresses.length || !svc.port) return
    found.set(svc.fqdn, {
      name: svc.name,
      hostname: (svc.host ?? '').replace(/\.$/, ''),
      addresses,
      port: svc.port,
    })
  })
  try {
    await new Promise((r) => setTimeout(r, windowMs))
  } finally {
    browser.stop()
    bonjour.destroy()
  }
  return [...found.values()]
}

/**
 * Picks which Ecamm to talk to. Never guesses between several Macs: driving the wrong
 * machine's show is worse than refusing.
 *   1. ECAMM_HOSTNAME if set (e.g. "Guys-Mac-mini.local")
 *   2. this machine's own hostname (MCP running on the Ecamm Mac, the normal case)
 *   3. the only instance, if exactly one was found
 */
export function chooseInstance(
  found: DiscoveredEcamm[],
  want: { hostname?: string; localHostname?: string },
): { pick?: DiscoveredEcamm; reason: string } {
  const norm = (s: string) => s.toLowerCase().replace(/\.local$/, '').replace(/\.$/, '')
  if (!found.length) return { reason: 'No Ecamm Live found via Bonjour. Is Ecamm Live running?' }
  if (want.hostname) {
    const hit = found.find((f) => norm(f.hostname) === norm(want.hostname!))
    return hit
      ? { pick: hit, reason: 'matched ECAMM_HOSTNAME' }
      : { reason: `ECAMM_HOSTNAME "${want.hostname}" not found. Saw: ${found.map((f) => f.hostname).join(', ')}` }
  }
  if (want.localHostname) {
    const hit = found.find((f) => norm(f.hostname) === norm(want.localHostname!))
    if (hit) return { pick: hit, reason: 'matched this Mac' }
  }
  if (found.length === 1) return { pick: found[0], reason: 'only instance on the network' }
  return {
    reason: `Found ${found.length} Ecamm Live instances (${found
      .map((f) => f.hostname)
      .join(', ')}). Set ECAMM_HOSTNAME to pick one.`,
  }
}
