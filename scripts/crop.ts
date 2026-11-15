/**
 * A close-up of part of the running page (http://localhost:5380), three device pixels per CSS pixel.
 *
 *   node scripts/crop.ts <path> <out.png> <x> <y> <width> <height> [wait ms]
 */
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { chromium } from "playwright-core"

const [path = "/", out = "output/crop.png", x = "0", y = "0", width = "400", height = "300", wait = "1500"] = process.argv.slice(2)
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--enable-unsafe-webgpu"] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 3 })
await page.goto(`http://localhost:5380${path}`, { waitUntil: "load" })
await page.waitForTimeout(Number(wait))
mkdirSync(dirname(out), { recursive: true })
await page.screenshot({ path: out, clip: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) } })
await browser.close()
console.log(`wrote ${out}`)
