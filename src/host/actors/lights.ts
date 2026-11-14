/**
 * Short real lights for hits: a warm point light that blinks where something is struck and
 * lights the road, the walls and the props around it for a moment. Pooled, so a burst of hits
 * reuses the oldest light. A light at zero is switched off (`visible = false` costs nothing).
 */
import { PointLight } from "@pixi/3d"
import type { Container3D } from "@pixi/3d"
import { palette } from "../palette.ts"
import { clamp } from "./pose.ts"

const POOL = 3
/** How long a blink lasts, seconds. */
const LIFE = 0.16

export const createHitLights = (parent: Container3D) => {
  const lights = Array.from({ length: POOL }, () => ({
    light: new PointLight({ color: palette.hitLight, intensity: 0, range: 4, visible: false, parent }),
    age: LIFE,
    peak: 0
  }))
  let next = 0
  return {
    /** A blink at (x, y, z); `strength` 0 to 1 sets its brightness and reach. */
    blink(x: number, y: number, z: number, strength: number) {
      const slot = lights[next]
      next = (next + 1) % POOL
      if (slot === undefined) return
      const s = clamp(strength, 0, 1)
      slot.light.position.set(x, y + 0.9, z)
      slot.light.range = 2.5 + s * 3.5
      slot.peak = 4 + s * 18
      slot.age = 0
      slot.light.visible = true
    },
    reset() {
      for (const slot of lights) {
        slot.age = LIFE
        slot.light.visible = false
      }
    },
    update(seconds: number) {
      for (const slot of lights) {
        if (slot.age >= LIFE) continue
        slot.age += seconds
        const t = Math.min(1, slot.age / LIFE)
        slot.light.intensity = slot.peak * (1 - t) * (1 - t)
        if (t >= 1) slot.light.visible = false
      }
    }
  }
}

export type HitLights = ReturnType<typeof createHitLights>
