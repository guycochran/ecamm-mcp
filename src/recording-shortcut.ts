import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { RecordingOptions } from './recordings.js'

/** Quote fixed configuration only. The incoming recording path stays on stdin. */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Configuration paths cannot contain NUL bytes.')
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** Generate, but do not install or run, a portable Shortcuts shell action. */
export async function recordingShortcut(opts: RecordingOptions, node: string, entry: string): Promise<string> {
  if (!opts.roots.length) throw new Error('Set a recording folder before generating the completion helper.')
  const roots = await Promise.all(opts.roots.map(async root => {
    if (!isAbsolute(root)) throw new Error('Recording folders must be absolute paths.')
    const canonical = await realpath(root)
    if (!(await stat(canonical)).isDirectory()) throw new Error('A recording folder is not a directory.')
    return canonical
  }))
  if (!isAbsolute(opts.inbox)) throw new Error('The recording inbox must be an absolute path.')
  const executable = await realpath(node)
  await access(executable, constants.X_OK)
  const server = await realpath(entry)
  if (!(await stat(server)).isFile()) throw new Error('The MCP entry point must be a file.')
  return [
    '#!/bin/sh',
    '# Ecamm Broadcast Finishes: Run Shell Script, Pass Input: to stdin.',
    '# Captures a completion notification only; does not inspect or change media.',
    '# Regenerate after moving the MCP installation or changing recording settings.',
    `export ECAMM_RECORDING_ROOTS=${shellQuote(JSON.stringify(roots))}`,
    `export ECAMM_RECORDING_INBOX=${shellQuote(opts.inbox)}`,
    `export ECAMM_FFPROBE=${shellQuote(opts.ffprobe)}`,
    `exec ${shellQuote(executable)} ${shellQuote(server)} recording-complete --path-stdin`,
    '',
  ].join('\n')
}
