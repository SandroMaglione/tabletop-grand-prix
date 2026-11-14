/**
 * A few wind turbines along the back of the slab, turning slowly: the one thing in the
 * world that moves on its own, and their blades' shadows sweep the grass in front of them.
 *
 * They stand where neither they nor their shadows reach any road: a tall thing covers the
 * ground behind it on screen, and its shadow falls away from the sun, so both lines are
 * checked. Satin white, a little glossier than the matte model around them, with a red
 * warning light on each nacelle that pulses slowly, all in step like a real wind farm (it
 * is emissive past 1, so the stage's bloom gives it a soft glow).
 */
import { Container3D, Material3D, Mesh3D } from "@pixi/3d"
import { palette } from "../palette.ts"
import { MeshBuilder, rgb, type Vec3 } from "./builder.ts"
import type { SlabBox } from "./dimensions.ts"
import type { Field } from "./field.ts"
import { buildBox } from "./road.ts"
import { frustum } from "./scenery.ts"

const TOWER_HEIGHT = 5.3
const BLADE_LENGTH = 2.25
/** From the tower's foot to the tip of a blade pointing up. */
const TOTAL_HEIGHT = TOWER_HEIGHT + 0.25 + BLADE_LENGTH
/** Distance kept from the slab's edge and between turbines. */
const EDGE_INSET = 2.2
const SPACING = 8.5
const MAX_TURBINES = 3
/** Turns per second, and the warning light's period in seconds. */
const SPIN = 0.17
const BLINK = 2.6
/** The way the rotors face (a yaw): toward the camera's side, turned a little so the discs show some depth. */
const FACING = (38 * Math.PI) / 180

export interface TurbineView {
  /** Ground direction toward the camera (unit, horizontal), and the ground a thing of height 1 covers behind it on screen. */
  readonly towardX: number
  readonly towardZ: number
  readonly reachPerHeight: number
  /** Ground direction the shadows fall in (unit, horizontal), and their length per metre of height. */
  readonly shadowX: number
  readonly shadowZ: number
  readonly shadowPerHeight: number
}

export interface Turbines {
  readonly root: Container3D
  /** Ground they use, for the scenery to keep clear. */
  readonly spots: ReadonlyArray<{ readonly x: number; readonly z: number; readonly r: number }>
  update(seconds: number): void
}

/** Spots on the back half of the slab's border where a turbine hides no road and shades none. */
const placeTurbines = (field: Field, slab: SlabBox, view: TurbineView): Array<{ x: number; z: number }> => {
  const probe = { h: 0, covered: false }
  const candidates: Array<{ x: number; z: number; score: number }> = []
  const consider = (x: number, z: number): void => {
    if (field.clearance(x, z) < 3) return
    const ground = field.heightAt(x, z, probe)
    if (ground.covered || Math.abs(ground.h - field.top) > 0.01) return
    let score = Number.POSITIVE_INFINITY
    // The rotor's disc reaches BLADE_LENGTH sideways as well as up.
    for (let t = 0; t <= TOTAL_HEIGHT * view.reachPerHeight + BLADE_LENGTH; t += 0.5) score = Math.min(score, field.clearance(x - view.towardX * t, z - view.towardZ * t))
    for (let t = 0; t <= TOTAL_HEIGHT * view.shadowPerHeight + BLADE_LENGTH; t += 0.5) score = Math.min(score, field.clearance(x + view.shadowX * t, z + view.shadowZ * t))
    if (score > 0.8) candidates.push({ x, z, score })
  }
  const middleZ = (slab.minZ + slab.maxZ) / 2
  for (let x = slab.minX + EDGE_INSET; x <= slab.maxX - EDGE_INSET; x += 1) consider(x, slab.minZ + EDGE_INSET)
  for (let z = slab.minZ + EDGE_INSET + 1; z < middleZ; z += 1) {
    consider(slab.minX + EDGE_INSET, z)
    consider(slab.maxX - EDGE_INSET, z)
  }
  candidates.sort((a, b) => b.score - a.score)
  const chosen: Array<{ x: number; z: number }> = []
  for (const spot of candidates) {
    if (chosen.length >= MAX_TURBINES) break
    if (chosen.every((other) => Math.hypot(other.x - spot.x, other.z - spot.z) >= SPACING)) chosen.push(spot)
  }
  return chosen
}

