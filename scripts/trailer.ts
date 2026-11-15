/**
 * Film the trailer: the real game, driven by the bot, filmed frame by frame and cut to
 * a short video.
 *
 *   node scripts/trailer.ts [out-dir] [--size 1920x1080] [--keep-frames]
 *
 * Needs the page served (`pnpm dev`, http://localhost:5380) and ffmpeg. Writes
 * `<out-dir>/trailer.mp4` (default `output/trailer`).
 *
 * The page runs on a stopped clock. Each video frame moves the page on by a set amount of
 * game time: its timers, `performance.now`, its web animations, and one animation frame
 * whose stamp moves by exactly two simulation ticks (one in slow motion). So the film is
 * smooth however slow the capture is, and the same every time: the race is the
 * deterministic simulation and the bot drives it.
 *
 * Two laps against the stand-in board (`?server=fake&fresh`):
 * - lap A, for the obstacles: the bot, steered into the crate wall and slow through the
 *   spiral so the lap lands low on the board;
 * - lap B, the bot's clean lap, against the ghost of the run just above lap A: the opener
 *   closes in on it racing alone, then its ghost pops in, then the crowd of 100 bot ghosts
 *   (`?ghosts=100`, shown only there); it drifts the spiral, wins, and the player's row
 *   climbs the board.
 * The camera follows the car up close for each shot (`Stage.focusOn`), always on the move
 * (a push in, a pull out, a slide), and kicks in on a hit; the big hits play in slow
 * motion. Between shots the page runs on unfilmed. The captions, the flash and the end card
 * are drawn over the page here.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { chromium } from "playwright-core"

const args = process.argv.slice(2)
const out = args.find((arg) => !arg.startsWith("--") && !/^\d+x\d+$/.test(arg)) ?? "output/trailer"
const sizeAt = args.indexOf("--size")
const [width = 1920, height = 1080] = (sizeAt >= 0 ? (args[sizeAt + 1] ?? "") : "1920x1080").split("x").map(Number)
const keepFrames = args.includes("--keep-frames")
const frames = `${out}/frames`
rmSync(frames, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })

const FPS = 60
/** Game time in one video frame at full speed: two ticks of the 120 Hz simulation. */
const FRAME_MS = 1000 / FPS

const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--enable-unsafe-webgpu"] })
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
const cdp = await page.context().newCDPSession(page)
const errors: Array<string> = []
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text())
})
page.on("pageerror", (error) => errors.push(String(error)))

await page.clock.install()
await page.goto("http://localhost:5380/?server=fake&fresh&ghosts=100", { waitUntil: "load" })
await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))

// Animation frames come only when a video frame is made. Their stamps move by exact
// fractions of a millisecond, starting half a tick off the tick grid, so the loop takes
// the same whole number of ticks every frame; the page's clock (whole milliseconds) keeps
// up with the stamps.
await page.evaluate(() => {
  const w = window as any
  let queue: Array<FrameRequestCallback> = []
  let id = 0
  let base = performance.now() + 1000 / 240
  /** Moves the stamps on by `ms` once, to set where the loop's leftover time sits between two ticks. */
  w.__nudge = (ms: number) => {
    base += ms
  }
  /** Simulation ticks the stamps have moved on by: the stamp is worked out from it, so no rounding piles up. */
  let ticks = 0
  w.requestAnimationFrame = (callback: FrameRequestCallback) => {
    queue.push(callback)
    return ++id
  }
  w.cancelAnimationFrame = () => {}
  /** Web animations are held and moved on by hand, with the clock; the board's rows wait while `holdRows`. */
  const held = new Map<Animation, number>()
  w.__holdRows = false
  w.__frame = (ms: number) => {
    for (const animation of document.getAnimations()) {
      if (animation.playState === "finished") {
        held.delete(animation)
        continue
      }
      const start = held.get(animation) ?? Number(animation.currentTime ?? 0)
      if (animation.playState !== "paused") animation.pause()
      const target = (animation.effect as KeyframeEffect | null)?.target
      const waiting = w.__holdRows === true && target instanceof Element && target.closest(".tgp-rows") !== null
      const next = waiting ? start : start + ms
      const end = Number(animation.effect?.getComputedTiming().endTime ?? 0)
      if (next >= end && Number.isFinite(end)) {
        held.delete(animation)
        animation.finish()
      } else {
        held.set(animation, next)
        animation.currentTime = next
      }
    }
    ticks += Math.round((ms * 120) / 1000)
    const stamp = base + (ticks * 1000) / 120
    const due = queue
    queue = []
    for (const callback of due) callback(stamp)
  }
})

