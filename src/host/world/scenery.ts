/**
 * Sparse, low-poly scenery on the slab: trees in clumps and a small grandstand by the start.
 * No cones, crates or tyre stacks: those stand on the road as things to hit, and look-alikes
 * on the grass would muddle what is in play.
 *
 * Rules: nothing on a road or within 2 m of one, nothing on an embankment, and nothing
 * tall where it would hide road behind it from the camera (a tall thing is checked along
 * the line away from the camera for as far as its height reaches on screen; when that
 * line crosses road, a low bush or nothing goes there instead).
 */
import type { TrackData } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { type MeshBuilder, mix, noise2, rgb, type Rgb, seeded, type Vec3 } from "./builder.ts"
import type { SlabBox } from "./dimensions.ts"
import type { Field } from "./field.ts"
import { buildBox } from "./road.ts"

const CLEARANCE = 2
const TREE = rgb(palette.tree)
const TREE_DARK = rgb(palette.treeDark)
const TRUNK = rgb(palette.trunk)
const CONCRETE = rgb(palette.concrete)
const CONCRETE_DARK = rgb(palette.concreteDark)
const SEAT = rgb(palette.seat)
const ROOF = rgb(palette.roof)

export interface SceneryView {
  /** Ground direction toward the camera (unit, horizontal). */
  readonly towardX: number
  readonly towardZ: number
  /** Ground distance a thing of height 1 covers on screen, away from the camera (1 / tan of the camera's elevation). */
  readonly reachPerHeight: number
}

/** `reserved`: ground already used by something else (the wind turbines), kept clear of trees. */
export const buildScenery = (
  field: Field,
  track: TrackData,
  slab: SlabBox,
  view: SceneryView,
  out: MeshBuilder,
  reserved: ReadonlyArray<{ readonly x: number; readonly z: number; readonly r: number }> = []
): void => {
  const random = seeded(0x51a7)
  const probe = { h: 0, covered: false }
  const taken: Array<{ x: number; z: number; r: number }> = reserved.map((spot) => ({ ...spot }))

  /** Flat grass at the terrain's top, away from road, not on anything already placed. */
  const groundAt = (x: number, z: number, radius: number): number | null => {
    if (x - radius < slab.minX + 0.8 || x + radius > slab.maxX - 0.8 || z - radius < slab.minZ + 0.8 || z + radius > slab.maxZ - 0.8) return null
    if (field.clearance(x, z) < CLEARANCE + radius) return null
    for (const [ox, oz] of [
      [0, 0],
      [radius, 0],
      [-radius, 0],
      [0, radius],
      [0, -radius]
    ] as const) {
      const p = field.heightAt(x + ox, z + oz, probe)
      if (p.covered || Math.abs(p.h - field.top) > 0.02) return null
    }
    for (const other of taken) if (Math.hypot(other.x - x, other.z - z) < other.r + radius) return null
    return field.top
  }

  /** True when a thing this tall at (x, z) would cover road behind it on screen. */
  const hidesRoad = (x: number, z: number, height: number, radius: number): boolean => {
    const reach = height * view.reachPerHeight + radius
    for (let t = 0; t <= reach; t += 0.5) {
      if (field.clearance(x - view.towardX * t, z - view.towardZ * t) < radius + 0.3) return true
    }
    return false
  }

  buildGrandstand(field, track, out, groundAt, hidesRoad, taken)

  // Trees, in clumps from a noise field.
  const area = (slab.maxX - slab.minX) * (slab.maxZ - slab.minZ)
  const attempts = Math.round(area / 6)
  for (let k = 0; k < attempts; k++) {
    const x = slab.minX + random() * (slab.maxX - slab.minX)
    const z = slab.minZ + random() * (slab.maxZ - slab.minZ)
    const clump = noise2(x * 0.06 + 11, z * 0.06 - 4)
    if (clump < 0.58 || random() > (clump - 0.58) * 3.2) continue
    const pine = random() < 0.4
    const height = pine ? 3.6 + random() * 1.4 : 3 + random() * 1.3
    const radius = pine ? 1.0 : 1.3 + random() * 0.3
    const ground = groundAt(x, z, radius)
    if (ground === null) continue
    if (hidesRoad(x, z, height, radius)) {
      // A low bush still fits, if it hides nothing either.
      if (hidesRoad(x, z, 1.1, 0.8) || random() < 0.4) continue
      bush(out, x, ground, z, 0.6 + random() * 0.4, random)
      taken.push({ x, z, r: 0.9 })
      continue
    }
    if (pine) pineTree(out, x, ground, z, height, radius, random)
    else roundTree(out, x, ground, z, height, radius, random)
    taken.push({ x, z, r: radius })
  }
}

/** A ring of `n` points at height y around (x, z). */
const ring = (x: number, y: number, z: number, radius: number, n: number, turn: number): Array<Vec3> =>
  Array.from({ length: n }, (_, k) => {
    const a = turn + (k / n) * Math.PI * 2
    return [x + Math.cos(a) * radius, y, z + Math.sin(a) * radius] as Vec3
  })

/** A faceted frustum (cylinder or cone) between two rings. */
export const frustum = (out: MeshBuilder, x: number, y0: number, z: number, r0: number, y1: number, r1: number, n: number, turn: number, lower: Rgb, upper: Rgb, cap: boolean): void => {
  const bottom = ring(x, y0, z, r0, n, turn)
  const top = ring(x, y1, z, Math.max(r1, 1e-4), n, turn)
  for (let k = 0; k < n; k++) {
    const a = bottom[k]!
    const b = bottom[(k + 1) % n]!
    const c = top[(k + 1) % n]!
    const d = top[k]!
    const mid = turn + ((k + 0.5) / n) * Math.PI * 2
    const toward: Vec3 = [Math.cos(mid), (r0 - r1) / Math.max(0.01, y1 - y0), Math.sin(mid)]
    if (r1 < 1e-3) out.flat([a, b, c], toward, [lower, lower, upper])
    else out.flat([a, b, c, d], toward, [lower, lower, upper, upper])
  }
  if (cap && r1 > 1e-3) out.flat(top, [0, 1, 0], upper)
}

