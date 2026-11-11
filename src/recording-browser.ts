import { opendir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import type { RecordingOptions } from './recordings.js'

const mediaExtensions = new Set(['.mov', '.mp4', '.m4v', '.m4a', '.wav', '.mp3', '.aac', '.flac', '.ogg', '.mkv', '.webm'])
const sidecarExtensions = new Set(['.txt', '.srt'])
const inside = (base: string, path: string) => {
  const rel = relative(base, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Browse one explicitly allowed directory. Never infer completion, tracks, or sessions. */
export async function browseRecordings(opts: RecordingOptions, folder?: string, limit = 50, offset = 0) {
  if (!opts.roots.length) throw new Error('Set a recording folder before browsing local files.')
  const roots: string[] = []
  const unavailableFolders: string[] = []
  for (const root of opts.roots) {
    try {
      const canonical = await realpath(root)
      if ((await stat(canonical)).isDirectory()) roots.push(canonical)
      else unavailableFolders.push(root)
    } catch { unavailableFolders.push(root) }
  }
  const folders = [...new Set(roots)]
  if (!folders.length) throw new Error('The configured recording folders are unavailable.')
  if (!folder && folders.length > 1) return { folders, unavailableFolders, entries: [], note: 'Choose one configured folder to browse. No files were scanned.' }
  const requested = folder ?? folders[0]
  if (!isAbsolute(requested)) throw new Error('Use an absolute recording folder path.')
  const canonical = await realpath(requested)
  if (!folders.some(root => inside(root, canonical))) throw new Error('This folder is outside the configured recording folders.')
  if (!(await stat(canonical)).isDirectory()) throw new Error('The requested path is not a folder.')
  const entries: { name: string; path: string; kind: 'folder' | 'media_candidate' | 'sidecar_candidate'; bytes?: number; modifiedAt?: string }[] = []
  let scanned = 0, unavailable = 0
  const directory = await opendir(canonical)
  for await (const item of directory) {
    if (++scanned > 5000) throw new Error('This directory exceeds the 5,000-entry browsing limit. Choose a smaller subfolder.')
    if (item.name.startsWith('.') || item.isSymbolicLink()) continue
    const extension = extname(item.name).toLowerCase()
    const kind = item.isDirectory() ? 'folder' : item.isFile() && mediaExtensions.has(extension) ? 'media_candidate'
      : item.isFile() && sidecarExtensions.has(extension) ? 'sidecar_candidate' : undefined
    if (!kind) continue
    try {
      const path = join(canonical, item.name)
      // Recheck containment in case a directory entry changed while being listed.
      const resolved = await realpath(path)
      if (!folders.some(root => inside(root, resolved))) { unavailable++; continue }
      const info = await stat(resolved)
      if ((kind === 'folder' && !info.isDirectory()) || (kind !== 'folder' && !info.isFile())) { unavailable++; continue }
      entries.push({ name: item.name, path: resolved, kind, ...(kind === 'folder' ? {} : { bytes: info.size, modifiedAt: info.mtime.toISOString() }) })
    } catch { unavailable++ }
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const start = Math.max(0, Math.min(5000, Math.trunc(offset)))
  const count = Math.max(1, Math.min(100, Math.trunc(limit)))
  return { folder: canonical, folders, unavailableFolders, entries: entries.slice(start, start + count), totalEntries: entries.length,
    nextOffset: start + count < entries.length ? start + count : null, unavailable,
    note: 'Alphabetical file candidates only. Names/extensions and modification dates do not establish Ecamm origin, recording completion, session association, or media quality. Nothing was opened or registered as a completion event. Hidden files and symbolic links are omitted; directory contents can change between pages.' }
}