/** Game time the page's clock owes, below a whole millisecond. */
let owed = 0
/** Moves the page on by `ms` of game time, in one animation frame. */
const advance = async (ms: number): Promise<void> => {
  owed += ms
  const whole = Math.floor(owed)
  owed -= whole
  if (whole > 0) await page.clock.runFor(whole)
  await page.evaluate((step) => (window as any).__frame(step), ms)
}

// ── the page's state, the bot and the director ──────────────────────────

for (let i = 0; i < 600 && !(await page.evaluate(() => (window as any).__race?.online !== undefined)); i++) await advance(FRAME_MS)
// The crowd of 100 bot ghosts is driven in workers, on real time: wait for all of it, then
// keep it hidden but for its shot.
for (let waited = 0; (await page.evaluate(() => (window as any).__race.field.ready())) < 100; waited += 200) {
  if (waited > 120_000) throw new Error("the crowd of ghosts never came")
  await new Promise((done) => setTimeout(done, 200))
}
await page.evaluate(() => (window as any).__race.field.show(0))
for (let i = 0; i < 90; i++) await advance(FRAME_MS)

// The loop keeps the time left over below one tick. Left near a whole tick, the rounding in
// its sums makes frames of 1 and 3 ticks instead of 2 (a stutter): nudge it to half a tick.
await page.evaluate(() => {
  const w = window as any
  const session = w.__race.session
  const tick = session.tick.bind(session)
  w.__ticks = 0
  session.tick = (input: unknown) => {
    w.__ticks++
    return tick(input)
  }
})
const ticksPerFrame = async (count: number): Promise<Array<number>> => {
  const counts: Array<number> = []
  for (let i = 0; i < count; i++) {
    const before: number = await page.evaluate(() => (window as any).__ticks)
    await advance(FRAME_MS)
    counts.push((await page.evaluate(() => (window as any).__ticks)) - before)
  }
  return counts
}
for (let tries = 0; ; tries++) {
  const counts = await ticksPerFrame(24)
  if (counts.every((count) => count === 2)) break
  if (tries === 8) throw new Error(`The frames never settled on two ticks each: ${counts.join("")}`)
  await page.evaluate((ms) => (window as any).__nudge(ms), 1000 / 480)
  await advance(FRAME_MS)
}

