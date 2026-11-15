/**
 * Passing a ghost: its name flashes over it for a moment, in its tint, rising and fading as
 * the car pulls away. A ghost counts as passed when the car goes from behind it to ahead of
 * it along the track (centreline distance), close by, while a lap runs; once per lap each.
 * Tags that come together stack, so a pack passed at once reads name by name.
 *
 * Drawn in 2D on the app's stage over the 3D, placed with `worldToScreen`, like the marker.
 */
import { Vector3 } from "@pixi/3d"
import { Container, Graphics, Point, Text } from "pixi.js"
import { locateBelow, locateNear, type RaceView, type TrackData } from "../sim/index.ts"
import type { GhostPose, Stage } from "./contract.ts"
import { hudLabelFont } from "./hud.ts"
import { palette } from "./palette.ts"

/** A ghost to watch: its key, its name (none for no tag), its tint and where it is. */
export interface Racer {
  readonly key: string
  readonly name: string
  readonly color: number
  readonly pose: GhostPose | null
}

/** How long a tag shows, in seconds. */
const LIFE = 1.4
/** Only a ghost this close along the track (metres) can be passed: far apart is the start line's wrap. */
const CLOSE = 20
/** A ghost is ahead or behind only by this much (metres), so the pack on the start line passes nobody. */
const CLEAR = 0.6
/** Tags this close in time stack, each this far above the one before (px). */
const STACK_AGE = 0.5
const STACK_STEP = 24

interface Watch {
  hint: number
  /** The ghost was ahead of the car last frame; null before it is known. */
  ahead: boolean | null
  passed: boolean
}

interface Tag {
  readonly node: Container
  readonly key: string
  /** Its place in a stack of tags that came together. */
  readonly row: number
  age: number
}

export const createPassTags = (stage: Stage, track: TrackData) => {
  const layer = new Container({ label: "pass-tags" })
  stage.app.stage.addChild(layer)
  const watches = new Map<string, Watch>()
  const tags: Array<Tag> = []
  const world = new Vector3()
  const screen = new Point()
  let attempt = -1

  const makeTag = (name: string, color: number): Container => {
    const node = new Container()
    const text = new Text({ text: name.toUpperCase(), style: { fontFamily: hudLabelFont, fontSize: 13, fontWeight: "600", fill: palette.hudText, letterSpacing: 1.5 } })
    const padX = 8
    const bar = 4
    const w = text.width + padX * 2 + bar
    const h = text.height + 6
    const plate = new Graphics()
    plate.roundRect(-w / 2, -h, w, h, 3).fill({ color: palette.hudBack, alpha: 0.82 })
    plate.rect(-w / 2, -h, bar, h).fill({ color })
    text.position.set(-w / 2 + bar + padX, -h + 3)
    node.addChild(plate, text)
    return node
  }

  /** Where `pose` is along the track, kept close to last frame's. */
  const along = (watch: Watch, pose: GhostPose): number => {
    if (watch.hint < 0) watch.hint = locateBelow(track, pose.x, pose.y, pose.z, 2, 1.5)?.index ?? 0
    const hit = locateNear(track, pose.x, pose.z, watch.hint)
    watch.hint = hit.index
    return hit.s
  }

  return {
    update(view: RaceView, racers: ReadonlyArray<Racer>, seconds: number): void {
      if (view.lap.attempt !== attempt) {
        attempt = view.lap.attempt
        watches.clear()
      }
      if (view.lap.phase === "running") {
        for (const racer of racers) {
          if (racer.name === "" || racer.pose === null) continue
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
            const node = makeTag(racer.name, racer.color)
            layer.addChild(node)
            const row = tags.filter((tag) => tag.age < STACK_AGE).length
            tags.push({ node, key: racer.key, row, age: 0 })
          }
          watch.ahead = ahead
        }
      }

      for (let i = tags.length - 1; i >= 0; i--) {
        const tag = tags[i]
        if (tag === undefined) continue
        tag.age += seconds
        const pose = racers.find((racer) => racer.key === tag.key)?.pose ?? null
        const point = pose === null ? null : (world.set(pose.x, pose.y + 1.1, pose.z), stage.view.worldToScreen(world, screen))
        if (tag.age >= LIFE || point === null) {
          tag.node.destroy({ children: true })
          tags.splice(i, 1)
          continue
        }
        const t = tag.age / LIFE
        tag.node.position.set(point.x, point.y - 6 - tag.row * STACK_STEP - t * 22)
        // In quickly, held, then out.
        tag.node.alpha = Math.min(1, tag.age / 0.12) * (t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1)
        tag.node.scale.set(t < 0.12 ? 0.85 + (t / 0.12) * 0.15 : 1)
      }
    }
  }
}

export type PassTags = ReturnType<typeof createPassTags>
