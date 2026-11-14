/**
 * A ring drawn in 2D over the car while a bridge deck hides it, so the player never loses it.
 *
 * Each frame asks the track for the highest road surface above the car's spot; when that surface
 * is well above the car, the car is under a deck. The ring is a Pixi `Graphics` on the app's
 * stage, placed with `worldToScreen`, and fades in and out.
 */
import { Vector3 } from "@pixi/3d"
import { Graphics, Point } from "pixi.js"
import { locateBelow } from "../../sim/index.ts"
import type { CarView, TrackData } from "../../sim/index.ts"
import type { Stage } from "../contract.ts"
import { palette } from "../palette.ts"

/** A surface this far above the car counts as a deck over it. */
const CLEARANCE = 1.5

export const createMarker = (stage: Stage, track: TrackData) => {
  const ring = new Graphics()
  ring.circle(0, 0, 15).stroke({ color: palette.hudPanel, width: 6, alpha: 0.9 })
  ring.circle(0, 0, 15).stroke({ color: palette.car, width: 3 })
  ring.circle(0, 0, 3).fill({ color: palette.car })
  ring.alpha = 0
  ring.visible = false
  stage.app.stage.addChild(ring)
  const world = new Vector3()
  const screen = new Point()
  let shown = 0
  let time = 0
  return {
    update(car: CarView, seconds: number) {
      time += seconds
      const over = locateBelow(track, car.x, 1000, car.z)
      const hidden = over !== null && over.y > car.y + CLEARANCE
      shown = Math.max(0, Math.min(1, shown + (hidden ? seconds : -seconds) * 6))
      ring.visible = shown > 0
      if (!ring.visible) return
      world.set(car.x, car.y + 0.5, car.z)
      const point = stage.view.worldToScreen(world, screen)
      if (point === null) {
        ring.visible = false
        return
      }
      ring.position.set(point.x, point.y)
      ring.alpha = shown
      ring.scale.set(1 + Math.sin(time * 6) * 0.06)
    }
  }
}

export type Marker = ReturnType<typeof createMarker>