await page.evaluate(async () => {
  const w = window as any
  const sim = await import("/src/sim/index.ts" as string)
  const query = await import("/src/sim/track/query.ts" as string)
  const { lockupMarkup } = await import("/src/host/brand/lockup.ts" as string)
  const race = w.__race
  const idle = { ...sim.idleInput }
  const tr = (w.__tr = {
    mode: "hold" as "hold" | "A" | "B",
    restart: false,
    finishes: 0,
    cam: null as null | { x: number; y: number; z: number; zoom: number },
    /** The camera's kick in on a hit, and the flash on a big one; both fade. */
    kick: 0,
    flash: 0
  })
  // The raced ghost, held back for the opener: hidden (-1), popping in from a time (ms), or as the page has it (null).
  w.__ghostAt = null as number | null
  const posed = race.ghost.pose.bind(race.ghost)
  race.ghost.pose = (view: any, racing: boolean) => {
    const pose = posed(view, racing)
    const at = w.__ghostAt
    if (pose === null || at === null) return pose
    if (at < 0) return null
    // Drawn whole even over the car (the game fades a ghost there): this is its entrance.
    return { ...pose, fade: Math.min(1, (performance.now() - at) / 150) }
  }
  const drain = race.session.drainEvents.bind(race.session)
  race.session.drainEvents = () => {
    const events = drain()
    for (const event of events) {
      if (event.kind === "finish") tr.finishes++
      const impact = "impact" in event ? event.impact : 0
      if (event.kind === "prop" || event.kind === "knock") tr.kick = Math.min(0.18, tr.kick + Math.min(0.07, impact / 260))
      if (event.kind === "prop" && impact > 20) tr.flash = Math.max(tr.flash, 0.5)
      if (event.kind === "land") tr.kick = Math.min(0.18, tr.kick + Math.min(0.12, impact / 60))
      if (event.kind === "bump") tr.kick = Math.min(0.18, tr.kick + 0.03)
      if (event.kind === "drift") tr.kick = Math.min(0.18, tr.kick + 0.06 * event.charge)
    }
    return events
  }
  /** Lap A: into the crate wall, then slow through the spiral. */
  const smash = (view: any, track: any, input: any): any => {
    const s = view.car.s
    if (s > 225 && s < 335) return { ...input, throttle: input.throttle * 0.3 }
    if (s < 148 || s > 172) return input
    const point = query.pointAt(track, s + 10, -1.5)
    const travel = view.car.speed > 3 ? Math.atan2(view.car.vx, view.car.vz) : view.car.yaw
    const steer = Math.max(-1, Math.min(1, query.angleDelta(travel, Math.atan2(point.x - view.car.x, point.z - view.car.z)) * 3))
    return { ...input, throttle: 1, brake: 0, steer }
  }
  race.drive = (view: any, track: any) => {
    if (tr.restart) {
      tr.restart = false
      return { ...idle, restart: true }
    }
    if (tr.mode === "hold" || view.lap.phase === "finished") return idle
    const input = sim.botInput(view, track)
    return tr.mode === "A" ? smash(view, track, input) : input
  }

  w.__state = () => {
    const view = race.session.view()
    const replaying = race.rerun.active()
    const shown = replaying ? race.rerun.view() : view
    return {
      phase: view.lap.phase,
      t: view.lap.timeMs,
      s: shown.car.s,
      finishes: tr.finishes,
      replaying,
      wipe: !(document.querySelector(".tgp-wipe")?.hasAttribute("hidden") ?? true),
      board: (document.querySelector(".tgp-rows")?.getBoundingClientRect().width ?? 0) > 0,
      gained: document.querySelector(".tgp-gained")?.textContent ?? "",
      ghost: race.ghost.current()?.name ?? ""
    }
  }

  /** The middle of the table, for a zoom in from all of it. */
  const samples: Array<{ x: number; z: number }> = sim.track.samples
  const xs = samples.map((sample: any) => sample.x)
  const zs = samples.map((sample: any) => sample.z)
  const middle = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: 1.1, z: (Math.min(...zs) + Math.max(...zs)) / 2 }
  const flash = document.createElement("div")
  flash.style.cssText = "position:fixed;inset:0;z-index:40;pointer-events:none;background:#fff;opacity:0"
  document.documentElement.appendChild(flash)

  /**
   * Points the camera for this frame. `zoom` 1 is the whole table; above it the camera
   * follows the car (or, with `ghost`, the middle of the car and its ghost), leading it a
   * little, set off by `offset` metres, and kicked in by the last hits.
   */
  w.__camera = (shot: { zoom: number; lead: number; ghost: boolean; offsetX: number; offsetZ: number; fromTable: number; snap: boolean; ease: number }, seconds: number) => {
    tr.kick *= Math.exp(-seconds * 6)
    tr.flash *= Math.exp(-seconds * 14)
    flash.style.opacity = tr.flash < 0.01 ? "0" : String(tr.flash)
    if (shot.zoom <= 1) {
      tr.cam = null
      race.stage.focusOn(null)
      return
    }
    const view = race.session.view()
    const shown = race.rerun.active() ? race.rerun.view() : view
    const car = shown.car
    let x = car.x + car.vx * shot.lead
    let y = car.y
    let z = car.z + car.vz * shot.lead
    if (shot.ghost) {
      const ghost = race.ghost.pose(shown, view.lap.phase === "running")
      if (ghost !== null) {
        x = (car.x + ghost.x) / 2
        y = (car.y + ghost.y) / 2
        z = (car.z + ghost.z) / 2
      }
    }
    // Pulled toward the middle of the table by `fromTable` (1: the table's middle), for a zoom in from the whole table.
    const k = shot.fromTable
    const want = { x: x + shot.offsetX + (middle.x - x) * k, y: y + (middle.y - y) * k, z: z + shot.offsetZ + (middle.z - z) * k, zoom: shot.zoom }
    if (shot.snap || tr.cam === null) tr.cam = want
    else {
      const k = 1 - Math.exp(-seconds * shot.ease)
      tr.cam = { x: tr.cam.x + (want.x - tr.cam.x) * k, y: tr.cam.y + (want.y - tr.cam.y) * k, z: tr.cam.z + (want.z - tr.cam.z) * k, zoom: want.zoom }
    }
    race.stage.focusOn({ ...tr.cam, zoom: tr.cam.zoom * (1 + tr.kick) })
  }

  // The captions and the end card.
  const style = document.createElement("style")
  style.textContent = `
.tr-cap { position: fixed; left: 50%; bottom: 96px; z-index: 50; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; transform: translateX(-50%); }
.tr-cap.tr-left { left: 25%; }
.tr-cap b { display: block; font: italic 700 84px/1 "Chakra Petch", sans-serif; letter-spacing: 0.02em; color: #0b0f1f; background: #f6d32d; padding: 10px 34px 6px; transform: skewX(-12deg); box-shadow: 0 10px 0 #0b0f1f; white-space: nowrap; }
.tr-cap i { display: block; font: 500 26px/1 "JetBrains Mono", monospace; font-style: normal; letter-spacing: 0.14em; color: #fff; background: #0b0f1f; padding: 9px 18px 8px; transform: skewX(-12deg); white-space: nowrap; }
.tr-end { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; background: rgba(11, 15, 31, 0.86); backdrop-filter: blur(6px); color: #fff; pointer-events: none; }
.tr-end b { font: italic 700 120px/0.95 "Chakra Petch", sans-serif; color: #0b0f1f; background: #f6d32d; padding: 18px 50px 10px; transform: skewX(-12deg); box-shadow: 0 14px 0 #000; white-space: nowrap; }
.tr-end .tr-soon { font: 600 34px/1 "Chakra Petch", sans-serif; letter-spacing: 0.36em; color: #f6d32d; }
.tr-end .tr-made { display: flex; align-items: center; gap: 16px; font: 500 22px/1 "JetBrains Mono", monospace; letter-spacing: 0.16em; color: #b9c1d3; }
.tr-end .tr-made img { height: 38px; }
.tr-end .tr-made span.tr-3d { font: 700 34px/1 "Chakra Petch", sans-serif; color: #fff; letter-spacing: 0.02em; }
.tr-end .tr-by { position: absolute; bottom: 64px; color: #fff; height: 46px; }
.tr-end .tr-by svg { height: 46px; width: auto; }
`
  document.head.appendChild(style)
  const layer = document.createElement("div")
  document.documentElement.appendChild(layer)

  /**
   * A zoom on the whole page (canvas and panels), like a slow push in an editor: `scale` 1 is
   * the page as it is; above it the page grows about the board's top right corner, so the
   * board grows in place toward the middle of the window.
   */
  let corner: { x: number; y: number } | null = null
  w.__punch = (scale: number) => {
    if (scale <= 1) {
      document.body.style.transform = ""
      corner = null
      return
    }
    if (corner === null) {
      const rows = document.querySelector(".tgp-rows")
      const box = (rows?.closest(".tgp-panel") ?? rows)?.getBoundingClientRect()
      if (box === undefined) return
      corner = { x: box.right, y: box.top }
    }
    document.body.style.transformOrigin = `${corner.x}px ${corner.y}px`
    document.body.style.transform = `scale(${scale})`
  }

  const ease = (u: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3)
  /**
   * Draws the overlay for this frame. A caption slides in (0.22 s) and out (0.16 s) within
   * `duration`, with a little pop; the end card fades up.
   */
  w.__overlay = (o: null | { kind: "caption" | "end"; text: string; sub: string; left: boolean; u: number; duration: number }) => {
    if (o === null) {
      layer.innerHTML = ""
      layer.dataset.key = ""
      return
    }
    const key = `${o.kind}:${o.text}`
    if (layer.dataset.key !== key) {
      layer.dataset.key = key
      if (o.kind === "end") {
        layer.innerHTML = `<div class="tr-end"><b>TABLETOP GRAND PRIX</b><div class="tr-soon">COMING SOON</div><div class="tr-made">MADE WITH <img src="/src/host/brand/pixijs-logo.svg" alt=""><span class="tr-3d">3D</span></div><div class="tr-by">${lockupMarkup(46)}</div></div>`
      } else {
        layer.innerHTML = `<div class="tr-cap${o.left ? " tr-left" : ""}"><b>${o.text}</b>${o.sub === "" ? "" : `<i>${o.sub}</i>`}</div>`
      }
    }
    const root = layer.firstElementChild as HTMLElement
    if (o.kind === "end") {
      root.style.opacity = String(ease(o.u / 0.3))
      const title = root.querySelector("b") as HTMLElement
      title.style.transform = `skewX(-12deg) translateX(${(1 - ease(o.u / 0.3)) * -140}px) scale(${1 + 0.06 * Math.max(0, 1 - o.u / 0.5) * Math.sin(Math.min(1, o.u / 0.5) * Math.PI)})`
      return
    }
    const away = ease((o.u - (o.duration - 0.16)) / 0.16)
    const parts = Array.from(root.children) as Array<HTMLElement>
    parts.forEach((part, index) => {
      const lag = index * 0.06
      const inPart = ease((o.u - lag) / 0.2)
      // A little overshoot as it lands.
      const pop = 1 + 0.08 * Math.sin(Math.min(1, Math.max(0, (o.u - lag - 0.12) / 0.22)) * Math.PI)
      const shift = (1 - inPart) * -220 + away * 260
      part.style.transform = `skewX(-12deg) translateX(${shift}px) scale(${pop})`
      part.style.opacity = String(Math.min(inPart * 1.6, 1 - away))
      part.style.clipPath = `inset(-20px ${(1 - inPart) * 100}% -20px 0)`
    })
  }
})

