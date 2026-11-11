import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ecamm-release-test-'))
  dirs.push(dir)
  const bin = join(dir, 'bin'); mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  return { dir, bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ECAMM_MCP_FORCE: '1', ECAMM_MCP_REF: '', ECAMM_MCP_OWN_NODE: '', ECAMM_MCP_DIR: join(dir, 'installed'), TEST_ROOT: dir } }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('release installer integrity', () => {
  for (const mode of ['valid', 'missing', 'network', 'mismatch', 'duplicate', 'malformed']) {
    it(`${mode} checksum: only verified downloads execute or replace the install`, () => {
      const f = fixture()
      const payload = `require('fs').appendFileSync(process.env.TEST_ROOT+'/executed','x'); console.log('0.3.0');`
      writeFileSync(join(f.dir, 'payload'), payload)
      const digest = createHash('sha256').update(payload).digest('hex')
      writeFileSync(join(f.dir, 'sums'), mode === 'mismatch' ? `${'0'.repeat(64)}  ecamm-mcp.cjs\n`
        : mode === 'duplicate' ? `${digest}  ecamm-mcp.cjs\n${digest}  ecamm-mcp.cjs\n`
          : mode === 'malformed' ? 'not-a-hash  ecamm-mcp.cjs\n' : `${digest}  ecamm-mcp.cjs\n`)
      mkdirSync(f.env.ECAMM_MCP_DIR)
      const installed = join(f.env.ECAMM_MCP_DIR, 'ecamm-mcp.cjs')
      writeFileSync(installed, 'previous installation')
      writeFileSync(join(f.bin, 'curl'), `#!/bin/bash
set -eu
url=''; out=''
while [ "$#" -gt 0 ]; do
 case "$1" in -o) out="$2"; shift 2;; https://*) url="$1"; shift;; *) shift;; esac
done
printf '%s\\n' "$url" >> "$TEST_ROOT/urls"
case "$url" in
 https://api.github.com/repos/guycochran/ecamm-mcp/releases/latest) printf '%s' '{"tag_name":"v0.3.0","draft":false,"prerelease":false}' > "$out";;
 https://github.com/guycochran/ecamm-mcp/releases/download/v0.3.0/ecamm-mcp.cjs) cp "$TEST_ROOT/payload" "$out";;
 https://github.com/guycochran/ecamm-mcp/releases/download/v0.3.0/SHA256SUMS.txt)
   [ "$TEST_MODE" != missing ] || exit 22
   [ "$TEST_MODE" != network ] || exit 7
   cp "$TEST_ROOT/sums" "$out";;
 *) exit 99;;
esac
`, { mode: 0o700 })
      const result = spawnSync('bash', [resolve('install.sh'), '--no-open', '--no-claude'], { env: { ...f.env, TEST_MODE: mode }, encoding: 'utf8', timeout: 10000 })
      if (mode === 'valid') {
        expect(result.status, result.stderr).toBe(0)
        expect(readFileSync(installed, 'utf8')).toBe(payload)
        expect(readFileSync(join(f.dir, 'executed'), 'utf8')).toBe('xx') // version, then setup
      } else {
        expect(result.status).not.toBe(0)
        expect(readFileSync(installed, 'utf8')).toBe('previous installation')
        expect(existsSync(join(f.dir, 'executed'))).toBe(false)
      }
      expect(readFileSync(join(f.dir, 'urls'), 'utf8')).not.toContain('/latest/download/')
    })
  }
})

describe('draft release boundary', () => {
  for (const mode of ['published', 'draft', 'absent']) {
    it(`${mode}: never uploads to a published release or creates a public one`, () => {
      const f = fixture()
      writeFileSync(join(f.bin, 'gh'), `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_ROOT/gh-calls"
if [ "$2" = view ]; then
 case "$TEST_MODE" in published) echo false;; draft) echo true;; absent) exit 1;; esac
fi
`, { mode: 0o700 })
      const result = spawnSync('bash', [resolve('scripts/draft-release.sh')], { cwd: f.dir, env: { ...f.env, GITHUB_REF_NAME: 'v0.3.0', TEST_MODE: mode }, encoding: 'utf8', timeout: 10000 })
      const calls = readFileSync(join(f.dir, 'gh-calls'), 'utf8')
      if (mode === 'published') {
        expect(result.status).not.toBe(0)
        expect(calls).not.toMatch(/release (upload|create)/)
      } else {
        expect(result.status, result.stderr).toBe(0)
        if (mode === 'draft') expect(calls).toContain('release upload v0.3.0')
        else expect(calls).toMatch(/release create v0.3.0 .* --draft /)
      }
    })
  }
})
