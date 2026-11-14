/**
 * The road as a shape the terrain is cut from.
 *
 * Every segment between two samples is one of:
 * - `cut`: ground or solid road. It owns a footprint (the road plus a wall band on each
 *   side) that the terrain leaves open, and it raises the terrain around it: up to the
 *   wall tops beside it, then falling away as an embankment. A road at y = 0 has its wall
 *   tops at the terrain's top, so it is simply a channel; a raised road becomes a solid
 *   mass with parapets.
 * - `bridge`: a deck on pillars. It changes nothing on the ground.
 * - `gap`: a jump gap. No road at all.
 *
 * `heightAt` is the terrain height at any point (and whether a channel covers it). Wall
 * tops are read from it, so walls always meet the terrain they belong to, even where an
 * embankment from another part of the track crowds a lower road.
 */
import type { TrackData, TrackSample } from "../../sim/index.ts"

/** Width of the wall band on each side of a cut road: the wall's top, and the strip that hides the terrain's ragged edge. */
export const WALL_BAND = 0.6
/** Terrain points closer than this past the road's edge are left out of the terrain mesh (inside the band, so the hole's edge stays under it). */
export const HOLE_INSET = 0.12
/** Embankment steepness: metres of drop per metre outward. */
export const EMBANKMENT_SLOPE = 1.5
/** Parapet thickness on bridges: as wide as a cut road's wall band, so a deck's parapet runs on from the band where the two meet. */
export const BRIDGE_PARAPET = WALL_BAND
/** Depth of a bridge deck below the road surface. */
export const BRIDGE_DEPTH = 0.75
/** Road this much below another road's surface passes under it: the upper road is drawn as a deck there. */
const DECK_CLEARANCE = 2.4
/** How far past its ends a segment of cut road still shapes the terrain, in metres. */
const END_REACH = 0.4
/** How far a deck reaches past the last point over lower road, so its abutments stand clear. */
const DECK_MARGIN = 2.5
export type SegmentKind = "cut" | "bridge" | "gap"

/** A sample with the directions and edge heights the meshes need. */
export interface Section {
  readonly sample: TrackSample
  readonly index: number
  readonly x: number
  readonly y: number
  readonly z: number
  /** Horizontal left of the direction of travel. */
  readonly lx: number
  readonly lz: number
  /** Horizontal direction of travel. */
  readonly fx: number
  readonly fz: number
  readonly hw: number
  readonly tanBank: number
  /** Road surface height at each edge. */
  readonly edgeLeft: number
  readonly edgeRight: number
  /** Up direction of the road surface. */
  readonly normal: readonly [number, number, number]
}

/** Where a run of cut road stops: a ramp's cliff, a landing's start, a bridge abutment. */
export interface RunEnd {
  /** The section the run ends at. */
  readonly section: number
  /** +1 when the run stops going forward (outside is ahead), -1 when it starts (outside is behind). */
  readonly outward: 1 | -1
  /** Horizontal outward direction across the cut line. */
  readonly nx: number
  readonly nz: number
}

interface Segment {
  readonly index: number
  readonly ax: number
  readonly az: number
  readonly dx: number
  readonly dz: number
  readonly lengthSquared: number
  readonly length: number
  readonly a: Section
  readonly b: Section
  /** Before the first sample (t < 0) or past the second (t > 1) this segment does not reach. */
  readonly openStart: boolean
  readonly openEnd: boolean
  readonly topLeftA: number
  readonly topLeftB: number
  readonly topRightA: number
  readonly topRightB: number
  /** Cut lines of run ends near this segment: points past one (on its outward side) are beyond the road. */
  readonly cuts: Array<{ readonly x: number; readonly z: number; readonly nx: number; readonly nz: number }>
}

