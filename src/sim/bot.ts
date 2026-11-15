/**
 * A driver for tests, the bot script and the medal times.
 *
 * It reads only what a player could see: the car, the track's shape and where the posts and
 * props are. It follows the centreline with a look-ahead, slows for the curvature ahead,
 * keeps the throttle down over boost pads and jumps, steers past the things in the road,
 * drives through the swing doors where the leaves meet, and drifts round the tight corners
 * that are long enough to pay for it. It holds no state: the same view gives the same input.
 */
import { Ops } from "@typeonce/ritmo"
import { angleDelta, indexAt, locateNear, pointAt } from "./track/query.ts"
import { handling as carHandling } from "./tuning.ts"
import type { DriveInput, RaceView, TrackData } from "./types.ts"

/** How the bot drives: margins it keeps below what the car can do. */
const plan = {
  /** Sideways acceleration it plans corners for, m/s^2 (the car can do `turnAccel`). */
  cornerAccel: 32,
  /** Share of `cornerAccel` it gives up at full slip. */
  slideCaution: 0.3,
  /** Braking it plans for, m/s^2 (the car can do `brakeDecel`). */
  brakeDecel: 20,
  /** Look-ahead of the steering: a fixed part and a part per m/s. */
  lookFixed: 3,
  lookPerSpeed: 0.3,
  /** Share of the nose's direction in the heading it steers by (the rest is the direction of travel). */
  noseShare: 0.3,
  /** How far ahead it scans for curvature, crates and gates, metres. */
  scan: 45,
  /** Gap it keeps to the things in the road, metres. */
  clearance: 0.3,
  /** Things within this far of the nearest one count as the same row, metres. */
  row: 4,
  /** It drifts round corners at least this tight, metres of radius, that go on for at least `driftAhead` metres more. */
  driftRadius: 14,
  driftAhead: 10,
  /** It does not start a drift with a tight corner the other way within this far, metres. */
  driftClear: 45,
  /** How hard it corrects a drift: wheel per metre outside its line, and per radian of heading out of the corner. */
  driftHold: 0.4,
  driftTurnIn: 2
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** Distance ahead from `s` to `target` along the lap, in [0, length). */
const aheadOf = (track: TrackData, s: number, target: number): number => (((target - s) % track.length) + track.length) % track.length

/**
 * Lateral offset to aim for: past the nearest row of things in the road (posts, crates,
 * barrels, balls, wherever they are now), through the free stretch nearest the middle.
 * Cones are not worth steering for.
 */
const lineOffset = (view: RaceView, track: TrackData, s: number, reach: number): { offset: number; distance: number | null } => {
  const car = carHandling
  const hint = indexAt(track, s + 10)
  const ahead: Array<{ distance: number; d: number; radius: number; halfWidth: number }> = []
  const consider = (x: number, z: number, radius: number): void => {
    if ((x - view.car.x) ** 2 + (z - view.car.z) ** 2 > (reach + 14) ** 2) return
    const hit = locateNear(track, x, z, hint, 48)
    let distance = aheadOf(track, s, hit.s)
    if (distance > track.length - 2) distance -= track.length
    if (distance < -2 || distance > reach + 8) return
    ahead.push({ distance, d: hit.d, radius, halfWidth: hit.halfWidth })
  }
  for (const post of track.bollards) consider(post.x, post.z, post.radius)
  track.props.forEach((prop, index) => {
    const now = view.props[index]
    if (prop.kind !== "cone" && now !== undefined) consider(now.x, now.z, prop.radius)
  })
  if (ahead.length === 0) return { offset: 0, distance: null }
  const first = Math.min(...ahead.map((thing) => thing.distance))
  const row = ahead.filter((thing) => thing.distance < first + plan.row)
  const edge = (row[0]?.halfWidth ?? 3) - car.radius - 0.15
  const blocked = row.map((thing) => [thing.d - thing.radius - car.radius - plan.clearance, thing.d + thing.radius + car.radius + plan.clearance] as const).sort((a, b) => a[0] - b[0])
  // The free stretches across the road; in each, the point nearest the middle.
  let best = 0
  let bestCost = Number.MAX_VALUE
  let widest = 0
  let widestWidth = -1
  let from = -edge
  for (const [low, high] of [...blocked, [edge, edge] as const]) {
    const to = Math.min(low, edge)
    const width = to - from
    if (width > widestWidth) {
      widestWidth = width
      widest = (from + to) / 2
    }
    if (width >= 0) {
      const point = Math.max(from, Math.min(to, 0))
      if (Math.abs(point) < bestCost) {
        bestCost = Math.abs(point)
        best = point
      }
    }
    from = Math.max(from, high)
  }
  return { offset: bestCost < Number.MAX_VALUE ? best : widest, distance: first }
}

/** The fastest the car should go now so it can still slow for every corner ahead. */
const targetSpeed = (view: RaceView, track: TrackData, s: number): number => {
  const gravity = carHandling.gravity
  // A car that is sliding grips less than planned: back off while it slides.
  const cornerAccel = plan.cornerAccel * (1 - plan.slideCaution * view.car.slip)
  let target = 99
  for (let distance = 0; distance <= plan.scan; distance += 1) {
    const a = pointAt(track, s + distance - 2)
    const b = pointAt(track, s + distance + 2)
    const turn = angleDelta(a.yaw, b.yaw)
    const curvature = Math.abs(turn) / 4
    if (curvature < 1e-4) continue
    // A bank that leans into the turn lets the car carry more speed.
    const lean = Math.max(0, -Ops.tan((a.bank + b.bank) / 2) * Math.sign(turn))
    const allowed = Math.sqrt((cornerAccel + gravity * lean) / curvature)
    target = Math.min(target, Math.sqrt(allowed * allowed + 2 * plan.brakeDecel * distance))
  }
  return target
}

/** Whether the throttle must stay down here whatever the plan says: on the run to a jump or a pad. */
const committed = (track: TrackData, s: number): boolean =>
  track.features.some((feature) => (feature.kind === "jump" || feature.kind === "boost") && aheadOf(track, feature.sFrom - 6, s) <= feature.sTo - feature.sFrom + 6)

/** The corner at `s`, as it turns over the next few metres: its side (1 left, -1 right) and how tightly it curves, 1/m. */
const curveAt = (track: TrackData, s: number): { side: number; curve: number } => {
  const turn = angleDelta(pointAt(track, s).yaw, pointAt(track, s + 3).yaw) / 3
  return { side: turn >= 0 ? 1 : -1, curve: Math.abs(turn) }
}

/**
 * The wheel that holds a drift round the corner the car is in, or null when this is no
 * place to drift: a corner tight enough, with enough of it left, nothing standing in it,
 * and no jump or pad to keep straight for. The wheel is what the corner's own radius asks
 * of the drift's arc, corrected by how far outside the centreline the car is and by how far
 * its way points out of the corner.
 */
const driftWheel = (view: RaceView, track: TrackData, here: { readonly s: number; readonly d: number; readonly yaw: number }, clear: boolean): number | null => {
  const handling = carHandling
  const now = curveAt(track, here.s + 1)
  const drifting = view.car.drift !== null
  // Once sliding it holds on until the corner straightens; to start one it wants more corner ahead.
  const ahead = curveAt(track, here.s + (drifting ? 2.5 : plan.driftAhead))
  const tight = 1 / plan.driftRadius
  if (now.curve < tight * (drifting ? 0.8 : 1) || ahead.curve < tight * 0.8 || ahead.side !== now.side) return null
  if (!drifting && (!clear || !view.car.grounded || view.car.speed < handling.driftFrom + 1 || committed(track, here.s))) return null
  // A slide ends with a push: not into a corner that turns the other way just after this one.
  if (!drifting) {
    for (let distance = plan.driftAhead; distance <= plan.driftClear; distance += 3) {
      const next = curveAt(track, here.s + distance)
      if (next.side !== now.side && next.curve >= tight * 0.8) return null
    }
  }
  const neutral = 1 / handling.driftNeutral
  const asked = now.curve >= neutral ? (now.curve - neutral) / (1 / handling.driftTight - neutral) : (now.curve - neutral) / (neutral - 1 / handling.driftWide)
  const outside = -here.d * now.side
  const travel = Ops.atan2(view.car.vx, view.car.vz)
  const headingOut = -angleDelta(here.yaw, travel) * now.side
  const inward = clamp(asked + plan.driftHold * outside + plan.driftTurnIn * headingOut, -1, 1)
  // The slide starts with the wheel turned its way.
  return now.side * (drifting ? inward : Math.max(0.3, inward))
}

export const botInput = (view: RaceView, track: TrackData): DriveInput => {
  const { car } = view
  const here = locateNear(track, car.x, car.z, indexAt(track, car.s), 32)
  const s = here.s
  const speed = car.speed

  // Steering: pure pursuit of a point ahead on the chosen line.
  const look = plan.lookFixed + plan.lookPerSpeed * Math.max(0, speed)
  const line = lineOffset(view, track, s, look)
  // With something in the road ahead it aims at the gap itself, not past it.
  const reach = line.distance !== null && line.distance > 4 && line.distance < look ? line.distance : look
  const point = pointAt(track, s + reach, line.offset)
  const dx = point.x - car.x
  const dz = point.z - car.z
  // Steer by a heading between where the car is going and where its nose points: a slide is
  // caught, and a nose already turned in is not turned in further.
  const travel = speed > 3 ? Ops.atan2(car.vx, car.vz) : car.yaw
  const going = travel + angleDelta(travel, car.yaw) * plan.noseShare
  const error = angleDelta(going, Ops.atan2(dx, dz))
  const handling = carHandling
  const moving = Math.max(Math.abs(speed), 0.5)
  const turnRate = Math.min(moving / handling.minTurnRadius, handling.turnAccel / moving)
  const wantedRate = (2 * Ops.sin(error) * moving) / Math.max(Math.sqrt(dx * dx + dz * dz), 1)
  const steer = clamp(wantedRate / turnRate, -1, 1) * (speed < -0.5 ? -1 : 1)

  // Speed.
  const target = committed(track, s) ? 99 : targetSpeed(view, track, s)
  let throttle = 1
  let brake = 0
  if (speed > target + 0.5) {
    throttle = 0
    // Below walking pace the brake would reverse: let it roll to a stop instead.
    brake = speed > 0.4 ? clamp((speed - target) / 3, 0.2, 1) : 0
  } else if (target < 0.5) {
    throttle = 0
  } else if (speed > target - 0.5) {
    throttle = 0.3
  }
  // A corner worth sliding round: both pedals down, and the wheel that holds the slide in the road.
  const slide = driftWheel(view, track, here, line.distance === null)
  if (slide !== null) return { throttle: 1, brake: 1, steer: slide, aim: { x: dx, z: dz }, restart: false }
  return { throttle, brake, steer, aim: { x: dx, z: dz }, restart: false }
}
