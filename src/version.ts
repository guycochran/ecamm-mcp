/** Single source for the version. test/unit.test.ts checks it matches package.json. */
export const VERSION = '0.3.0'

declare const __ECAMM_BUILD__: { commit: string | null; dirty: boolean | null }
/** Bundles embed provenance; a plain TypeScript build must not guess its Git revision. */
export const BUILD_INFO = {
  version: VERSION,
  packaging: typeof __ECAMM_BUILD__ === 'undefined' ? 'unbundled' : 'bundle',
  ...(typeof __ECAMM_BUILD__ === 'undefined' ? { commit: null, dirty: null } : __ECAMM_BUILD__),
}