/** One rotor around its hub, facing +Z: three tapered blades and a nose cone. */
const rotorGeometry = (): MeshBuilder => {
  const out = new MeshBuilder()
  const white = rgb(palette.turbine)
  const shade = rgb(0xd9d6ce)
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2
    const ux = Math.cos(a)
    const uy = Math.sin(a)
    // Across the blade, in the disc's plane.
    const vx = -uy
    const vy = ux
    const at = (along: number, across: number, depth: number): Vec3 => [ux * along + vx * across, uy * along + vy * across, depth]
    const root = 0.16
    const tip = BLADE_LENGTH
    const wideRoot = 0.17
    const wideTip = 0.05
    const thick = 0.035
    // Front and back faces, and the two long edges.
    out.flat([at(root, -wideRoot, thick), at(tip, -wideTip, thick), at(tip, wideTip * 0.4, thick), at(root, wideRoot, thick)], [0, 0, 1], white)
    out.flat([at(root, -wideRoot, -thick), at(tip, -wideTip, -thick), at(tip, wideTip * 0.4, -thick), at(root, wideRoot, -thick)], [0, 0, -1], shade)
    out.flat([at(root, wideRoot, thick), at(tip, wideTip * 0.4, thick), at(tip, wideTip * 0.4, -thick), at(root, wideRoot, -thick)], [vx, vy, 0], white)
    out.flat([at(root, -wideRoot, thick), at(tip, -wideTip, thick), at(tip, -wideTip, -thick), at(root, -wideRoot, -thick)], [-vx, -vy, 0], shade)
  }
  // The nose: a short cone along +Z over the blades' roots.
  const sides = 10
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * Math.PI * 2
    const a1 = ((k + 1) / sides) * Math.PI * 2
    const mid = (a0 + a1) / 2
    const ring = (a: number): Vec3 => [Math.cos(a) * 0.2, Math.sin(a) * 0.2, -0.12]
    out.flat([ring(a0), ring(a1), [0, 0, 0.32]], [Math.cos(mid), Math.sin(mid), 0.4], white)
  }
  return out
}

export const buildTurbines = (field: Field, slab: SlabBox, view: TurbineView): Turbines => {
  const root = new Container3D({ label: "turbines" })
  const spots = placeTurbines(field, slab, view)
  const satin = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.42, metallic: 0 })
  const light = new Material3D({ baseColor: 0x330806, roughness: 0.5, metallic: 0, emissive: { color: palette.turbineLight, strength: 0 } })

  // Towers and nacelles, in one mesh.
  const body = new MeshBuilder()
  const white = rgb(palette.turbine)
  const foot = rgb(0xcfccc4)
  const fx = Math.sin(FACING)
  const fz = Math.cos(FACING)
  for (const spot of spots) {
    const y = field.top
    buildBox(body, spot.x, y - 0.05, spot.z, FACING, 0.9, 0.2, 0.9, foot, foot)
    frustum(body, spot.x, y, spot.z, 0.27, y + TOWER_HEIGHT, 0.15, 12, 0, foot, white, false)
    buildBox(body, spot.x - fx * 0.1, y + TOWER_HEIGHT - 0.05, spot.z - fz * 0.1, FACING, 0.42, 0.4, 1.0, white, white)
  }
  root.addChild(new Mesh3D({ label: "turbine towers", geometry: body.geometry(), material: satin }))

  const rotor = rotorGeometry().geometry()
  const blinker = new MeshBuilder()
  const rotors: Array<{ mesh: Mesh3D; phase: number }> = []
  spots.forEach((spot, k) => {
    const hub = new Container3D({ position: { x: spot.x + fx * 0.48, y: field.top + TOWER_HEIGHT + 0.15, z: spot.z + fz * 0.48 }, rotation: { x: 0, y: FACING, z: 0 } })
    const mesh = new Mesh3D({ label: "rotor", geometry: rotor, material: satin })
    hub.addChild(mesh)
    root.addChild(hub)
    rotors.push({ mesh, phase: k * 1.7 })
    buildBox(blinker, spot.x - fx * 0.35, field.top + TOWER_HEIGHT + 0.35, spot.z - fz * 0.35, FACING, 0.1, 0.08, 0.1, rgb(0xffffff), rgb(0xffffff))
  })
  if (spots.length > 0) root.addChild(new Mesh3D({ label: "turbine lights", geometry: blinker.geometry(), material: light, castShadow: false }))

  let time = 0
  return {
    root,
    spots: spots.map((spot) => ({ x: spot.x, z: spot.z, r: 1.4 })),
    update(seconds) {
      time += seconds
      for (const entry of rotors) entry.mesh.rotation.z = -(time * SPIN * Math.PI * 2 + entry.phase)
      // A slow pulse: dark most of the time, a soft glow once a period.
      const phase = (time % BLINK) / BLINK
      const pulse = Math.max(0, Math.sin(phase * Math.PI * 2))
      if (light.emissive !== undefined) light.emissive.strength = 0.2 + 3.2 * pulse * pulse * pulse
    }
  }
}