/** Segments bucketed by area, so a point query looks only at the road near it. */
class Buckets {
  private readonly cells = new Map<number, Array<Segment>>()
  private readonly size: number
  constructor(size: number) {
    this.size = size
  }
  private key(ix: number, iz: number): number {
    return (ix + 4096) * 8192 + (iz + 4096)
  }
  insert(segment: Segment, radius: number): void {
    const minX = Math.min(segment.ax, segment.ax + segment.dx) - radius
    const maxX = Math.max(segment.ax, segment.ax + segment.dx) + radius
    const minZ = Math.min(segment.az, segment.az + segment.dz) - radius
    const maxZ = Math.max(segment.az, segment.az + segment.dz) + radius
    for (let ix = Math.floor(minX / this.size); ix <= Math.floor(maxX / this.size); ix++) {
      for (let iz = Math.floor(minZ / this.size); iz <= Math.floor(maxZ / this.size); iz++) {
        const key = this.key(ix, iz)
        const list = this.cells.get(key)
        if (list === undefined) this.cells.set(key, [segment])
        else list.push(segment)
      }
    }
  }
  at(x: number, z: number): ReadonlyArray<Segment> {
    return this.cells.get(this.key(Math.floor(x / this.size), Math.floor(z / this.size))) ?? []
  }
}

export interface TerrainPoint {
  /** Terrain height. */
  h: number
  /** A cut road's channel covers the point: the terrain mesh leaves it out. */
  covered: boolean
}

export interface Field {
  /** The terrain's top where nothing raises it. */
  readonly top: number
  readonly wallHeight: number
  readonly sections: ReadonlyArray<Section>
  /** Kind of segment `i`, from section `i` to section `i + 1`. */
  readonly kinds: ReadonlyArray<SegmentKind>
  readonly ends: ReadonlyArray<RunEnd>
  /** Height of each section's wall tops (cut road: the terrain at the wall band; bridge: the parapet). */
  readonly topLeft: ReadonlyArray<number>
  readonly topRight: ReadonlyArray<number>
  /** The terrain at a point. Writes into `out` and returns it. */
  heightAt(x: number, z: number, out?: TerrainPoint): TerrainPoint
  /** Metres from the point to the outer edge of the nearest road, walls and gaps included (capped at 12). Negative on the road. */
  clearance(x: number, z: number): number
  /** As `clearance`, but only cut road counts: where a bridge pillar may stand. */
  groundClearance(x: number, z: number): number
}

const wrap = (i: number, n: number): number => ((i % n) + n) % n