const roundTree = (out: MeshBuilder, x: number, y: number, z: number, height: number, radius: number, random: () => number): void => {
  const trunk = height * 0.35
  frustum(out, x, y, z, 0.16, y + trunk + 0.3, 0.12, 5, random(), TRUNK, TRUNK, false)
  const tint = mix(TREE, TREE_DARK, random() * 0.6)
  // Two stacked, faceted blobs read as one low-poly crown.
  const crown = height - trunk
  const turn = random() * Math.PI
  frustum(out, x, y + trunk, z, radius * 0.7, y + trunk + crown * 0.45, radius, 7, turn, mix(tint, TREE_DARK, 0.5), tint, false)
  frustum(out, x, y + trunk + crown * 0.45, z, radius, y + height, radius * 0.35, 7, turn, tint, mix(tint, TREE, 0.4), true)
}

const pineTree = (out: MeshBuilder, x: number, y: number, z: number, height: number, radius: number, random: () => number): void => {
  frustum(out, x, y, z, 0.14, y + 0.6, 0.12, 5, random(), TRUNK, TRUNK, false)
  const tint = mix(TREE_DARK, TREE, random() * 0.4)
  const turn = random() * Math.PI
  frustum(out, x, y + 0.45, z, radius, y + height * 0.62, radius * 0.25, 6, turn, mix(tint, TREE_DARK, 0.6), tint, false)
  frustum(out, x, y + height * 0.42, z, radius * 0.72, y + height, 0, 6, turn + 0.5, mix(tint, TREE_DARK, 0.4), tint, false)
}

const bush = (out: MeshBuilder, x: number, y: number, z: number, size: number, random: () => number): void => {
  const tint = mix(TREE, TREE_DARK, random() * 0.5)
  frustum(out, x, y, z, size * 0.75, y + size * 0.55, size, 6, random(), mix(tint, TREE_DARK, 0.5), tint, false)
  frustum(out, x, y + size * 0.55, z, size, y + size * 1.1, size * 0.35, 6, random(), tint, tint, true)
}

type GroundAt = (x: number, z: number, radius: number) => number | null
type HidesRoad = (x: number, z: number, height: number, radius: number) => boolean

/**
 * A small grandstand facing the start straight, on whichever side has room and hides nothing.
 * Stepped concrete with rows of seats and a thin roof on posts.
 */
const buildGrandstand = (field: Field, track: TrackData, out: MeshBuilder, groundAt: GroundAt, hidesRoad: HidesRoad, taken: Array<{ x: number; z: number; r: number }>): void => {
  const length = 12
  const depth = 4.2
  const rows = 4
  const roofHeight = 3.6
  const count = field.sections.length
  const candidates: Array<{ along: number; side: 1 | -1; height: number }> = []
  for (const height of [2.2]) {
    for (const along of [6, -6, 14, -14, 0, 22, -22]) for (const side of [1, -1] as const) candidates.push({ along, side, height })
  }
  for (const { along, side, height } of candidates) {
    const i = ((Math.round(along / track.spacing) % count) + count) % count
    const s = field.sections[i]!
    const offset = s.hw + 0.6 + 2.6 + depth / 2
    const cx = s.x + s.lx * offset * side
    const cz = s.z + s.lz * offset * side
    // The stand's footprint, checked at its corners and centre.
    const corners: Array<[number, number]> = []
    for (const u of [-length / 2, 0, length / 2]) for (const v of [-depth / 2, depth / 2]) corners.push([cx + s.fx * u + s.lx * v, cz + s.fz * u + s.lz * v])
    if (!corners.every(([x, z]) => groundAt(x, z, 0.4) !== null)) continue
    if (corners.some(([x, z]) => hidesRoad(x, z, height, 0.4))) continue
    const yaw = s.sample.yaw
    // Seats face the road: rows climb away from it.
    const away = side
    const y = field.top
    for (let row = 0; row < rows; row++) {
      const rowDepth = depth / rows
      const v = (-depth / 2 + rowDepth * (row + 0.5)) * away
      const h = 0.35 + row * 0.42
      buildBox(out, cx + s.lx * v, y, cz + s.lz * v, yaw, rowDepth, h, length, CONCRETE, CONCRETE_DARK)
      const seatV = v - rowDepth * 0.18 * away
      buildBox(out, cx + s.lx * seatV, y + h, cz + s.lz * seatV, yaw, 0.38, 0.16, length - 0.6, SEAT, SEAT)
    }
    if (height > 3) {
      // Roof on a row of posts along the back.
      const backV = (depth / 2 - 0.2) * away
      for (const u of [-length / 2 + 0.4, 0, length / 2 - 0.4]) {
        buildBox(out, cx + s.fx * u + s.lx * backV, y, cz + s.fz * u + s.lz * backV, yaw, 0.18, roofHeight, 0.18, CONCRETE_DARK, CONCRETE_DARK)
      }
      const roofV = 0.3 * away
      buildBox(out, cx + s.lx * roofV, y + roofHeight, cz + s.lz * roofV, yaw, length + 0.6, 0.14, depth + 0.4, ROOF, ROOF)
    }
    taken.push({ x: cx, z: cz, r: length / 2 + 0.5 })
    return
  }
}
