#!/usr/bin/env node
// Exercise the actual desktop archive, independent of dist/ and the loose bundle.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const archive = resolve(process.argv[2] ?? join(root, 'release', 'ecamm-mcp.mcpb'))
const temp = await mkdtemp(join(tmpdir(), 'ecamm-extension-'))
const client = new Client({ name: 'extension-verification', version: '1' })
try {
  const unpacked = join(temp, 'extension')
  await mkdir(unpacked)
  // A module parent catches a missing CommonJS declaration in server/package.json.
  await writeFile(join(temp, 'package.json'), '{"type":"module"}')
  const names = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split('\n')
  assert(names.every(name => !isAbsolute(name) && !name.split('/').includes('..')), 'Archive contains an unsafe entry path')
  execFileSync('unzip', ['-q', archive, '-d', unpacked])
  const manifest = JSON.parse(await readFile(join(unpacked, 'manifest.json'), 'utf8'))
  const entry = resolve(unpacked, manifest.server.entry_point)
  const entryRelative = relative(unpacked, entry)
  assert(entryRelative && !entryRelative.startsWith(`..${sep}`) && !isAbsolute(entryRelative), 'Entry point escapes the extension')
  const config = manifest.server.mcp_config
  assert.equal(config.command, 'node')
  const args = config.args.map(arg => arg.replaceAll('${__dirname}', unpacked))
  assert.equal(resolve(args[0]), entry, 'Manifest launches a different entry point')
  assert.equal(JSON.parse(await readFile(join(dirname(entry), 'package.json'), 'utf8')).type, 'commonjs')
  const version = execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8', timeout: 10000 }).trim()
  assert.equal(version, manifest.version, 'Archive server and manifest versions differ')

  const media = join(temp, 'recordings')
  await mkdir(media)
  const movie = join(media, 'Renée & guest.mp4')
  await writeFile(movie, 'notification fixture, not media')
  const env = {
    ...process.env, ...config.env,
    ECAMM_READ_ONLY: '1', ECAMM_RECORDING_ROOTS: '',
    ECAMM_RECORDING_INBOX: join(temp, 'events'),
    ECAMM_FFPROBE: join(temp, 'not-installed-ffprobe'),
  }
  // Leave the manifest's optional recording-folder placeholder unexpanded.
  // This must disable media access rather than treating it as a real path.
  await client.connect(new StdioClientTransport({ command: process.execPath, args, cwd: unpacked, env }))
  const { tools } = await client.listTools()
  for (const name of ['ecamm_prepare_session', 'ecamm_recording_status', 'ecamm_list_recordings', 'ecamm_inspect_recording', 'ecamm_prepare_edit_handoff', 'ecamm_scene_sheet']) {
    assert(tools.some(tool => tool.name === name), `Packaged tool missing: ${name}`)
  }
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args })
    assert(!response.isError, JSON.stringify(response.content))
    return JSON.parse(response.content[0].text)
  }
  const status = await call('ecamm_recording_status')
  assert.deepEqual(status.folders, [])
  assert.equal(status.metadataInspectionConfigured, false)
  assert.equal(status.completionHook, 'not_verified')

  const notification = JSON.parse(execFileSync(process.execPath, [entry, 'recording-complete', '--path-stdin'], {
    env: { ...env, ECAMM_RECORDING_FOLDER: media }, input: movie + '\n', encoding: 'utf8', timeout: 10000,
  }))
  assert.equal(notification.duplicate, false)
  const action = execFileSync(process.execPath, [entry, 'recording-shortcut'], {
    env: { ...env, ECAMM_RECORDING_FOLDER: media }, encoding: 'utf8', timeout: 10000,
  })
  const helper = join(temp, 'completion.sh')
  await writeFile(helper, action)
  const repeated = JSON.parse(execFileSync('/bin/sh', [helper], {
    env: { ...process.env, ECAMM_RECORDING_ROOTS: '["/wrong"]' }, input: movie + '\n', encoding: 'utf8', timeout: 10000,
  }))
  assert.equal(repeated.eventId, notification.eventId)
  assert.equal(repeated.duplicate, true)
  const listed = await call('ecamm_list_recordings')
  assert.equal(listed.events[0].id, notification.eventId)
  assert.equal(await readFile(movie, 'utf8'), 'notification fixture, not media')
  console.log(`Desktop archive verified: version ${manifest.version}, ${tools.length} tools, optional settings, generated Shortcut action, completion helper, and MCP receipt listing.`)
} finally {
  await client.close()
  await rm(temp, { recursive: true, force: true })
}
