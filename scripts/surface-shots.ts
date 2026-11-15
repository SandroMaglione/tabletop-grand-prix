/**
 * Pictures of the car on the track's surface patches (the ford, the meadow, the stony ground),
 * close up, with the page frozen at the moment each one is taken.
 *
 *   node scripts/surface-shots.ts [out-dir] [--port 5391] [--scale 2] [--size 1600x900] [--crop 360x240] [--at "name:s[:air],..."] [--line "sFrom:sTo:d,..."]
 *
 * The simulation's bot drives the real page (through `__race.drive`, as in `drive.ts`). When
 * the car passes each centreline distance in `--at`, the page's animation frames are held, so
 * the picture shows exactly that frame; a crop around the car (`--crop`, CSS pixels, at
 * `--scale` device pixels each) and the whole screen are saved, then the page runs on. A stop
 * marked `air` waits past its distance for the car to be off the ground for a few ticks (thrown
 * by a rock, say), and is taken then.
 * `--line` makes the car leave the bot's line between two centreline distances and follow a
 * lateral offset instead (positive left), to drive it through a patch the bot goes round.
 * Console errors are printed; the exit code is 1 when there were any.
 */
import { mkdirSync } from "node:fs"
import { chromium } from "playwright-core"

const args = process.argv.slice(2)
const option = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback
}
const out = args[0] !== undefined && !args[0].startsWith("--") ? args[0] : "output/surfaces"
const port = option("port", "5391")
const scale = Number(option("scale", "2"))
const [width = 1600, height = 900] = option("size", "1600x900").split("x").map(Number)
const [cropW = 360, cropH = 240] = option("crop", "360x240").split("x").map(Number)
const stops = option("at", "ford-in:13,ford-out:21,ford-tracks:34,meadow-in:71,meadow:81,meadow-late:91,meadow-lane:99,stones:188,stones-air:190:air,stones-late:208")
  .split(",")
  .map((entry) => {
    const [name = "", s = "0", air = ""] = entry.split(":")
    return { name, s: Number(s), air: air === "air" }
  })
const lines = option("line", "")
  .split(",")
  .filter((entry) => entry !== "")
  .map((entry) => {
    const [from = "0", to = "0", d = "0"] = entry.split(":")
    return { from: Number(from), to: Number(to), d: Number(d) }
  })
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu"] })
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
let errors = 0
page.on("console", (message) => {
  if (message.type() === "error") errors += 1
  if (message.type() === "error" || message.type() === "warning") console.log(`console ${message.type()}: ${message.text()}`)
})
page.on("pageerror", (error) => {
  errors += 1
  console.log(`page error: ${String(error)}`)
})
// Frames are held while `__frozen` is set and handed back by `__thaw`.
await page.addInitScript(() => {
  const w = window as any
  const raf = window.requestAnimationFrame.bind(window)
  const held: Array<FrameRequestCallback> = []
  w.__frozen = false
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    raf((time) => {
      if (w.__frozen) held.push(callback)
      else callback(time)
    })
  w.__thaw = () => {
    w.__frozen = false
    for (const callback of held.splice(0)) raf(callback)
  }
})
await page.goto(`http://localhost:${port}/`, { waitUntil: "load" })
await page.waitForTimeout(2500)
await page.evaluate(async ({ targets, lines }) => {
  const sim = await import("/src/sim/index.ts" as string)
  const w = window as any
  const race = w.__race
  const state = { next: 0, hit: null as null | { name: string; x: number; y: number; z: number }, done: false, airTicks: 0 }
  w.__shots = state
  race.drive = (view: any, track: any) => {
    const target = targets[state.next]
    state.airTicks = view.car.grounded ? 0 : state.airTicks + 1
    const reached = target !== undefined && view.car.s >= target.s && (target.air ? view.car.s < target.s + 40 && state.airTicks === 5 : view.car.s < target.s + 6)
    if (target !== undefined && state.hit === null && view.lap.phase === "running" && reached) {
      state.hit = { name: target.name, x: view.car.x, y: view.car.y, z: view.car.z }
      state.next += 1
      w.__frozen = true
    }
    if (target === undefined) state.done = true
    const line = lines.find((entry) => view.car.s > entry.from && view.car.s < entry.to)
    if (line === undefined) return sim.botInput(view, track)
    // Pure pursuit of a point a few metres ahead on the offset line.
    const ahead = sim.pointAt(track, view.car.s + 5, line.d)
    const want = Math.atan2(ahead.x - view.car.x, ahead.z - view.car.z)
    const steer = Math.max(-1, Math.min(1, sim.angleDelta(view.car.yaw, want) * 5))
    return { ...sim.botInput(view, track), steer, throttle: 1, brake: 0 }
  }
}, { targets: stops, lines })

const started = Date.now()
while (Date.now() - started < 90000) {
  const state = await page.evaluate(() => {
    const w = window as any
    const shots = w.__shots
    if (shots.hit === null) return { done: shots.done as boolean, hit: null }
    const stage = w.__race.stage
    const p = stage.view.worldToScreen({ x: shots.hit.x, y: shots.hit.y + 0.5, z: shots.hit.z })
    return { done: false, hit: { name: shots.hit.name as string, sx: p?.x ?? 0, sy: p?.y ?? 0 } }
  })
  if (state.done) break
  if (state.hit !== null) {
    await page.waitForTimeout(120)
    const x = Math.max(0, Math.min(width - cropW, state.hit.sx - cropW / 2))
    const y = Math.max(0, Math.min(height - cropH, state.hit.sy - cropH / 2))
    await page.screenshot({ path: `${out}/${state.hit.name}.png`, clip: { x, y, width: cropW, height: cropH } })
    await page.screenshot({ path: `${out}/${state.hit.name}-full.png` })
    console.log(`${state.hit.name} at ${Math.round(state.hit.sx)}, ${Math.round(state.hit.sy)}`)
    await page.evaluate(() => {
      const w = window as any
      w.__shots.hit = null
      w.__thaw()
    })
  }
  await page.waitForTimeout(20)
}
await browser.close()
console.log(`${errors} console errors`)
process.exit(errors > 0 ? 1 : 0)
