#!/usr/bin/env node
/**
 * Builds the two things people actually install:
 *   release/ecamm-mcp.cjs   the whole server in one file (used by install.sh)
 *   release/ecamm-mcp.mcpb  the Claude desktop extension (double-click to install)
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'release')
const stage = join(out, 'mcpb')
rmSync(out, { recursive: true, force: true })
mkdirSync(join(stage, 'server'), { recursive: true })

const bundle = join(out, 'ecamm-mcp.cjs')
await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'warning',
})

cpSync(bundle, join(stage, 'server', 'index.js'))
// Pin the module type so the bundle loads the same no matter where the extension is unpacked.
writeFileSync(join(stage, 'server', 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n')
cpSync(join(root, 'mcpb', 'manifest.json'), join(stage, 'manifest.json'))
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))

const mcpb = join(root, 'node_modules', '.bin', 'mcpb')
execFileSync(mcpb, ['validate', join(stage, 'manifest.json')], { stdio: 'inherit' })
execFileSync(mcpb, ['pack', stage, join(out, 'ecamm-mcp.mcpb')], { stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })
console.log(`\nBuilt ${bundle}\nBuilt ${join(out, 'ecamm-mcp.mcpb')}`)
