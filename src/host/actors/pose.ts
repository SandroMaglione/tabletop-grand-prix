/**
 * Turning a point in the car's own frame into the world, without scene nodes.
 *
 * The car's frame is yaw about +Y, then nose-up pitch about its own X, then left-up roll about its
 * own Z: the same order as the nested nodes in `car.ts` (yaw node, pitch node, roll node), so
 * skid marks and particles land where the drawn car is.
 */

/** A reusable 3-vector. */
export interface Vec {
  x: number
  y: number
  z: number
}

export const vec = (): Vec => ({ x: 0, y: 0, z: 0 })

/** Rotates the car-frame point (x, y, z) by yaw, pitch and roll into `out`. */
export const rotate = (yaw: number, pitch: number, roll: number, x: number, y: number, z: number, out: Vec): Vec => {
  // Roll about Z: left side (+X) up when roll is positive.
  const cr = Math.cos(roll)
  const sr = Math.sin(roll)
  const x1 = x * cr - y * sr
  const y1 = x * sr + y * cr
  // Pitch about X by -pitch: the nose (+Z) goes up when pitch is positive.
  const cp = Math.cos(-pitch)
  const sp = Math.sin(-pitch)
  const y2 = y1 * cp - z * sp
  const z2 = y1 * sp + z * cp
  // Yaw about Y: +Z turns to (sin yaw, 0, cos yaw).
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  out.x = x1 * cy + z2 * sy
  out.y = y2
  out.z = -x1 * sy + z2 * cy
  return out
}

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

/** Moves `value` toward `target` with a time constant, frame-rate independent. */
export const approach = (value: number, target: number, rate: number, seconds: number): number => value + (target - value) * (1 - Math.exp(-rate * seconds))

/** A small deterministic random source, so effects look the same in every picture. */
export const random = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A unit quaternion as plain numbers, for orientations the actors integrate themselves. */
export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export const quat = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 })

/** `out = a * b`: `b` first, then `a`. `out` may be `a` or `b`. */
export const quatMultiply = (a: Quat, b: Quat, out: Quat): Quat => {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  out.x = x
  out.y = y
  out.z = z
  out.w = w
  return out
}

/** A turn of `angle` about the axis (x, y, z), which need not be normalized. A zero axis gives no turn. */
export const quatAxisAngle = (x: number, y: number, z: number, angle: number, out: Quat): Quat => {
  const length = Math.hypot(x, y, z)
  if (length < 1e-9 || angle === 0) {
    out.x = 0
    out.y = 0
    out.z = 0
    out.w = 1
    return out
  }
  const s = Math.sin(angle / 2) / length
  out.x = x * s
  out.y = y * s
  out.z = z * s
  out.w = Math.cos(angle / 2)
  return out
}

export const quatNormalize = (q: Quat): Quat => {
  const length = Math.hypot(q.x, q.y, q.z, q.w) || 1
  q.x /= length
  q.y /= length
  q.z /= length
  q.w /= length
  return q
}

/** Moves `q` a fraction `t` of the way to `target` along the shorter arc (normalized lerp). */
export const quatToward = (q: Quat, target: Quat, t: number): Quat => {
  const sign = q.x * target.x + q.y * target.y + q.z * target.z + q.w * target.w < 0 ? -1 : 1
  q.x += (target.x * sign - q.x) * t
  q.y += (target.y * sign - q.y) * t
  q.z += (target.z * sign - q.z) * t
  q.w += (target.w * sign - q.w) * t
  return quatNormalize(q)
}

/** How far a unit cube turned by `q` reaches below its centre, in half-edges: 1 when it sits flat, up to about 1.73 on a corner. */
export const cubeReach = (q: Quat): number => {
  const { x, y, z, w } = q
  return Math.abs(2 * (x * y + w * z)) + Math.abs(1 - 2 * (x * x + z * z)) + Math.abs(2 * (y * z - w * x))
}

/** The 24 turns that leave a cube's faces on the axes: every way a crate can lie flat. */
export const cubeTurns: ReadonlyArray<Quat> = (() => {
  const found: Array<Quat> = [quat()]
  const steps = [quatAxisAngle(1, 0, 0, Math.PI / 2, quat()), quatAxisAngle(0, 1, 0, Math.PI / 2, quat()), quatAxisAngle(0, 0, 1, Math.PI / 2, quat())]
  for (let i = 0; i < found.length && found.length < 24; i++) {
    const from = found[i]
    if (from === undefined) break
    for (const step of steps) {
      const next = quatNormalize(quatMultiply(step, from, quat()))
      if (!found.some((q) => Math.abs(q.x * next.x + q.y * next.y + q.z * next.z + q.w * next.w) > 0.999)) found.push(next)
    }
  }
  return found
})()

/** The flat-lying turn nearest to `q`. */
export const nearestCubeTurn = (q: Quat): Quat => {
  let best = cubeTurns[0] ?? quat()
  let bestDot = -1
  for (const turn of cubeTurns) {
    const dot = Math.abs(q.x * turn.x + q.y * turn.y + q.z * turn.z + q.w * turn.w)
    if (dot > bestDot) {
      bestDot = dot
      best = turn
    }
  }
  return best
}

/** The shortest signed turn from angle `from` to angle `to`, in (-PI, PI]. */
export const turnBetween = (from: number, to: number): number => {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}