type State = { phase: string; t: number; s: number; finishes: number; replaying: boolean; wipe: boolean; board: boolean; gained: string; ghost: string }
const state = (): Promise<State> => page.evaluate(() => (window as any).__state())

/** Runs the page on, unfilmed and three times as fast, until `done`. */
const skipUntil = async (done: (state: State) => boolean, limitSeconds: number = 90): Promise<void> => {
  for (let i = 0; i < (limitSeconds * FPS) / 3; i++) {
    if (done(await state())) return
    await advance(FRAME_MS * 3)
  }
  throw new Error("The page never got there")
}

type Pair = readonly [number, number]
type Caption = { readonly text: string; readonly sub?: string; readonly from?: number; readonly to?: number; readonly left?: boolean }

interface Shot {
  readonly seconds: number
  /** The camera's zoom over the shot, from the first to the second (1: the whole table). */
  readonly zoom: Pair
  /** The camera set off from the car, in metres along x and z, from the first to the second. */
  readonly slideX?: Pair
  readonly slideZ?: Pair
  readonly lead?: number
  readonly ghost?: boolean
  /** Starts on the whole table and closes in on the car as the zoom grows. */
  readonly fromTable?: boolean
  readonly ease?: number
  /** Whether this frame plays at half speed. */
  readonly slow?: (state: State) => boolean
  readonly caption?: Caption
  /** More than one caption, one after another. */
  readonly captions?: ReadonlyArray<Caption>
  /** For a shot that tells a story of its own: the zoom and the share of the whole table `u` seconds in. */
  readonly zoomAt?: (u: number) => number
  readonly fromTableAt?: (u: number) => number
  /** Before each frame, `u` seconds in: changes to the page. */
  readonly at?: (u: number) => Promise<void>
  readonly end?: boolean
  /** The page's zoom about the board over the shot, from the first to the second, steady (1: none). */
  readonly punch?: Pair
  /** Holds the board's rows still until this many seconds into the shot. */
  readonly holdRowsUntil?: number
}

