/**
 * Swing doors: each leaf is a striped barrier board on a steel hinge post at the wall. The
 * simulation says how far each leaf has turned; the picture adds what a real board does when a
 * car slams through it: it swings a little past where it stops and shudders back, the board
 * jumps on its hinge, and it flashes.
 */
import { Container3D, Material3D, Mesh3D } from "@pixi/3d"
import type { SwingDoor } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { clamp } from "./pose.ts"
import { barrierTexture, lathe, roundedBox } from "./shapes.ts"
import type { LatheRing } from "./shapes.ts"

/** Stripe period along the board, metres. */
const STRIPE = 0.9
/** Gap under the board. */
const CLEARANCE = 0.16
const POST_RADIUS = 0.11

const postProfile = (r: number, h: number): ReadonlyArray<LatheRing> => {
  const steel = palette.hinge
  const cap = palette.hazardYellow
  return [
    [0, 0, steel],
    [r * 1.5, 0, steel],
    [r * 1.5, 0.05, steel],
    [r, 0.08, steel],
    [r, h - 0.1, steel],
    [r, h - 0.1, cap],
    [r * 1.08, h - 0.07, cap],
    [r * 0.9, h - 0.01, cap],
    [0, h, cap]
  ]
}

export const createDoors = (parent: Container3D, leaves: ReadonlyArray<SwingDoor>) => {
  const layer = new Container3D({ label: "doors", parent })
  const boardMaterial = new Material3D({ baseColorTexture: barrierTexture(palette.doorWhite, palette.doorRed), roughness: 0.6, emissive: { color: 0xffffff, strength: 0 }, passes: { outline: true } })
  const postMaterial = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.45, metallic: 0.4, passes: { outline: true } })
  const entries = leaves.map((leaf) => {
    const root = new Container3D({ position: { x: leaf.x, y: leaf.y, z: leaf.z }, parent: layer, label: "door" })
    new Mesh3D({ geometry: lathe(postProfile(POST_RADIUS, leaf.height + 0.22), 16), material: postMaterial, castShadow: true, receiveShadow: true, parent: root })
    const swing = new Container3D({ rotation: { x: 0, y: leaf.yaw, z: 0 }, parent: root })
    const boardHeight = leaf.height - CLEARANCE
    const length = leaf.length - POST_RADIUS * 1.6
    const start = POST_RADIUS * 1.4
    const material = boardMaterial.clone()
    // The board runs along +Z from the post; stripes are projected along its length so both faces match.
    const geometry = roundedBox({
      width: leaf.thickness,
      height: boardHeight,
      depth: length,
      radius: Math.min(0.06, leaf.thickness * 0.4),
      segments: 2,
      project: (_x, y, z, out) => {
        out.u = (z + length / 2) / STRIPE
        out.v = 1 - (y + boardHeight / 2) / boardHeight
      }
    })
    const board = new Mesh3D({ geometry, material, position: { x: 0, y: CLEARANCE + boardHeight / 2, z: start + length / 2 }, castShadow: true, receiveShadow: true, parent: swing })
    return { leaf, swing, board, material, boardY: CLEARANCE + boardHeight / 2, last: 0, extra: 0, extraSpeed: 0, jump: 0, jumpSpeed: 0, flash: 0 }
  })
  return {
    /** The car hit leaf `index`: it swings on past the simulation's angle and shudders back. */
    hit(index: number, impact: number, pushX: number, pushZ: number) {
      const entry = entries[index]
      if (entry === undefined) return
      const strength = clamp(impact / 10, 0, 1.4)
      // Overshoot the way the car pushes it: a positive turn moves the leaf toward its own left.
      const heading = entry.leaf.yaw + entry.last
      const way = Math.sign(pushX * Math.cos(heading) - pushZ * Math.sin(heading)) || Math.sign(entry.last) || 1
      entry.extraSpeed += way * strength * 2.2
      entry.jumpSpeed += strength * 1.1
      entry.flash = clamp(0.35 + strength * 0.6, 0, 1)
    },
    reset() {
      for (const entry of entries) {
        entry.extra = 0
        entry.extraSpeed = 0
        entry.jump = 0
        entry.jumpSpeed = 0
        entry.flash = 0
        entry.last = 0
        if (entry.material.emissive !== undefined) entry.material.emissive.strength = 0
      }
    },
    update(angles: ReadonlyArray<number>, seconds: number) {
      const dt = clamp(seconds, 0, 0.05)
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (entry === undefined) continue
        const angle = angles[i] ?? 0
        entry.last = angle
        entry.extraSpeed += (-entry.extra * 140 - entry.extraSpeed * 7) * dt
        entry.extra += entry.extraSpeed * dt
        entry.jumpSpeed += (-entry.jump * 600 - entry.jumpSpeed * 14) * dt
        entry.jump = clamp(entry.jump + entry.jumpSpeed * dt, -0.04, 0.07)
        // Never past the wall it is hinged on.
        const limit = entry.leaf.maxAngle + 0.08
        entry.swing.rotation.y = entry.leaf.yaw + clamp(angle + entry.extra, -limit, limit)
        entry.board.position.y = entry.boardY + entry.jump
        // A slight twist along the board while it shudders.
        entry.board.rotation.z = entry.jump * 0.6
        if (entry.flash > 0) {
          entry.flash = Math.max(0, entry.flash - dt * 6)
          if (entry.material.emissive !== undefined) entry.material.emissive.strength = entry.flash * entry.flash * 0.4
        }
      }
    }
  }
}

export type Doors = ReturnType<typeof createDoors>
