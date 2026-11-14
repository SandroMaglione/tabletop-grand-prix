/**
 * Bollards: concrete posts fixed in the road, with a yellow cap and a hazard band so they read
 * from above. They never move; a hit makes the post shudder on its footing (a few degrees,
 * springing back) and flash.
 */
import { Container3D, Material3D, Mesh3D } from "@pixi/3d"
import type { Bollard } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { clamp } from "./pose.ts"
import { lathe } from "./shapes.ts"
import type { LatheRing } from "./shapes.ts"

const postProfile = (r: number, h: number): ReadonlyArray<LatheRing> => {
  const concrete = palette.bollard
  const yellow = palette.hazardYellow
  const black = palette.hazardBlack
  const bandTop = h - 0.12
  return [
    [0, 0, concrete],
    [r * 1.06, 0, concrete],
    [r * 1.06, 0.05, concrete],
    [r, 0.08, concrete],
    [r, bandTop - 0.36, concrete],
    [r, bandTop - 0.36, yellow],
    [r, bandTop - 0.27, yellow],
    [r, bandTop - 0.27, black],
    [r, bandTop - 0.18, black],
    [r, bandTop - 0.18, yellow],
    [r, bandTop - 0.09, yellow],
    [r, bandTop - 0.09, black],
    [r, bandTop, black],
    [r, bandTop, yellow],
    [r * 0.97, h - 0.06, yellow],
    [r * 0.82, h - 0.018, yellow],
    [r * 0.45, h, yellow],
    [0, h, yellow]
  ]
}

export const createBollards = (parent: Container3D, posts: ReadonlyArray<Bollard>) => {
  const layer = new Container3D({ label: "bollards", parent })
  const base = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.8, emissive: { color: 0xffffff, strength: 0 }, passes: { outline: true } })
  const shapes = new Map<string, ReturnType<typeof lathe>>()
  const entries = posts.map((post) => {
    const key = `${post.radius}:${post.height}`
    const geometry = shapes.get(key) ?? lathe(postProfile(post.radius, post.height), 24)
    shapes.set(key, geometry)
    const material = base.clone()
    const root = new Container3D({ position: { x: post.x, y: post.y, z: post.z }, parent: layer, label: "bollard" })
    const tilt = new Container3D({ parent: root })
    new Mesh3D({ geometry, material, castShadow: true, receiveShadow: true, parent: tilt })
    return { post, root, tilt, material, side: 0, lean: 0, leanSpeed: 0, flash: 0 }
  })
  return {
    /** The car hit post `index`; it leans away from the car. */
    hit(index: number, impact: number, fromX: number, fromZ: number) {
      const entry = entries[index]
      if (entry === undefined) return
      const away = Math.atan2(entry.post.x - fromX, entry.post.z - fromZ)
      entry.side = away
      entry.leanSpeed += clamp(impact, 0, 20) * 0.11
      entry.flash = clamp(0.4 + impact / 12, 0, 1)
    },
    reset() {
      for (const entry of entries) {
        entry.lean = 0
        entry.leanSpeed = 0
        entry.flash = 0
        if (entry.material.emissive !== undefined) entry.material.emissive.strength = 0
      }
    },
    update(seconds: number) {
      const dt = clamp(seconds, 0, 0.05)
      for (const entry of entries) {
        if (entry.lean === 0 && entry.leanSpeed === 0 && entry.flash === 0) continue
        // A stiff spring: the post is set in concrete and only shudders.
        entry.leanSpeed += (-entry.lean * 520 - entry.leanSpeed * 9) * dt
        entry.lean = clamp(entry.lean + entry.leanSpeed * dt, -0.16, 0.16)
        if (Math.abs(entry.lean) < 1e-4 && Math.abs(entry.leanSpeed) < 1e-3) {
          entry.lean = 0
          entry.leanSpeed = 0
        }
        // Lean about the horizontal axis across the push: +Y tips toward `side`.
        entry.tilt.rotation.set(Math.cos(entry.side) * entry.lean, 0, -Math.sin(entry.side) * entry.lean)
        if (entry.flash > 0) {
          entry.flash = Math.max(0, entry.flash - dt * 6)
          if (entry.material.emissive !== undefined) entry.material.emissive.strength = entry.flash * entry.flash * 0.45
        }
      }
    }
  }
}

export type Bollards = ReturnType<typeof createBollards>