const lerp = (pair: Pair, u: number): number => pair[0] + (pair[1] - pair[0]) * u
const smooth = (u: number): number => u * u * (3 - 2 * u)

let filmed = 0
/** Filmed frames of a running lap that moved the race on by more or less than they should (a stutter). */
let uneven = 0
/** The film's parts, each in its own folder: filmed in the race's order, put together in `order`. */
const parts = new Map<string, number>()
/** Films `shot.seconds` of video from now, as the part `name`. */
const film = async (name: string, shot: Shot): Promise<void> => {
  mkdirSync(`${frames}/${name}`, { recursive: true })
  let taken = parts.get(name) ?? 0
  const count = Math.round(shot.seconds * FPS)
  for (let i = 0; i < count; i++) {
    const now = await state()
    const ms = shot.slow?.(now) === true ? FRAME_MS / 2 : FRAME_MS
    const u = i / FPS
    const along = smooth(i / Math.max(1, count - 1))
    await page.evaluate((hold) => void ((window as any).__holdRows = hold), shot.holdRowsUntil !== undefined && u < shot.holdRowsUntil)
    await shot.at?.(u)
    const table = shot.fromTableAt?.(u) ?? (shot.fromTable === true ? 1 - along : 0)
    const camera = {
      zoom: shot.zoomAt?.(u) ?? lerp(shot.zoom, along),
      lead: shot.lead ?? 0.3,
      ghost: shot.ghost ?? false,
      offsetX: lerp(shot.slideX ?? [0, 0], along),
      offsetZ: lerp(shot.slideZ ?? [0, 0], along),
      fromTable: table,
      snap: i === 0 || table > 0,
      ease: shot.ease ?? 3
    }
    // The camera is placed before the frame is drawn, on where the car is going into it.
    await page.evaluate(([spec, seconds]) => (window as any).__camera(spec, seconds), [camera, ms / 1000] as const)
    const ticksBefore: number = await page.evaluate(() => (window as any).__ticks)
    await advance(ms)
    const ticked = (await page.evaluate(() => (window as any).__ticks)) - ticksBefore
    if (ticked !== Math.round((ms * 120) / 1000) && (await state()).phase !== "finished") uneven++
    if (shot.punch !== undefined) {
      await page.evaluate((value) => (window as any).__punch(value), lerp(shot.punch, i / Math.max(1, count - 1)))
    }
    const c = shot.caption ?? shot.captions?.find((one) => u >= (one.from ?? 0) && u < (one.to ?? shot.seconds))
    const from = c?.from ?? 0
    const to = c?.to ?? shot.seconds
    const overlay = shot.end === true
      ? { kind: "end", text: "end", sub: "", left: false, u, duration: shot.seconds }
      : c !== undefined && u >= from && u < to
        ? { kind: "caption", text: c.text, sub: c.sub ?? "", left: c.left ?? false, u: u - from, duration: to - from }
        : null
    await page.evaluate((value) => (window as any).__overlay(value), overlay)
    const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 94 })
    writeFileSync(`${frames}/${name}/${String(taken).padStart(5, "0")}.jpg`, Buffer.from(data, "base64"))
    taken++
    filmed++
  }
  parts.set(name, taken)
  await page.evaluate(() => (window as any).__overlay(null))
}

