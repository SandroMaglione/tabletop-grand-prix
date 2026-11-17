/**
 * Draw the release pictures from a still of the race (`node scripts/trailer.ts output/stills --size 2560x1440 --stills`):
 *
 *   node scripts/cards.ts [still.png]
 *
 * - `public/og.png` (1200×630): the link card, for the page's social tags;
 * - `public/favicon.svg`, `public/favicon-32.png`, `public/apple-touch-icon.png`: the icon;
 * - `output/release/x-post.png` (1600×900): the picture for the release post;
 * - `output/release/typeonce-games.webp` (1280×720): the game's picture on typeonce.games,
 *   the race alone (the site writes the title beside it).
 *
 * Each is a page laid out here and photographed with Playwright, in the trailer's look: the
 * yellow slanted plate, Chakra Petch and JetBrains Mono, the Typeonce lockup.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { chromium } from "playwright-core"
import { lockupMarkup } from "../src/host/brand/lockup.ts"

const still = process.argv[2] ?? "output/stills/stills/open-0540.png"
const stillUrl = `data:image/png;base64,${readFileSync(still).toString("base64")}`
const ADDRESS = "tabletop-grand-prix.typeonce.games"
const INK = "#0b0f1f"
const YELLOW = "#f6d32d"
const PAPER = "#e9e6df"

const head = `<meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500&family=Chakra+Petch:ital,wght@0,600;0,700;1,700&display=block">
<style>
* { box-sizing: border-box; margin: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; background: ${PAPER}; }
.shot { position: absolute; inset: 0; background-image: url(${stillUrl}); background-repeat: no-repeat; }
.plate { display: inline-block; font: italic 700 var(--size)/0.95 "Chakra Petch", sans-serif; letter-spacing: 0.01em; color: ${INK}; background: ${YELLOW}; padding: calc(var(--size) * 0.14) calc(var(--size) * 0.36) calc(var(--size) * 0.06); transform: skewX(-12deg); box-shadow: 0 calc(var(--size) * 0.11) 0 ${INK}; white-space: nowrap; }
.tag { display: inline-block; font: 500 var(--size)/1 "JetBrains Mono", monospace; letter-spacing: 0.14em; color: #fff; background: ${INK}; padding: calc(var(--size) * 0.36) calc(var(--size) * 0.7) calc(var(--size) * 0.3); transform: skewX(-12deg); white-space: nowrap; }
.by { color: ${INK}; line-height: 0; }
.by svg { height: var(--size); width: auto; }
body > svg { display: block; width: 100%; height: 100%; }
</style>`

/** The link card and the post: the race on the left, the name on the table's paper on the right. */
const card = (o: { readonly width: number; readonly height: number; readonly shot: string; readonly title: number; readonly lines: ReadonlyArray<string>; readonly line: number; readonly address: number; readonly lockup: number; readonly right: number; readonly flag?: string }): string => `<!doctype html><html><head>${head}
<style>
.text { position: absolute; top: 0; bottom: 0; right: ${o.right}px; display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: ${Math.round(o.title * 0.3)}px; }
.text .plate + .plate { margin-top: ${Math.round(-o.title * 0.12)}px; }
.lines { display: flex; flex-direction: column; align-items: flex-end; gap: ${Math.round(o.line * 0.5)}px; margin-top: ${Math.round(o.title * 0.25)}px; }
.flag { font: 700 ${Math.round(o.line * 1.5)}px/1 "Chakra Petch", sans-serif; letter-spacing: 0.3em; color: ${INK}; margin-right: -0.3em; }
.address { font: 500 ${o.address}px/1 "JetBrains Mono", monospace; color: ${INK}; letter-spacing: 0.04em; margin-top: ${Math.round(o.title * 0.2)}px; }
.by { position: absolute; right: ${o.right}px; bottom: ${Math.round(o.lockup * 1.2)}px; }
</style></head><body>
<div class="shot" style="${o.shot}"></div>
<div class="text">
  ${o.flag === undefined ? "" : `<div class="flag">${o.flag}</div>`}
  <div class="plate" style="--size:${o.title}px">TABLETOP</div>
  <div class="plate" style="--size:${o.title}px">GRAND PRIX</div>
  <div class="lines">${o.lines.map((line) => `<div class="tag" style="--size:${o.line}px">${line}</div>`).join("")}</div>
  <div class="address">${ADDRESS}</div>
</div>
<div class="by" style="--size:${o.lockup}px">${lockupMarkup(o.lockup)}</div>
</body></html>`

/** The icon: a chequered flag on the plate's yellow, slanted like the title. */
const iconSvg = (): string => {
  const cells: Array<string> = []
  for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) if ((x + y) % 2 === 0) cells.push(`<rect x="${x * 4}" y="${y * 4}" width="4" height="4"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${INK}"/><g transform="translate(6 8) skewX(-12)"><rect x="2" width="20" height="16" fill="${YELLOW}"/><g fill="${INK}" transform="translate(2 0)">${cells.join("")}</g></g><rect x="5" y="25" width="22" height="2.5" fill="${YELLOW}"/></svg>`
}

const pages: ReadonlyArray<{ readonly out: string; readonly width: number; readonly height: number; readonly html: string }> = [
  {
    out: "public/og.png",
    width: 1200,
    height: 630,
    html: card({ width: 1200, height: 630, shot: "background-size: 1280px 720px; background-position: -40px -40px;", title: 68, lines: ["RACE A FIELD OF GHOSTS", "PLAY FREE IN YOUR BROWSER"], line: 17, address: 16, lockup: 26, right: 52 })
  },
  {
    out: "output/release/x-post.png",
    width: 1600,
    height: 900,
    html: card({ width: 1600, height: 900, shot: "background-size: 1760px 990px; background-position: -60px -60px;", title: 92, lines: ["SET THE FASTEST LAP", "RACE A FIELD OF GHOSTS", "PLAY FREE IN YOUR BROWSER"], line: 21, address: 22, lockup: 34, right: 70, flag: "OUT NOW" })
  },
  {
    out: "output/release/typeonce-games.png",
    width: 1280,
    height: 720,
    // The race alone, closer: the car at the head of the pack, the pack curling behind it.
    html: `<!doctype html><html><head>${head}</head><body><div class="shot" style="background-size: 1920px 1080px; background-position: -60px -240px;"></div></body></html>`
  },
  { out: "public/favicon-32.png", width: 32, height: 32, html: `<!doctype html><html><head>${head}</head><body style="background:transparent">${iconSvg()}</body></html>` },
  { out: "public/apple-touch-icon.png", width: 180, height: 180, html: `<!doctype html><html><head>${head}</head><body style="background:${INK}">${iconSvg().replace('rx="7"', 'rx="0"')}</body></html>` }
]

mkdirSync("public", { recursive: true })
mkdirSync("output/release", { recursive: true })
writeFileSync("public/favicon.svg", iconSvg())
const browser = await chromium.launch()
for (const one of pages) {
  const page = await browser.newPage({ viewport: { width: one.width, height: one.height }, deviceScaleFactor: 1 })
  await page.setContent(one.html, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: one.out, omitBackground: one.out.includes("favicon") })
  await page.close()
  console.log(`wrote ${one.out}`)
}
await browser.close()
execFileSync("cwebp", ["-quiet", "-q", "88", "output/release/typeonce-games.png", "-o", "output/release/typeonce-games.webp"])
console.log("wrote output/release/typeonce-games.webp")
