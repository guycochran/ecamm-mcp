import jpeg from 'jpeg-js'

/**
 * Builds one labeled picture of every scene, so a person on a phone gets the whole
 * studio in a single image. Pure JavaScript (jpeg-js plus a small built-in bitmap
 * font) so the single-file bundle needs no native modules and no font files.
 */

// Printable ASCII, GW x GH pixels per glyph, 1 bit per pixel, row-major.
// Rendered from DejaVu Sans Mono Bold (Bitstream Vera / DejaVu license, see README credits).
const GW = 8
const GH = 17
const FONT = Buffer.from(
  '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',
  'base64',
)

export interface SheetCell {
  label: string
  /** Base64 JPEG as Ecamm returned it, or undefined when Ecamm had no thumbnail. */
  jpeg?: string
  /** Shown in amber under the label, e.g. "may be out of date". */
  note?: string
}

interface Bitmap {
  width: number
  height: number
  data: Uint8Array // RGBA
}

const BG = [24, 24, 24] as const
const FG = [240, 240, 240] as const
const AMBER = [255, 190, 70] as const
const SCALE = 2
const MAX_JPEG_BASE64 = 1_500_000
const MAX_THUMB_SIDE = 1024
const PAD = 20

function glyphBit(ch: number, x: number, y: number): boolean {
  const i = (ch - 32) * GW * GH + y * GW + x
  return (FONT[i >> 3] & (0x80 >> (i & 7))) !== 0
}

function drawText(dst: Bitmap, text: string, x0: number, y0: number, color: readonly number[], scale: number) {
  let x = x0
  for (const c of text) {
    let ch = c.codePointAt(0) ?? 63
    if (ch < 32 || ch > 126) ch = 63 // "?" for anything outside the built-in font
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        if (!glyphBit(ch, gx, gy)) continue
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x + gx * scale + sx
            const py = y0 + gy * scale + sy
            if (px < 0 || py < 0 || px >= dst.width || py >= dst.height) continue
            const o = (py * dst.width + px) * 4
            dst.data[o] = color[0]
            dst.data[o + 1] = color[1]
            dst.data[o + 2] = color[2]
          }
        }
      }
    }
    x += GW * scale
  }
}

/** Rows that are entirely near-black are letterbox bars. Dropping them loses nothing visible. */
export function trimLetterbox(img: Bitmap): { top: number; bottom: number } {
  const dark = (y: number) => {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4
      if (img.data[o] > 10 || img.data[o + 1] > 10 || img.data[o + 2] > 10) return false
    }
    return true
  }
  // Never trim past a 16:9 band, so an all-black scene still shows as a frame.
  const maxTrim = Math.max(0, Math.floor((img.height - Math.round((img.width * 9) / 16)) / 2))
  let top = 0
  while (top < maxTrim && dark(top)) top++
  let bottom = 0
  while (bottom < maxTrim && dark(img.height - 1 - bottom)) bottom++
  return { top, bottom }
}

function blit(dst: Bitmap, src: Bitmap, srcTop: number, srcH: number, dx: number, dy: number, scale: number) {
  for (let y = 0; y < srcH * scale; y++) {
    const sy = srcTop + Math.floor(y / scale)
    for (let x = 0; x < src.width * scale; x++) {
      const so = (sy * src.width + Math.floor(x / scale)) * 4
      const o = ((dy + y) * dst.width + dx + x) * 4
      dst.data[o] = src.data[so]
      dst.data[o + 1] = src.data[so + 1]
      dst.data[o + 2] = src.data[so + 2]
    }
  }
}

function fit(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, Math.max(1, maxChars - 3)) + '...'
}

/** Returns a base64 JPEG. One column up to 6 scenes, two columns beyond that. */
export function buildSceneSheet(cells: SheetCell[], title?: string): string {
  const decoded = cells.map((c) => {
    // Ecamm thumbnails are small (288 px, a few KB). Anything far outside that is skipped
    // rather than decoded, so one odd response cannot balloon memory.
    if (!c.jpeg || c.jpeg.length > MAX_JPEG_BASE64) return undefined
    try {
      const d = jpeg.decode(Buffer.from(c.jpeg, 'base64'), { useTArray: true, maxMemoryUsageInMB: 32, maxResolutionInMP: 2 })
      if (d.width > MAX_THUMB_SIDE || d.height > MAX_THUMB_SIDE) return undefined
      return { width: d.width, height: d.height, data: d.data } as Bitmap
    } catch {
      return undefined
    }
  })
  const cellW = Math.max(288, ...decoded.map((d) => d?.width ?? 0))
  const crops = decoded.map((d) => (d ? trimLetterbox(d) : { top: 0, bottom: 0 }))
  const imgH = Math.max(
    Math.round((cellW * 9) / 16),
    ...decoded.map((d, i) => (d ? d.height - crops[i].top - crops[i].bottom : 0)),
  )
  const cols = cells.length > 6 ? 2 : 1
  const rows = Math.ceil(cells.length / cols)
  const lineH = GH * SCALE + 6
  const labelH = lineH * (cells.some((c) => c.note) ? 2 : 1) + 4
  const boxW = cellW * SCALE
  const boxH = labelH + imgH * SCALE
  const titleH = title ? lineH + PAD : 0
  const width = PAD + cols * (boxW + PAD)
  const height = PAD + titleH + rows * (boxH + PAD)
  const sheet: Bitmap = { width, height, data: new Uint8Array(width * height * 4) }
  for (let i = 0; i < width * height; i++) {
    sheet.data[i * 4] = BG[0]
    sheet.data[i * 4 + 1] = BG[1]
    sheet.data[i * 4 + 2] = BG[2]
    sheet.data[i * 4 + 3] = 255
  }
  const maxChars = Math.floor(boxW / (GW * SCALE))
  if (title) drawText(sheet, fit(title, Math.floor((width - 2 * PAD) / (GW * SCALE))), PAD, PAD, FG, SCALE)

  cells.forEach((cell, i) => {
    const x = PAD + (i % cols) * (boxW + PAD)
    const y = PAD + titleH + Math.floor(i / cols) * (boxH + PAD)
    drawText(sheet, fit(cell.label, maxChars), x, y, FG, SCALE)
    if (cell.note) drawText(sheet, fit(cell.note, maxChars), x, y + lineH, AMBER, SCALE)
    const d = decoded[i]
    if (!d) {
      drawText(sheet, 'no thumbnail', x + 8, y + labelH + 8, AMBER, SCALE)
      return
    }
    const srcH = d.height - crops[i].top - crops[i].bottom
    const dx = x + Math.floor(((cellW - d.width) * SCALE) / 2)
    const dy = y + labelH + Math.floor(((imgH - srcH) * SCALE) / 2)
    blit(sheet, d, crops[i].top, srcH, dx, dy, SCALE)
  })

  return Buffer.from(jpeg.encode({ data: sheet.data, width, height }, 88).data).toString('base64')
}
