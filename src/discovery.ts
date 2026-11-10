import { Bonjour } from 'bonjour-service'

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
