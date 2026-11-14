/**
 * Take a picture of a page of the running dev server (http://localhost:5380).
 *
 *   node scripts/shot.ts <path> <out.png> [--wait 1500] [--size 1600x900] [--eval "js"] [--keys "ArrowUp:2000,ArrowLeft:500"]
 *
 * `path` is the page ("/" or "/world-lab.html?x=1"). `--wait` is milliseconds to wait after
 * load. `--eval` runs JavaScript in the page before the picture. `--keys` holds each key
 * for its milliseconds, in order, before the picture. Console errors are printed, and the
 * exit code is 1 when there were any.
 */
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { chromium } from "playwright-core"

const [path = "/", out = "output/shot.png", ...rest] = process.argv.slice(2)
const option = (name: string, fallback: string): string => {
  const at = rest.indexOf(`--${name}`)
  return at >= 0 ? (rest[at + 1] ?? fallback) : fallback
}
const [width = 1600, height = 900] = option("size", "1600x900").split("x").map(Number)
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--enable-unsafe-webgpu"] })
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
const errors: Array<string> = []
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text())
})
page.on("pageerror", (error) => errors.push(String(error)))
await page.goto(`http://localhost:5380${path}`, { waitUntil: "load" })
await page.waitForTimeout(Number(option("wait", "1500")))
const script = option("eval", "")
if (script !== "") await page.evaluate(script)
for (const step of option("keys", "").split(",").filter((entry) => entry !== "")) {
  const [key = "", ms = "200"] = step.split(":")
  await page.keyboard.down(key)
  await page.waitForTimeout(Number(ms))
  await page.keyboard.up(key)
}
mkdirSync(dirname(out), { recursive: true })
await page.screenshot({ path: out })
await browser.close()
for (const error of errors) console.error(`console error: ${error}`)
console.log(`wrote ${out}`)
process.exit(errors.length > 0 ? 1 : 0)
