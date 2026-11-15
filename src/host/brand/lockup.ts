/**
 * The Typeonce pixel lockup, as typeonce.games draws it: the pixel mark standing for the T,
 * then "ypeonce" in the brand's pixel letters. Built as one SVG path of whole pixels, so it
 * stays sharp at any size; it takes the colour of the text around it.
 *
 * The art is `pixel-mark.ts`, copied from the brand's own source. The layout numbers below
 * are the brand's too (its `pixel-splash.ts`): the letters' x-height starts on row 13 of the
 * 32 px mark, two pixels after the mark and two between letters.
 */
import { PIXEL_LETTERS, PIXEL_MARK_32, PIXEL_WORDMARK } from "./pixel-mark.ts"

const MARK_SIZE = 32
const MARK_TO_TEXT = 2
const LETTER_GAP = 2
const TEXT_TOP = 13

/** The filled runs of one row of pixel art, as path commands at (`x`, `y`). */
const rowPath = (row: string, x: number, y: number): string => {
  let path = ""
  for (let from = 0; from < row.length; from++) {
    if (row[from] !== "#") continue
    let to = from
    while (row[to + 1] === "#") to++
    path += `M${x + from} ${y}h${to - from + 1}v1h${-(to - from + 1)}z`
    from = to
  }
  return path
}

const art = (rows: ReadonlyArray<string>, x: number, y: number): string => rows.map((row, index) => rowPath(row, x, y + index)).join("")

let letterX = MARK_SIZE + MARK_TO_TEXT
const letters = PIXEL_WORDMARK.map((letter) => {
  const rows = PIXEL_LETTERS[letter]
  const path = art(rows, letterX, TEXT_TOP)
  letterX += (rows[0]?.length ?? 0) + LETTER_GAP
  return path
}).join("")

/** The lockup's size in art pixels. */
export const lockupWidth = letterX - LETTER_GAP
export const lockupHeight = MARK_SIZE
const lockupPath = art(PIXEL_MARK_32, 0, 0) + letters

/**
 * The lockup as SVG markup `height` CSS pixels tall, for a page that has no script yet: the
 * build writes it into `index.html`'s loading screen (`vite.config.ts`).
 */
export const lockupMarkup = (height: number): string =>
  `<svg viewBox="0 0 ${lockupWidth} ${lockupHeight}" width="${(height * lockupWidth) / lockupHeight}" height="${height}" shape-rendering="crispEdges" aria-hidden="true"><path d="${lockupPath}" fill="currentColor"/></svg>`

/** The lockup as an SVG element `height` CSS pixels tall. */
export const createLockup = (host: Document, height: number): SVGSVGElement => {
  const svg = host.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", `0 0 ${lockupWidth} ${lockupHeight}`)
  svg.setAttribute("width", String((height * lockupWidth) / lockupHeight))
  svg.setAttribute("height", String(height))
  svg.setAttribute("shape-rendering", "crispEdges")
  svg.setAttribute("aria-hidden", "true")
  const path = host.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", lockupPath)
  path.setAttribute("fill", "currentColor")
  svg.appendChild(path)
  return svg
}
