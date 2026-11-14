/**
 * Where a point is on the track.
 *
 * The road is the sampled centreline of `TrackData`. Between two samples every value is
 * interpolated. Two questions are answered here:
 *
 * - `locateNear`: the car is on the road and was at sample `hint` a moment ago. Searching
 *   only near `hint` keeps it on its own level where the track crosses itself.
 * - `locateBelow`: the car is in the air. Which road surface is under it, if any?
 */
import { Ops } from "@typeonce/ritmo"
import type { TrackData, TrackSample } from "../types.ts"

export interface TrackHit {
  /** Index of the sample that starts the segment the point is on. */
  readonly index: number
  /** Centreline distance of the point, in metres. */
  readonly s: number
  /** Lateral offset from the centreline, positive to the left. */
  readonly d: number
  /** Height of the road surface under the point (bank included). */
  readonly y: number
  readonly yaw: number
  readonly pitch: number
  readonly bank: number
  readonly halfWidth: number
  /** False when the segment is a jump gap. */
  readonly surface: boolean
  readonly wallLeft: boolean
  readonly wallRight: boolean
}

const TAU = Math.PI * 2

/** How far past a segment's ends a point in the air still counts as over it, in segment lengths. */
const END_REACH = 0.75

/** The shortest signed turn from angle `a` to angle `b`, in (-PI, PI]. */
export const angleDelta = (a: number, b: number): number => {
  let delta = (b - a) % TAU
  if (delta > Math.PI) delta -= TAU
  if (delta <= -Math.PI) delta += TAU
  return delta
}

const wrap = (index: number, count: number): number => ((index % count) + count) % count

const sampleAt = (track: TrackData, index: number): TrackSample => {
  const sample = track.samples[wrap(index, track.samples.length)]
  if (sample === undefined) throw new Error("The track has no samples")
  return sample
}

/** How far along segment `index` the point projects (0 at its first sample, 1 at its second), not clamped. */
const along = (a: TrackSample, b: TrackSample, x: number, z: number): number => {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const lengthSquared = dx * dx + dz * dz
  return lengthSquared === 0 ? 0 : ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared
}

const hitOn = (track: TrackData, index: number, x: number, z: number, clampEnds: boolean): TrackHit => {
  const count = track.samples.length
  const i = wrap(index, count)
  const a = sampleAt(track, i)
  const b = sampleAt(track, i + 1)
  const raw = along(a, b, x, z)
  const t = clampEnds ? Math.min(1, Math.max(0, raw)) : raw
  const dx = b.x - a.x
  const dz = b.z - a.z
  const length = Math.sqrt(dx * dx + dz * dz)
  // Left of the segment's direction (dx, dz) is (dz, -dx).
  const px = x - (a.x + dx * t)
  const pz = z - (a.z + dz * t)
  const d = length === 0 ? 0 : (px * dz - pz * dx) / length
  const bank = a.bank + (b.bank - a.bank) * t
  const centre = a.y + (b.y - a.y) * t
  return {
    index: i,
    s: a.s + track.spacing * t,
    d,
    y: centre + d * Ops.tan(bank),
    yaw: a.yaw + angleDelta(a.yaw, b.yaw) * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    bank,
    halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * t,
    surface: a.surface && b.surface,
    wallLeft: a.wallLeft && b.wallLeft,
    wallRight: a.wallRight && b.wallRight
  }
}

/**
 * The point's place on the road near sample `hint`.
 *
 * Looks at the segments within `window` samples of `hint` and returns the closest.
 * Pass the returned `index` as the next tick's `hint`.
 */
export const locateNear = (track: TrackData, x: number, z: number, hint: number, window: number = 24): TrackHit => {
  let best = hint
  let bestDistance = Number.MAX_VALUE
  for (let offset = -window; offset <= window; offset++) {
    const a = sampleAt(track, hint + offset)
    const b = sampleAt(track, hint + offset + 1)
    const t = Math.min(1, Math.max(0, along(a, b, x, z)))
    const px = x - (a.x + (b.x - a.x) * t)
    const pz = z - (a.z + (b.z - a.z) * t)
    const distance = px * px + pz * pz
    if (distance < bestDistance) {
      bestDistance = distance
      best = hint + offset
    }
  }
  return hitOn(track, best, x, z, true)
}

/**
 * The highest road surface under a point in the air, or null when it is over no road.
 *
 * A surface counts when the point is within the road's width plus `margin` and the surface is
 * no higher than `y + reach` (a car a little below the lip of a landing still catches it).
 */
export const locateBelow = (track: TrackData, x: number, y: number, z: number, margin: number = 0, reach: number = 0.4): TrackHit | null => {
  let best: TrackHit | null = null
  const count = track.samples.length
  for (let i = 0; i < count; i++) {
    const a = sampleAt(track, i)
    const b = sampleAt(track, i + 1)
    if (!a.surface || !b.surface) continue
    // On the outside of a bend the segments fan apart and leave thin wedges that project onto
    // no segment. Reaching a little past each end, and reading the point at the end it is
    // nearest to, closes them.
    const t = along(a, b, x, z)
    if (t < -END_REACH || t > 1 + END_REACH) continue
    const hit = hitOn(track, i, x, z, true)
    if (Math.abs(hit.d) > hit.halfWidth + margin) continue
    if (hit.y > y + reach) continue
    if (best === null || hit.y > best.y) best = hit
  }
  return best
}

/** The sample index whose centreline distance is nearest to `s`. */
export const indexAt = (track: TrackData, s: number): number => wrap(Math.round(s / track.spacing), track.samples.length)

/** A point on the road at centreline distance `s` and lateral offset `d` (positive left). */
export const pointAt = (track: TrackData, s: number, d: number = 0): { x: number; y: number; z: number; yaw: number; pitch: number; bank: number } => {
  const count = track.samples.length
  const position = (((s / track.spacing) % count) + count) % count
  const i = Math.floor(position)
  const t = position - i
  const a = sampleAt(track, i)
  const b = sampleAt(track, i + 1)
  const yaw = a.yaw + angleDelta(a.yaw, b.yaw) * t
  const bank = a.bank + (b.bank - a.bank) * t
  return {
    x: a.x + (b.x - a.x) * t + Ops.cos(yaw) * d,
    y: a.y + (b.y - a.y) * t + d * Ops.tan(bank),
    z: a.z + (b.z - a.z) * t - Ops.sin(yaw) * d,
    yaw,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    bank
  }
}