const log = async (name: string): Promise<void> => {
  const now = await state()
  console.log(`${name.padEnd(10)} at ${(filmed / FPS).toFixed(2)} s of film: lap ${now.phase} t=${(now.t / 1000).toFixed(2)} s=${now.s.toFixed(1)}`)
}

// ── the cut ──────────────────────────────────────────────────────────────
// Filmed in the race's order; the opener comes from lap B (see `order` below).

// Lap A: the balls, the crate wall into the rocks, the jump.
await page.evaluate(() => void ((window as any).__tr.mode = "A"))
await skipUntil((now) => now.phase === "running" && now.s >= 106 && now.s < 200)
await log("balls")
await film("balls", { seconds: 1.6, zoom: [2.5, 3.0], slow: (now) => now.t >= 6000 && now.t < 6450, caption: { text: "EVERYTHING MOVES", from: 0.1 } })
await skipUntil((now) => now.s >= 157 && now.s < 300)
await log("crates")
await film("crates", { seconds: 2.3, zoom: [3.2, 2.6], slow: (now) => now.t >= 7960 && now.t < 8500, caption: { text: "SMASH THROUGH", from: 0.1, to: 1.9 } })
await skipUntil((now) => now.s >= 346 && now.s < 420)
await log("jump")
await film("jump", { seconds: 1.8, zoom: [3.4, 2.3], slow: (now) => now.s >= 357 && now.s < 372, caption: { text: "CLEAR THE GAP", from: 0.15 } })

