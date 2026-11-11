import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { browseRecordings } from '../src/recording-browser.js'
let temp: string
async function fixture() {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'ecamm-browse-')))
  const root = join(temp, 'recordings'); await mkdir(root)
  return { roots: [root], inbox: join(temp, 'inbox'), ffprobe: '/not-installed' }
}
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }) })
it('lists bounded alphabetical candidates without opening media or needing a Shortcut', async () => {
  const opts = await fixture(), root = opts.roots[0]
  for (const name of ['B.mov', 'A.MP4', 'B.txt', '.hidden.mov', 'ignored.exe']) await writeFile(join(root, name), '')
  await mkdir(join(root, 'C'))
  const first = await browseRecordings(opts, undefined, 2)
  expect(first.entries.map(e => e.name)).toEqual(['A.MP4', 'B.mov'])
  expect(first).toMatchObject({ totalEntries: 4, nextOffset: 2 })
  const last = await browseRecordings(opts, root, 2, 2)
  expect(last.entries.map(e => e.kind)).toEqual(['sidecar_candidate', 'folder'])
  expect(last.nextOffset).toBeNull()
  expect((await browseRecordings(opts, join(root, 'C'))).entries).toEqual([])
})
it('does not follow outside symlinks, sibling-prefix paths, or directory traversal', async () => {
  const opts = await fixture(), root = opts.roots[0]
  const outside = join(temp, 'recordings-other'); await mkdir(outside)
  await writeFile(join(outside, 'private.mov'), '')
  await symlink(outside, join(root, 'escape'))
  await symlink(join(outside, 'private.mov'), join(root, 'leak.mov'))
  expect((await browseRecordings(opts)).entries).toEqual([])
  for (const path of [outside, join(root, 'escape'), join(root, '..')]) await expect(browseRecordings(opts, path)).rejects.toThrow('outside')
  await expect(browseRecordings({ ...opts, roots: [] })).rejects.toThrow('Set a recording folder')
})
it('asks for a folder when multiple roots exist and reports offline roots honestly', async () => {
  const opts = await fixture()
  const other = join(temp, 'other'); await mkdir(other)
  const choices = await browseRecordings({ ...opts, roots: [...opts.roots, other] })
  expect(choices.folders).toEqual([...opts.roots, other]); expect(choices.entries).toEqual([])
  expect((await browseRecordings({ ...opts, roots: [...opts.roots, join(temp, 'missing')] })).unavailableFolders).toEqual([join(temp, 'missing')])
  await expect(browseRecordings({ ...opts, roots: [join(temp, 'missing')] })).rejects.toThrow('unavailable')
})
it('refuses an oversized directory rather than returning a misleading partial listing', async () => {
  const opts = await fixture()
  for (let start = 0; start < 5001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 5001 - start) }, (_, i) => writeFile(join(opts.roots[0], `${start + i}.ignored`), '')))
  }
  await expect(browseRecordings(opts)).rejects.toThrow('5,000-entry')
})
