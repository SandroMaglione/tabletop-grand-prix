/**
 * World lab: the stage and the world on their own, with the actors and a self-driving car
 * for scale.
 *
 * Query options:
 * - `track=fixture`: the fixture oval instead of the game's track.
 * - `zoom=3&x=..&z=..`: look closely at a point (zoom times the whole-track scale).
 * - `tilt=0`: turn the tilt-shift off. `bloom=1`: turn the bloom on (off in the game, see `StageOptions.bloom`). `renderer=webgpu`: ask for WebGPU.
 * - `shadow=high`, `filter=pcf`, `res=1.5`: try cheaper shadows or a lower pixel density.
 * - `bench=1`: time renders without vsync (see the end of this file).
 * - `drive=0`: the car stays on the line. `s=..`: start the self-driving car this far along.
 * - `actors=0`: the world alone: no actors, no car, nothing driven (for when the actors or
 *   the session are mid-edit). The actors are imported only when shown, so a broken
 *   actors module does not stop the world from drawing.
 * Frame timing shows top left and is kept on `window.worldLabStats`.
 */
import { angleDelta, createSession, fixtureTrack, idleInput, pointAt, type RaceView, type RaceSession, track as gameTrack } from "../../sim/index.ts"
import type { Actors } from "../contract.ts"
import { createStage, type StageOptions } from "../stage.ts"
import { createTrackScene } from "../world/index.ts"

const params = new URLSearchParams(location.search)
const track = params.get("track") === "fixture" ? fixtureTrack : gameTrack
const number = (name: string, fallback: number): number => {
  const value = Number(params.get(name))
  return params.has(name) && Number.isFinite(value) ? value : fallback
}

const options: StageOptions = {
  ...(params.get("renderer") === "webgpu" ? { preference: "webgpu" as const } : {}),
  ...(params.get("tilt") === "0" ? { tiltShift: false } : {}),
  ...(params.get("bloom") === "1" ? { bloom: true } : {}),
  ...(params.has("shadow") ? { shadowQuality: params.get("shadow") as "low" | "medium" | "high" | "ultra" } : {}),
  ...(params.has("filter") ? { shadowFilter: params.get("filter") as "hard" | "pcf" | "pcf-high" } : {}),
  ...(params.has("res") ? { maxResolution: number("res", 2) } : {}),
  ...(params.has("zoom") ? { focus: { x: number("x", 0), z: number("z", 0), zoom: number("zoom", 3) } } : {})
}

const built = performance.now()
const stage = await createStage(track, document.body, options)
const scene = createTrackScene(stage, track)
const buildMs = performance.now() - built
const withActors = params.get("actors") !== "0"
const actors: Actors | null = withActors ? (await import("../actors/index.ts")).createActors(stage, track) : null
const session: RaceSession | null = withActors ? createSession(track) : null
const drive = params.get("drive") !== "0"
/** What the world sees when nothing is driven: the car on the start line, nothing moving. */
const still: RaceView = {
  tick: 0,
  car: { ...track.start, pitch: 0, roll: 0, vx: 0, vy: 0, vz: 0, speed: 0, steer: 0, slip: 0, throttle: 0, brake: 0, grounded: true, boosting: false, s: 0, surface: "road" },
  lap: { phase: "ready", attempt: 1, timeMs: 0, splitsMs: [], nextCheckpoint: 1 },
  props: track.props.map((prop) => ({ x: prop.x, y: prop.y, z: prop.z, yaw: prop.yaw, vx: 0, vy: 0, vz: 0 })),
  doors: track.doors.map(() => 0)
}

/** Steers toward a point a little ahead on the centreline: enough to see the car at speed. */
const autopilot = (session: RaceSession) => {
  const car = session.view().car
  const ahead = pointAt(track, car.s + 9)
  const want = Math.atan2(ahead.x - car.x, ahead.z - car.z)
  const steer = Math.max(-1, Math.min(1, angleDelta(car.yaw, want) * 2.5))
  return { ...idleInput, throttle: Math.abs(steer) > 0.6 ? 0.6 : 1, steer }
}

const stats = { buildMs, frames: 0, averageMs: 0, fps: 0 }
Object.assign(window, { worldLabStats: stats })
const label = document.getElementById("stats")
let accumulated = 0
let sinceLabel = 0
stage.app.ticker.add((ticker) => {
  const seconds = ticker.deltaMS / 1000
  let view = still
  if (session !== null && actors !== null) {
    accumulated += seconds
    const step = 1 / session.hz
    let ticks = 0
    while (accumulated >= step && ticks < 8) {
      session.tick(drive ? autopilot(session) : idleInput)
      accumulated -= step
      ticks++
    }
    if (ticks === 8) accumulated = 0
    view = session.view()
    for (const event of session.drainEvents()) actors.handle(event, view)
  }
  scene.update(view, seconds)
  actors?.update(view, null, seconds)
  stats.frames++
  stats.averageMs += (ticker.deltaMS - stats.averageMs) * 0.05
  stats.fps = 1000 / stats.averageMs
  sinceLabel += seconds
  if (label !== null && sinceLabel > 0.5) {
    sinceLabel = 0
    label.textContent = `${track.name} · ${stage.app.renderer.name} · ${stats.averageMs.toFixed(1)} ms/frame · built in ${buildMs.toFixed(0)} ms`
  }
})

/**
 * `bench=1`: after the scene settles, stop the ticker and time 120 renders back to back,
 * each forced to finish (a one-pixel read on WebGL), for a frame cost free of vsync.
 */
if (params.get("bench") === "1") {
  setTimeout(() => {
    stage.app.ticker.stop()
    const renderer = stage.app.renderer
    const gl = "gl" in renderer ? (renderer.gl as WebGL2RenderingContext) : null
    const pixel = new Uint8Array(4)
    const finish = (): void => {
      if (gl !== null) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    }
    stage.app.render()
    finish()
    const start = performance.now()
    const frames = 120
    for (let i = 0; i < frames; i++) {
      stage.app.render()
      finish()
    }
    const ms = (performance.now() - start) / frames
    Object.assign(stats, { benchMs: ms })
    if (label !== null) label.textContent = `${track.name} · ${renderer.name} · ${ms.toFixed(2)} ms per render (bench, ${frames} frames) · built in ${buildMs.toFixed(0)} ms`
  }, 1500)
}