// Lap A done: it goes on the board; start again once its replay is up.
await skipUntil((now) => now.finishes >= 1 && now.replaying && now.board)
// Lap B races the board's fastest run: close to the bot's clean lap, so the ghost stays
// beside the car through the opener instead of dropping behind it.
const leader: string = await page.evaluate(() => {
  const top = (window as any).__race.online.state().board?.top[0]
  ;(window as any).__race.online.choose({ kind: "run", runId: top.runId })
  return top.name
})
await skipUntil((now) => now.ghost === leader)
await page.evaluate(() => {
  const tr = (window as any).__tr
  tr.mode = "B"
  tr.restart = true
})

// Lap B: the opener, one take of the same race: the whole table closing in on the car racing
// alone, its ghost popping in beside it, then the whole pack of 100 around it. Then the drift
// round the spiral, the finish, and straight to the board.
await page.evaluate(() => void ((window as any).__ghostAt = -1))
await skipUntil((now) => now.phase === "running" && now.t >= 2200)
await log("open")
const GHOST_IN = 3.4
const PACK_IN = 6.4
const span = (u: number, from: number, to: number): number => smooth(Math.max(0, Math.min(1, (u - from) / (to - from))))
await film("open", {
  seconds: 10.0,
  zoom: [1, 1],
  zoomAt: (u) => 1 + 1.3 * span(u, 0, GHOST_IN) - 0.55 * span(u, PACK_IN, PACK_IN + 1.2) - 0.2 * span(u, PACK_IN + 1.2, 10),
  fromTableAt: (u) => 1 - span(u, 0, GHOST_IN),
  at: async (u) => {
    if (u >= GHOST_IN) {
      await page.evaluate(() => {
        const w = window as any
        if (w.__ghostAt < 0) w.__ghostAt = performance.now()
      })
    }
    await page.evaluate((amount) => (window as any).__race.field.show(amount), Math.max(0, Math.min(1, (u - PACK_IN) / 0.35)))
  },
  captions: [
    { text: "TABLETOP TIME ATTACK", sub: "SET THE FASTEST LAP", from: 0.3, to: GHOST_IN - 0.3 },
    { text: "RACE YOUR GHOST", sub: "CHASE THE RUN TO BEAT", from: GHOST_IN, to: PACK_IN },
    { text: "RACE THE PACK", sub: "A WHOLE FIELD OF GHOSTS", from: PACK_IN + 0.05 }
  ]
})
await page.evaluate(() => {
  ;(window as any).__race.field.show(0)
  ;(window as any).__ghostAt = null
})
await skipUntil((now) => now.phase === "running" && now.s >= 270 && now.s < 340)
await log("drift")
await film("drift", { seconds: 2.6, zoom: [2.4, 2.9], caption: { text: "DRIFT", sub: "HOLD GAS + BRAKE", from: 0.15 } })
await skipUntil((now) => now.phase === "running" && now.s >= 453)
await log("finish")
await film("finish", { seconds: 1.4, zoom: [3.0, 2.5], slow: (now) => now.phase === "finished" || now.s > 463 || now.s < 2 })
// The wipe plays unfilmed; the board's rows wait for the zoom.
await page.evaluate(() => void ((window as any).__holdRows = true))
await skipUntil((now) => now.wipe)
await skipUntil((now) => !now.wipe && now.board)
await log("board")
await film("board", { seconds: 3.0, zoom: [1, 1], punch: [1.25, 1.4], holdRowsUntil: 0.4, caption: { text: "CLIMB THE BOARD", from: 0.25, left: true } })
const atEnd = await state()
console.log(`the row: ${atEnd.gained || "(no mark)"}`)
await film("end", { seconds: 2.8, zoom: [1, 1], punch: [1.4, 1.45], end: true })

await browser.close()

const video = `${out}/trailer.mp4`
const order = ["open", "balls", "crates", "jump", "drift", "finish", "board", "end"]
let index = 0
for (const name of order) {
  for (let i = 0; i < (parts.get(name) ?? 0); i++) renameSync(`${frames}/${name}/${String(i).padStart(5, "0")}.jpg`, `${frames}/${String(index++).padStart(5, "0")}.jpg`)
  rmSync(`${frames}/${name}`, { recursive: true, force: true })
}
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", `${frames}/%05d.jpg`, "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video])
if (!keepFrames) rmSync(frames, { recursive: true, force: true })
console.log(`${video}: ${(filmed / FPS).toFixed(1)} s, ${filmed} frames, ${uneven} uneven`)
for (const error of errors) console.error(`console error: ${error}`)
