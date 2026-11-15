/**
 * The track's surface patches (the ford, the meadow, the stony path) as the picture reads
 * them: how far a road point is inside a patch, and where a world point is on the road.
 *
 * `depth` is in metres, positive inside and negative outside, so a patch's edge can be made
 * ragged by adding noise to it and cutting at zero. A patch edge that lies on the road's own
 * edge (a wall) does not count as an edge: nothing frays against a wall.
 *
 * `locateRoad` is `locateNear` without the allocation, for the per-frame path: it writes into
 * the caller's record.
 */
import type { SurfaceKind, SurfacePatch, TrackData } from "../../sim/index.ts"

const wrap = (i: number, n: number): number => ((i % n) + n) % n

/** The patches of one kind. */
export const patchesOf = (track: TrackData, kind: SurfaceKind): ReadonlyArray<SurfacePatch> => track.surfaces.filter((patch) => patch.kind === kind)

/** Half the road's width at centreline distance `s`. */
export const halfWidthAt = (track: TrackData, s: number): number => {
  const count = track.samples.length
  const position = s / track.spacing
  const i = Math.floor(position)
  const t = position - i
  const a = track.samples[wrap(i, count)]!.halfWidth
  return a + (track.samples[wrap(i + 1, count)]!.halfWidth - a) * t
}

/** Metres from (s, d) to the patch's edge: positive inside, negative outside. */
export const patchDepth = (track: TrackData, patch: SurfacePatch, s: number, d: number): number => {
  const hw = halfWidthAt(track, s)
  if (patch.shape === "strip") {
    let depth = Math.min(s - patch.sFrom, patch.sTo - s)
    if (patch.dFrom > -hw + 0.05) depth = Math.min(depth, d - patch.dFrom)
    if (patch.dTo < hw - 0.05) depth = Math.min(depth, patch.dTo - d)
    return depth
  }
  // An oval: the distance to the ellipse, estimated from its implicit radius and that radius's slope.
  const semiS = (patch.sTo - patch.sFrom) / 2
  const semiD = (patch.dTo - patch.dFrom) / 2
  const a = (s - (patch.sFrom + semiS)) / semiS
  const c = (d - (patch.dFrom + semiD)) / semiD
  const r = Math.hypot(a, c)
  if (r < 1e-6) return Math.min(semiS, semiD)
  const slope = Math.hypot(a / (r * semiS), c / (r * semiD))
  return (1 - r) / slope
}

/** Where a point is on the road: centreline distance, lateral offset (positive left), and the sample it is near. */
export interface RoadSpot {
  s: number
  d: number
  index: number
}

export const roadSpot = (): RoadSpot => ({ s: 0, d: 0, index: 0 })

/**
 * The road coordinates of the ground point (x, z), searching `reach` samples either side of
 * `hint`. Writes into `out` and returns it.
 */
export const locateRoad = (track: TrackData, x: number, z: number, hint: number, out: RoadSpot, reach: number = 8): RoadSpot => {
  const samples = track.samples
  const count = samples.length
  let best = Number.MAX_VALUE
  for (let k = -reach; k <= reach; k++) {
    const i = wrap(hint + k, count)
    const a = samples[i]!
    const b = samples[wrap(i + 1, count)]!
    const dx = b.x - a.x
    const dz = b.z - a.z
    const lengthSquared = dx * dx + dz * dz
    const raw = lengthSquared === 0 ? 0 : ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw
    const px = x - (a.x + dx * t)
    const pz = z - (a.z + dz * t)
    const distance = px * px + pz * pz
    if (distance >= best) continue
    best = distance
    const length = Math.sqrt(lengthSquared)
    out.index = i
    out.s = a.s + track.spacing * t
    // Left of the segment's direction (dx, dz) is (dz, -dx).
    out.d = length === 0 ? 0 : (px * dz - pz * dx) / length
  }
  return out
}
