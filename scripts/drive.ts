/**
 * Let the simulation's bot drive the real page, and take pictures on the way.
 *
 *   node scripts/drive.ts [out-prefix] [--size 1600x900] [--laps 1] [--variant car]
 *
 * The bot's input replaces the keyboard's inside the page. A picture is taken at the
 * start, at each event worth seeing (take-off, landing, a prop or a door hit, checkpoint, finish), and
 * at the end. Console errors and warnings are printed; the exit code is 1 on an error or
 * when the laps were not finished.
 */
import { chromium } from "playwright-core"

const args = process.argv.slice(2)
const option = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback
}
const prefix = args[0] !== undefined && !args[0].startsWith("--") ? args[0] : "output/drive/run"
const [width = 1600, height = 900] = option("size", "1600x900").split("x").map(Number)
const laps = Number(option("laps", "1"))
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu"] })
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
let errors = 0
page.on("console", (message) => {
  if (message.type() === "error") errors += 1
  if (message.type() === "error" || message.type() === "warning") console.log(`console ${message.type()}: ${message.text()}`)
})
page.on("pageerror", (error) => {
  errors += 1
  console.log(`page error: ${String(error)}`)
})
await page.goto("http://localhost:5380/", { waitUntil: "load" })
await page.waitForTimeout(2500)
await page.screenshot({ path: `${prefix}-0-ready.png` })
await page.evaluate(async (variant) => {
  const sim = await import("/src/sim/index.ts" as string)
  const race = (window as any).__race
  const session = race.session
  session.setVariant(variant)
  const log: Array<{ kind: string; at: number }> = []
  const state = { finishes: 0, restartAt: -1, frames: 0, log }
  ;(window as any).__drive = state
  const tick = session.tick.bind(session)
  const drain = session.drainEvents.bind(session)
  session.tick = () => {
    const view = session.view()
    const restart = state.restartAt === view.tick
    tick({ ...sim.botInput(view, session.track), restart })
  }
  session.drainEvents = () => {
    const events = drain()
    for (const event of events) {
      log.push({ kind: event.kind, at: session.view().lap.timeMs })
      if (event.kind === "finish") {
        state.finishes += 1
        state.restartAt = session.view().tick + 240
      }
    }
    return events
  }
  const count = () => {
    state.frames += 1
    requestAnimationFrame(count)
  }
  requestAnimationFrame(count)
}, option("variant", "car"))
const seen = new Set<string>()
const started = Date.now()
let shots = 1
while (Date.now() - started < laps * 60000) {
  const state = await page.evaluate(() => {
    const drive = (window as any).__drive
    return { finishes: drive.finishes as number, log: drive.log as Array<{ kind: string; at: number }> }
  })
  for (const [index, entry] of state.log.entries()) {
    const key = `${index}:${entry.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    if (["takeoff", "land", "prop", "door", "bollard", "finish", "checkpoint", "boost"].includes(entry.kind) && shots < 24) {
      if (entry.kind === "takeoff") await page.waitForTimeout(250)
      await page.screenshot({ path: `${prefix}-${shots}-${entry.kind}.png` })
      shots += 1
    }
    console.log(`${entry.kind} at ${(entry.at / 1000).toFixed(3)} s`)
  }
  if (state.finishes >= laps) break
  await page.waitForTimeout(40)
}
await page.waitForTimeout(600)
await page.screenshot({ path: `${prefix}-${shots}-end.png` })
const result = await page.evaluate(() => {
  const drive = (window as any).__drive
  const view = (window as any).__race.session.view()
  return { finishes: drive.finishes as number, frames: drive.frames as number, phase: view.lap.phase as string, timeMs: view.lap.timeMs as number }
})
const seconds = (Date.now() - started) / 1000
console.log(`finished ${result.finishes} of ${laps} laps, last time ${(result.timeMs / 1000).toFixed(3)} s, ${(result.frames / seconds).toFixed(0)} frames per second, ${errors} console errors`)
await browser.close()
process.exit(errors > 0 || result.finishes < laps ? 1 : 0)
