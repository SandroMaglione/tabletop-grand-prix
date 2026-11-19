/**
 * Passing a ghost: a ring ripples out from it across the road, in its tint, and fades, with no
 * words over the race. A ghost counts as passed when the car goes from behind it to ahead of it
 * along the track (centreline distance), close by, while a lap runs; once per lap each.
 *
 * The ring is a circle on the ground around the ghost, each point projected with
 * `worldToScreen` and drawn in 2D over the 3D, so it lies in the table's perspective.
 */
import { Vector3 } from "@pixi/3d"
import { Container, Graphics, Point } from "pixi.js"
import { locateBelow, locateNear, type RaceView, type TrackData } from "../sim/index.ts"
import type { GhostPose, Stage } from "./contract.ts"

/** A ghost to watch: its key, whether passing it is marked, its tint and where it is. */
export interface Racer {
  readonly key: string
  /** False for a ghost whose passing is not marked (the player's own best: it drives their line). */
  readonly marked: boolean
  readonly color: number
  readonly pose: GhostPose | null
}

/** How long a ring ripples, in seconds. */
const LIFE = 0.75
/** Its radius on the ground (metres; a car is 2.4 long), from first to last. */
const FROM = 1.1
const TO = 3.4
/** Points around it. */
const SIDES = 32
/** Only a ghost this close along the track (metres) can be passed: far apart is the start line's wrap. */
const CLOSE = 20
/** A ghost is ahead or behind only by this much (metres), so the pack on the start line passes nobody. */
const CLEAR = 0.6

interface Watch {
  hint: number
  /** The ghost was ahead of the car last frame; null before it is known. */
  ahead: boolean | null
  passed: boolean
}

interface Ripple {
  readonly node: Graphics
  readonly key: string
  readonly color: number
  age: number
}

export const createPassMarks = (stage: Stage, track: TrackData) => {
  const layer = new Container({ label: "pass-marks" })
  stage.app.stage.addChild(layer)
  const watches = new Map<string, Watch>()
  const ripples: Array<Ripple> = []
  const world = new Vector3()
  const screen = new Point()
  let attempt = -1

  /** Where `pose` is along the track, kept close to last frame's. */
  const along = (watch: Watch, pose: GhostPose): number => {
    if (watch.hint < 0) watch.hint = locateBelow(track, pose.x, pose.y, pose.z, 2, 1.5)?.index ?? 0
    const hit = locateNear(track, pose.x, pose.z, watch.hint)
    watch.hint = hit.index
    return hit.s
  }

  /** Draws `ripple` around `pose` at its age: wide and thin as it goes, gone at the end. */
  const draw = (ripple: Ripple, pose: GhostPose): void => {
    const t = ripple.age / LIFE
    // Out fast, then slower: the push of the pass, settling.
    const spread = 1 - (1 - t) * (1 - t) * (1 - t)
    const radius = FROM + (TO - FROM) * spread
    const g = ripple.node
    g.clear()
    for (let i = 0; i <= SIDES; i++) {
      const angle = (i / SIDES) * Math.PI * 2
      world.set(pose.x + Math.cos(angle) * radius, pose.y + 0.05, pose.z + Math.sin(angle) * radius)
      const point = stage.view.worldToScreen(world, screen)
      // Off the camera's side: nothing to draw this frame.
      if (point === null) return void g.clear()
      if (i === 0) g.moveTo(point.x, point.y)
      else g.lineTo(point.x, point.y)
    }
    g.stroke({ color: ripple.color, width: 3.2 - 2 * t, alpha: 0.9 * (1 - t) })
  }

  return {
    update(view: RaceView, racers: ReadonlyArray<Racer>, seconds: number): void {
      if (view.lap.attempt !== attempt) {
        attempt = view.lap.attempt
        watches.clear()
      }
      if (view.lap.phase === "running") {
        for (const racer of racers) {
          if (!racer.marked || racer.pose === null) continue
          let watch = watches.get(racer.key)
          if (watch === undefined) {
            watch = { hint: -1, ahead: null, passed: false }
            watches.set(racer.key, watch)
          }
          if (watch.passed) continue
          const gap = along(watch, racer.pose) - view.car.s
          if (Math.abs(gap) > CLOSE) {
            watch.ahead = null
            continue
          }
          if (Math.abs(gap) < CLEAR) continue
          const ahead = gap > 0
          if (watch.ahead === true && !ahead) {
            watch.passed = true
            const node = new Graphics()
            layer.addChild(node)
            ripples.push({ node, key: racer.key, color: racer.color, age: 0 })
          }
          watch.ahead = ahead
        }
      }

      for (let i = ripples.length - 1; i >= 0; i--) {
        const ripple = ripples[i]
        if (ripple === undefined) continue
        ripple.age += seconds
        const pose = racers.find((racer) => racer.key === ripple.key)?.pose ?? null
        if (ripple.age >= LIFE || pose === null) {
          ripple.node.destroy()
          ripples.splice(i, 1)
          continue
        }
        draw(ripple, pose)
      }
    }
  }
}

export type PassMarks = ReturnType<typeof createPassMarks>