export const createField = (track: TrackData): Field => {
  const top = track.wallHeight
  const samples = track.samples
  const count = samples.length

  const sections: Array<Section> = samples.map((sample, index) => {
    const lx = Math.cos(sample.yaw)
    const lz = -Math.sin(sample.yaw)
    const fx = Math.sin(sample.yaw)
    const fz = Math.cos(sample.yaw)
    const tanBank = Math.tan(sample.bank)
    // Up of the surface: forward (with pitch) crossed with left (with bank).
    const cp = Math.cos(sample.pitch)
    const f = [fx * cp, Math.sin(sample.pitch), fz * cp] as const
    const l = [lx, tanBank, lz] as const
    const nx = f[1] * l[2] - f[2] * l[1]
    const ny = f[2] * l[0] - f[0] * l[2]
    const nz = f[0] * l[1] - f[1] * l[0]
    const nl = Math.hypot(nx, ny, nz)
    return {
      sample,
      index,
      x: sample.x,
      y: sample.y,
      z: sample.z,
      lx,
      lz,
      fx,
      fz,
      hw: sample.halfWidth,
      tanBank,
      edgeLeft: sample.y + sample.halfWidth * tanBank,
      edgeRight: sample.y - sample.halfWidth * tanBank,
      normal: [nx / nl, ny / nl, nz / nl]
    }
  })

  // Where the picture needs a deck. The track marks its bridges, but it may also mark road as
  // solid where it passes over lower road (so the car never drives under a ramp's mass in the
  // rules), and a solid mass there would bury the road below: its embankment fills the lower
  // channel and the lower road's walls rise through the deck. So every sample whose cross
  // section (road and wall band) reaches over the footprint of road well below it becomes a
  // deck too, grown by DECK_MARGIN both ways so the abutments stand clear of the lower walls.
  const deck = samples.map((sample) => sample.support === "bridge")
  const over = sections.map((a) => {
    if (!a.sample.surface || a.sample.support === "ground") return false
    const reach = a.hw + WALL_BAND + 0.3
    for (const b of sections) {
      if (!b.sample.surface || b.y > a.y - DECK_CLEARANCE) continue
      const footprint = b.hw + WALL_BAND + 0.3
      // Closest approach of a's cross-section line (a + l * u, |u| <= reach) to b's centre.
      const rx = b.x - a.x
      const rz = b.z - a.z
      const u = Math.max(-reach, Math.min(reach, rx * a.lx + rz * a.lz))
      if (Math.hypot(rx - a.lx * u, rz - a.lz * u) < footprint) return true
    }
    return false
  })
  const marginSamples = Math.round(DECK_MARGIN / track.spacing)
  over.forEach((isOver, i) => {
    if (!isOver) return
    for (let k = -marginSamples; k <= marginSamples; k++) {
      const j = wrap(i + k, count)
      if (samples[j]!.surface && samples[j]!.support !== "ground") deck[j] = true
    }
  })

  const kinds: Array<SegmentKind> = samples.map((a, i) => {
    const b = samples[wrap(i + 1, count)]!
    if (!a.surface || !b.surface) return "gap"
    if (deck[i] === true || deck[wrap(i + 1, count)] === true) return "bridge"
    return "cut"
  })
  const kindAt = (i: number): SegmentKind => kinds[wrap(i, count)]!

  // The wall tops a cut road asks for on its own, before other road nearby raises them.
  const ownTop = (section: Section, side: 1 | -1): number => {
    const wall = side === 1 ? section.sample.wallLeft : section.sample.wallRight
    const edge = side === 1 ? section.edgeLeft : section.edgeRight
    return Math.max(top, edge + (wall ? track.wallHeight : 0))
  }

  const terrainBuckets = new Buckets(4)
  const clearanceBuckets = new Buckets(4)
  const groundBuckets = new Buckets(4)
  const segments: Array<Segment> = []
  for (let i = 0; i < count; i++) {
    const a = sections[i]!
    const b = sections[wrap(i + 1, count)]!
    const dx = b.x - a.x
    const dz = b.z - a.z
    const lengthSquared = Math.max(1e-9, dx * dx + dz * dz)
    const segment: Segment = {
      index: i,
      ax: a.x,
      az: a.z,
      dx,
      dz,
      lengthSquared,
      length: Math.sqrt(lengthSquared),
      a,
      b,
      openStart: kindAt(i - 1) !== "cut",
      openEnd: kindAt(i + 1) !== "cut",
      topLeftA: ownTop(a, 1),
      topLeftB: ownTop(b, 1),
      topRightA: ownTop(a, -1),
      topRightB: ownTop(b, -1),
      cuts: []
    }
    segments.push(segment)
    const hw = Math.max(a.hw, b.hw)
    clearanceBuckets.insert(segment, hw + WALL_BAND + 12)
    if (kinds[i] === "cut") {
      const rise = Math.max(segment.topLeftA, segment.topLeftB, segment.topRightA, segment.topRightB) - top
      terrainBuckets.insert(segment, hw + WALL_BAND + Math.max(0, rise) / EMBANKMENT_SLOPE + 0.1)
      groundBuckets.insert(segment, hw + WALL_BAND + 12)
    }
  }

  const ends: Array<RunEnd> = []
  for (let i = 0; i < count; i++) {
    if (kinds[i] !== "cut") continue
    const segment = segments[i]!
    const ux = segment.dx / segment.length
    const uz = segment.dz / segment.length
    if (kindAt(i - 1) !== "cut") ends.push({ section: i, outward: -1, nx: -ux, nz: -uz })
    if (kindAt(i + 1) !== "cut") ends.push({ section: wrap(i + 1, count), outward: 1, nx: ux, nz: uz })
  }
  // Every cut segment within reach of a run end stops at that end's line, so an embankment
  // ends in a cliff instead of wrapping around the end.
  const cutReach = Math.ceil(16 / track.spacing)
  for (const end of ends) {
    const cut = { x: sections[end.section]!.x, z: sections[end.section]!.z, nx: end.nx, nz: end.nz }
    for (let k = 0; k < cutReach; k++) {
      const i = end.outward === 1 ? wrap(end.section - 1 - k, count) : wrap(end.section + k, count)
      if (kinds[i] !== "cut") break
      segments[i]!.cuts.push(cut)
    }
  }

  const scratch: TerrainPoint = { h: top, covered: false }
  const heightAt = (x: number, z: number, out: TerrainPoint = scratch): TerrainPoint => {
    let h = top
    let covered = false
    for (const segment of terrainBuckets.at(x, z)) {
      const raw = ((x - segment.ax) * segment.dx + (z - segment.az) * segment.dz) / segment.lengthSquared
      // Past its ends a segment reaches only far enough to close the wedge between it and
      // its neighbour on the outside of a curve. Any further, and where the width changes
      // a wider segment's end would punch its hole past a narrower neighbour's wall band.
      if (raw < 0 && (segment.openStart || -raw * segment.length > END_REACH)) continue
      if (raw > 1 && (segment.openEnd || (raw - 1) * segment.length > END_REACH)) continue
      let beyond = false
      for (const cut of segment.cuts) if ((x - cut.x) * cut.nx + (z - cut.z) * cut.nz > 0) beyond = true
      if (beyond) continue
      const t = raw < 0 ? 0 : raw > 1 ? 1 : raw
      const px = x - (segment.ax + segment.dx * t)
      const pz = z - (segment.az + segment.dz * t)
      const distance = Math.hypot(px, pz)
      // Left of the segment's direction (dx, dz) is (dz, -dx).
      const left = px * segment.dz - pz * segment.dx >= 0
      const hw = segment.a.hw + (segment.b.hw - segment.a.hw) * t
      // Past a segment's end its wall top keeps sloping, but may only drop below the end's
      // value: on a ramp the next segment's higher start never lifts this one's band, and an
      // abrupt change of bank or height never throws a spike outward.
      const topA = left ? segment.topLeftA : segment.topRightA
      const topB = left ? segment.topLeftB : segment.topRightB
      const clamped = topA + (topB - topA) * t
      const wallTop = raw === t ? clamped : Math.min(clamped, topA + (topB - topA) * raw)
      if (distance < hw + HOLE_INSET) covered = true
      const outer = hw + WALL_BAND
      const v = distance <= outer ? wallTop : wallTop - EMBANKMENT_SLOPE * (distance - outer)
      if (v > h) h = v
    }
    out.h = h
    out.covered = covered
    return out
  }

  const clearanceIn = (buckets: Buckets, x: number, z: number): number => {
    let best = 12
    for (const segment of buckets.at(x, z)) {
      const raw = ((x - segment.ax) * segment.dx + (z - segment.az) * segment.dz) / segment.lengthSquared
      const t = raw < 0 ? 0 : raw > 1 ? 1 : raw
      const distance = Math.hypot(x - (segment.ax + segment.dx * t), z - (segment.az + segment.dz * t))
      const hw = segment.a.hw + (segment.b.hw - segment.a.hw) * t
      const edge = segment.index >= 0 && kinds[segment.index] === "bridge" ? hw + BRIDGE_PARAPET : hw + WALL_BAND
      best = Math.min(best, distance - edge)
    }
    return best
  }

  const topLeft: Array<number> = []
  const topRight: Array<number> = []
  const endAt = new Map(ends.map((end) => [end.section, end]))
  const probe: TerrainPoint = { h: 0, covered: false }
  sections.forEach((section, i) => {
    const cut = kindAt(i) === "cut" || kindAt(i - 1) === "cut"
    if (cut) {
      const d = section.hw + WALL_BAND / 2
      // At a run's end, look a hair inside the run so the cut line does not hide it. The
      // probe runs along the cut line itself: on a curve the section's own sideways
      // direction leans across the line, and the outer probe would land beyond it.
      const end = endAt.get(i)
      if (end === undefined) {
        topLeft.push(heightAt(section.x + section.lx * d, section.z + section.lz * d, probe).h)
        topRight.push(heightAt(section.x - section.lx * d, section.z - section.lz * d, probe).h)
      } else {
        const x = section.x - end.nx * 0.05
        const z = section.z - end.nz * 0.05
        // Left of the direction of travel, square to the cut line.
        const lx = end.nz * end.outward
        const lz = -end.nx * end.outward
        topLeft.push(heightAt(x + lx * d, z + lz * d, probe).h)
        topRight.push(heightAt(x - lx * d, z - lz * d, probe).h)
      }
    } else {
      topLeft.push(section.edgeLeft + (section.sample.wallLeft ? track.wallHeight : 0.12))
      topRight.push(section.edgeRight + (section.sample.wallRight ? track.wallHeight : 0.12))
    }
  })

  return {
    top,
    wallHeight: track.wallHeight,
    sections,
    kinds,
    ends,
    topLeft,
    topRight,
    heightAt,
    clearance: (x, z) => clearanceIn(clearanceBuckets, x, z),
    groundClearance: (x, z) => clearanceIn(groundBuckets, x, z)
  }
}
