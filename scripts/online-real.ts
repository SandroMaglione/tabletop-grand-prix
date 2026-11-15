/**
 * One player's first visit on a deployed site, against the real server: drive a lap, get a
 * made-up name with it, see the board beside the replay, change the name.
 *
 *   node scripts/online-real.ts <site url> [name] [out.png]
 *
 * The lap is the kept replay of the first track (`test/replays`), fed to the page tick by
 * tick through `__race.drive`, so no bot is needed in the built page and the time is known
 * beforehand. The player it creates stays on that stage's board: use it on staging, and
 * remove the run with `pnpm admin` when it is not wanted. Exits 1 when a step fails.
 */
import { readFileSync } from "node:fs"
import { chromium } from "playwright-core"
import { decodeReplay, replayFromText, tracks } from "../src/sim/index.ts"
import { unpack } from "../src/sim/replay.ts"

const [site, name = `Tester ${Math.floor(Math.random() * 9000 + 1000)}`, out = "output/online/real.png"] = process.argv.slice(2)
if (site === undefined) throw new Error("Give the site's URL")
const entry = tracks[0]
if (entry === undefined) throw new Error("No track")
const kept = JSON.parse(readFileSync(new URL(`../test/replays/${entry.id}.json`, import.meta.url), "utf8")) as { timeMs: number; replay: string }
const bytes = replayFromText(kept.replay)
const replay = bytes === null ? null : decodeReplay(bytes)
if (replay === null) throw new Error("The kept replay cannot be read")
const inputs = Array.from({ length: replay.inputs.length / 4 }, (_, tick) => {
  const at = tick * 4
  return unpack([replay.inputs[at] ?? 0, replay.inputs[at + 1] ?? 0, replay.inputs[at + 2] ?? 127, replay.inputs[at + 3] ?? 255])
})

const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu"] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
let failures = 0
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures += 1
}
page.on("console", (message) => {
  if (message.type() === "error") console.log(`console error: ${message.text()}`)
})
page.on("pageerror", (error) => {
  failures += 1
  console.log(`page error: ${String(error)}`)
})

await page.goto(site, { waitUntil: "load" })
await page.waitForFunction(() => (window as any).__race !== undefined, undefined, { timeout: 20000 })
await page.waitForTimeout(1500)
// The kept lap, one input per tick; nothing before it and nothing after.
await page.evaluate((lap) => {
  let tick = 0
  const idle = { throttle: 0, brake: 0, steer: 0, aim: null, restart: false }
  ;(window as any).__race.drive = () => lap[tick++] ?? idle
}, inputs)
await page.waitForFunction(() => (window as any).__race.session.view().lap.phase === "finished", undefined, { timeout: 90000 })
const timeMs = await page.evaluate(() => (window as any).__race.session.view().lap.timeMs as number)
check(timeMs === kept.timeMs, `the lap driven in the page is the kept lap (${timeMs} ms)`)

// The device is given a made-up name and the lap goes to the board under it; the board
// opens beside the replay once the wipe has covered the window.
await page.waitForFunction(() => (window as any).__race.online.state().post?.state.kind === "sent", undefined, { timeout: 20000 }).catch(() => {})
const given = await page.evaluate(() => ((window as any).__race.online.state().identity?.name as string | undefined) ?? "")
check(given.split(" ").length === 3, `the device is given a made-up name (${given})`)
await page.locator(".tgp-rows").waitFor({ state: "visible", timeout: 10000 })
check(await page.evaluate(() => (window as any).__race.rerun.active() as boolean), "the lap is shown again behind the board")

// The name is the player's to change, from the board.
await page.locator(".tgp-link").click()
const field = page.locator(".tgp-input")
await field.waitFor({ state: "visible", timeout: 10000 })
await field.fill(name)
const status = page.locator(".tgp-status")
await page.waitForFunction(() => document.querySelector(".tgp-status")?.classList.contains("tgp-good") === true, undefined, { timeout: 15000 }).catch(() => {})
check((await status.getAttribute("class"))?.includes("tgp-good") === true, `the server says "${name}" is free ("${await status.textContent()}")`)
await page.locator(".tgp-primary").click()
await page.waitForTimeout(5000)
const rows = await page.locator(".tgp-row").allTextContents()
const mine = rows.find((row) => row.toUpperCase().includes(name.toUpperCase()))
check(mine !== undefined, `the board shows the player under the new name (${mine ?? "not found"})`)
console.log(rows.map((row) => `     ${row}`).join("\n"))
await page.screenshot({ path: out })
console.log(`     ${out}`)
await browser.close()
if (failures > 0) process.exit(1)
