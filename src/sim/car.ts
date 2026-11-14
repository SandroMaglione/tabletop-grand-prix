/**
 * The car's motion for one tick: engine, brakes, steering and grip on the road, flight in
 * the air and walls.
 *
 * Everything here is a plain function over a working copy of `CarState` that the drive
 * system makes each tick and writes back once. No state lives in this module.
 */
import { Ops } from "@typeonce/ritmo"
import { angleDelta, locateBelow, locateNear } from "./track/query.ts"
import type { TrackHit } from "./track/query.ts"
import type { CarState, Steering } from "./schema.ts"
import type { RaceEvent, TrackData } from "./types.ts"
import type { Handling } from "./tuning.ts"

export type { CarState }

/** A writable copy of `CarState`, changed in place during one tick. */
export type CarWork = { -readonly [K in keyof CarState]: CarState[K] }

/** The input as the car reads it this tick. */
export interface CarControls {
  readonly throttle: number
  readonly brake: number
  readonly steer: number
  readonly aim: { readonly x: number; readonly z: number } | null
}

/** What the drive step needs besides the car. */
export interface DriveContext {
  readonly track: TrackData
  readonly handling: Handling
  /** By the wheel (`DriveInput.steer`), or toward where the player points (`DriveInput.aim`). */
  readonly steering: Steering
  readonly dt: number
  /** Speed limit this tick (raised by a boost). */
  readonly limit: number
  readonly onPad: boolean
  /** The clock has not started: the brake does not reverse. */
  readonly ready: boolean
  readonly emit: (event: RaceEvent) => void
}

/** What the drive step decided beyond the car's new state. */
export type DriveOutcome = "ok" | "off-track"

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** The car standing still on the road at `hit`, facing `yaw`. */
export const carAt = (x: number, z: number, yaw: number, hit: TrackHit): CarState => {
  const tilt = tiltOf(yaw, hit)
  return {
    x,
    y: hit.y,
    z,
    yaw,
    vx: 0,
    vy: 0,
    vz: 0,
    steer: 0,
    slip: 0,
    pitch: tilt.pitch,
    roll: tilt.roll,
    throttle: 0,
    brake: 0,
    motion: { _tag: "road" },
    hint: hit.index,
    s: hit.s,
    prevS: hit.s,
    boost: { _tag: "off" },
    wallSide: 0,
    load: 0
  }
}

/** Rise per metre of the road along the car's heading (`forward`) and to its left (`left`). */
const slopesOf = (yaw: number, hit: TrackHit): { forward: number; left: number } => {
  const delta = yaw - hit.yaw
  const along = Ops.tan(hit.pitch)
  const across = Ops.tan(hit.bank)
  const cos = Ops.cos(delta)
  const sin = Ops.sin(delta)
  return { forward: along * cos + across * sin, left: -along * sin + across * cos }
}

/** The road's pitch and bank as the car sees them from its heading. */
const tiltOf = (yaw: number, hit: TrackHit): { pitch: number; roll: number } => {
  const slopes = slopesOf(yaw, hit)
  return { pitch: Ops.atan(slopes.forward), roll: Ops.atan(slopes.left) }
}

/** Vertical speed of a point moving over the road at `hit` with this ground velocity. */
const surfaceVy = (vx: number, vz: number, hit: TrackHit): number => {
  const along = Ops.tan(hit.pitch)
  const across = Ops.tan(hit.bank)
  const fx = Ops.sin(hit.yaw)
  const fz = Ops.cos(hit.yaw)
  // Road left is (fz, -fx).
  return (vx * fx + vz * fz) * along + (vx * fz - vz * fx) * across
}

/** The steering the car follows this tick, before smoothing: from the wheel, or toward the aim. */
const steerTarget = (car: CarWork, controls: CarControls, steering: Steering, handling: Handling, forwardSpeed: number): number => {
  if (steering === "screen" && controls.aim !== null) {
    const { x, z } = controls.aim
    if (x * x + z * z < 1e-6) return 0
    const error = angleDelta(car.yaw, Ops.atan2(x, z))
    const target = clamp(error * handling.aimGain, -1, 1)
    // Reversing turns the nose the other way for the same wheel.
    return forwardSpeed < -0.5 ? -target : target
  }
  return clamp(controls.steer, -1, 1)
}

/** One tick of the car. Changes `car` in place. */
export const driveCar = (car: CarWork, controls: CarControls, context: DriveContext): DriveOutcome => {
  const { handling, dt } = context
  const throttle = clamp(controls.throttle, 0, 1)
  const brake = clamp(controls.brake, 0, 1)
  const fx = Ops.sin(car.yaw)
  const fz = Ops.cos(car.yaw)
  const forward = car.vx * fx + car.vz * fz
  const target = steerTarget(car, controls, context.steering, handling, forward)
  car.steer += (target - car.steer) * (1 - Ops.exp(-handling.steerResponse * dt))
  car.prevS = car.s
  if (car.motion._tag === "road") {
    car.throttle = throttle
    car.brake = brake
    return driveOnRoad(car, throttle, brake, context)
  }
  car.throttle = 0
  car.brake = brake
  return fly(car, context)
}

/** Engine, brakes and drag along the heading: the forward speed after this tick. */
const nextForwardSpeed = (speed: number, throttle: number, brake: number, slope: number, context: DriveContext): number => {
  const { handling, dt, limit } = context
  let accel = 0
  if (throttle > 0) {
    if (speed < -0.3) accel += throttle * handling.brakeDecel // throttle while rolling backwards brakes first
    else if (speed <= limit) accel += throttle * handling.engineAccel * (1 - (speed / limit) * (speed / limit))
    else accel -= handling.overspeedPull * (speed - limit)
  } else {
    accel -= Math.sign(speed) * (handling.rolling + handling.drag * speed * speed)
    if (speed > limit) accel -= handling.overspeedPull * (speed - limit)
  }
  if (brake > 0 && speed > 0.3) accel -= brake * handling.brakeDecel
  else if (brake > 0 && throttle === 0 && !context.ready) {
    // Stopped (or nearly): the brake reverses, slowly.
    accel -= brake * handling.reverseAccel * Math.max(0, 1 - Math.max(0, -speed) / handling.reverseSpeed)
  }
  if (context.onPad && speed < limit) accel += handling.boostAccel
  accel -= handling.gravity * handling.slopeGain * (slope / Math.sqrt(1 + slope * slope))
  const next = speed + accel * dt
  // Brakes and drag stop the car on the tick it would pass zero; going the other way starts from rest.
  if (speed !== 0 && Math.sign(next) !== Math.sign(speed) && Math.abs(speed) < 2) return 0
  if (context.ready && next < 0) return 0
  return next
}

const driveOnRoad = (car: CarWork, throttle: number, brake: number, context: DriveContext): DriveOutcome => {
  const { handling, dt, track } = context
  const here = locateNear(track, car.x, car.z, car.hint)
  const slopes = slopesOf(car.yaw, here)

  // Along the heading.
  let fx = Ops.sin(car.yaw)
  let fz = Ops.cos(car.yaw)
  const forward = car.vx * fx + car.vz * fz
  const side = car.vx * fz - car.vz * fx
  const speed = nextForwardSpeed(forward, throttle, brake, slopes.forward, context)

  // Turn: a tight radius when slow, a cap on sideways acceleration when fast. A bank that
  // leans into the turn raises the cap.
  const turnSign = Math.sign(car.steer)
  const bankHelp = Math.max(0, -slopes.left * turnSign)
  const turnAccel = handling.turnAccel + handling.bankGrip * handling.gravity * (bankHelp / Math.sqrt(1 + bankHelp * bankHelp))
  const absSpeed = Math.abs(speed)
  const turnRate = Math.min(absSpeed / handling.minTurnRadius, turnAccel / Math.max(absSpeed, 0.1))
  car.yaw += car.steer * turnRate * Math.sign(speed) * dt
  // A turn that is held costs speed: with the throttle down through a corner the car settles
  // at a speed the corner can take instead of ploughing wide. `load` is the turn averaged over
  // a moment, so taps left and right on a straight cancel and cost next to nothing.
  const asked = (car.steer * turnRate * absSpeed) / turnAccel
  car.load += (asked - car.load) * (1 - Ops.exp(-handling.turnDragBuild * dt))
  const carried = Math.sign(speed) * Math.max(0, absSpeed - handling.turnDrag * turnAccel * car.load * car.load * dt)

  // The velocity stays where it was; seen from the new heading it has a sideways part.
  const vx = fz * side + fx * carried
  const vz = -fx * side + fz * carried
  fx = Ops.sin(car.yaw)
  fz = Ops.cos(car.yaw)
  const newForward = vx * fx + vz * fz
  let newSide = vx * fz - vz * fx
  // Gravity across a bank pulls the car toward its low side: in a banked turn that helps it
  // round. It fades in with speed, so a car standing on a bank stays put.
  const pull = handling.bankSlide * Math.min(1, absSpeed / handling.bankSlideSpeed)
  newSide -= handling.gravity * pull * (slopes.left / Math.sqrt(1 + slopes.left * slopes.left)) * dt

  // Grip removes the sideways part; some of it turns forward, the rest is lost.
  const gripped = newSide * Ops.exp(-handling.grip * dt)
  const removed = Math.abs(newSide) - Math.abs(gripped)
  const magnitude = Math.sqrt(newForward * newForward + newSide * newSide) - handling.scrub * removed
  const keptForward = newForward === 0 ? 0 : Math.sign(newForward) * Math.sqrt(Math.max(0, magnitude * magnitude - gripped * gripped))
  car.vx = fx * keptForward + fz * gripped
  car.vz = fz * keptForward - fx * gripped
  car.slip = clamp((Math.abs(gripped) - handling.slipFrom) / handling.slipRange, 0, 1)

  // Move, then find the road again.
  car.x += car.vx * dt
  car.z += car.vz * dt
  const hit = locateNear(track, car.x, car.z, here.index)
  car.hint = hit.index
  car.s = hit.s

  const onOpenEdge = Math.abs(hit.d) > hit.halfWidth && !(hit.d > 0 ? hit.wallLeft : hit.wallRight)
  const flight = car.y + car.vy * dt - 0.5 * handling.gravity * dt * dt
  const leaves = (roadY: number): boolean => roadY < flight - handling.crestTolerance
  const takeOff = (): DriveOutcome => {
    car.y = flight
    car.vy -= handling.gravity * dt
    car.motion = { _tag: "air", leftAt: hit.s }
    car.wallSide = 0
    context.emit({ kind: "takeoff", speed: Math.sqrt(car.vx * car.vx + car.vz * car.vz), x: car.x, y: car.y, z: car.z })
    return "ok"
  }
  // The road ends: the car flies on with its velocity.
  if (!hit.surface || onOpenEdge) return takeOff()

  const d = hitWalls(car, hit, context)
  // The height where the car ends the tick, after a wall pushed it back. On a banked road a
  // push sideways is also a push up or down, so the road's height is read where the car
  // really is: reading it beyond the wall made a wall touch on a banked turn look like the
  // road falling away, and the car took off.
  const y = hit.y + (d - hit.d) * Ops.tan(hit.bank)
  // The road drops away faster than the car falls (a crest, a lip): it flies.
  if (leaves(y)) return takeOff()
  // Vertical speed from how much the road rose under the car this tick (a pitch read off the
  // samples can be flat at the lip of a ramp).
  car.vy = (y - car.y) / dt
  car.y = y
  const tilt = tiltOf(car.yaw, hit)
  car.pitch = tilt.pitch
  car.roll = tilt.roll
  return "ok"
}

/**
 * Keeps the car's circle inside the walls of `hit`. Returns the lateral offset after the push.
 * Removes the velocity into the wall, costs speed by how square the hit was and turns the car
 * a little along the wall.
 */
const hitWalls = (car: CarWork, hit: TrackHit, context: DriveContext): number => {
  const { handling } = context
  const side = hit.d >= 0 ? 1 : -1
  const inner = hit.halfWidth - handling.radius
  const walled = side > 0 ? hit.wallLeft : hit.wallRight
  if (!walled || Math.abs(hit.d) <= inner) {
    // A car scraping along a wall drifts off it by a hair now and then: that is still one contact.
    if (!walled || Math.abs(hit.d) < inner - handling.wallLetGo) car.wallSide = 0
    return hit.d
  }
  // Road left at the hit.
  const lx = Ops.cos(hit.yaw)
  const lz = -Ops.sin(hit.yaw)
  const over = Math.abs(hit.d) - inner
  car.x -= lx * over * side
  car.z -= lz * over * side
  const into = (car.vx * lx + car.vz * lz) * side
  if (into > 0) {
    const speed = Math.sqrt(car.vx * car.vx + car.vz * car.vz)
    const square = speed > 0 ? into / speed : 0
    car.vx -= lx * side * into
    car.vz -= lz * side * into
    const keep = 1 - handling.wallLoss * square
    car.vx *= keep
    car.vz *= keep
    const alongWall = Math.abs(angleDelta(car.yaw, hit.yaw)) <= Math.PI / 2 ? hit.yaw : hit.yaw + Math.PI
    car.yaw += angleDelta(car.yaw, alongWall) * handling.wallAlign * square
    if ((car.wallSide !== side && into > handling.wallEventFrom) || into > handling.wallEventImpact) {
      context.emit({ kind: "wall", side: side > 0 ? "left" : "right", impact: into, x: car.x, y: car.y, z: car.z })
    }
  }
  // Rubbing along the wall keeps costing speed for as long as the car leans on it.
  const rub = Ops.exp(-handling.wallRub * context.dt)
  car.vx *= rub
  car.vz *= rub
  car.wallSide = side
  return side * inner
}

/**
 * Puts the car back inside the walls after something pushed it (a prop, a post, a door),
 * without touching its speed: the next tick's wall contact does that.
 */
export const keepInside = (car: CarWork, track: TrackData, handling: Handling): void => {
  if (car.motion._tag !== "road") return
  const hit = locateNear(track, car.x, car.z, car.hint)
  const side = hit.d >= 0 ? 1 : -1
  const inner = hit.halfWidth - handling.radius
  if (!(side > 0 ? hit.wallLeft : hit.wallRight) || Math.abs(hit.d) <= inner) return
  const over = Math.abs(hit.d) - inner
  car.x -= Ops.cos(hit.yaw) * over * side
  car.z += Ops.sin(hit.yaw) * over * side
}

/** One tick in the air: gravity, a little steering, walls while low over a road, and the landing. */
const fly = (car: CarWork, context: DriveContext): DriveOutcome => {
  const { handling, dt, track } = context
  car.yaw += car.steer * handling.airSteer * dt
  car.vy -= handling.gravity * dt
  car.x += car.vx * dt
  car.y += car.vy * dt
  car.z += car.vz * dt
  car.slip = 0
  car.load *= Ops.exp(-handling.turnDragBuild * dt)
  const horizontal = Math.sqrt(car.vx * car.vx + car.vz * car.vz)
  const follow = 1 - Ops.exp(-6 * dt)
  car.pitch += (Ops.atan2(car.vy, Math.max(horizontal, 1)) * 0.5 - car.pitch) * follow
  car.roll += (0 - car.roll) * follow

  // The road the car flies along, to keep its place on the lap and its walls while low.
  const near = locateNear(track, car.x, car.z, car.hint)
  car.hint = near.index
  car.s = near.s
  if (near.surface && car.y < near.y + track.wallHeight) hitWalls(car, near, context)

  const below = locateBelow(track, car.x, car.y, car.z, 0, handling.landReach)
  if (below !== null && car.y <= below.y) {
    // Coming down on another part of the track (falling short of a jump onto the road
    // under it) is leaving the road: the lap starts again.
    // Signed, the short way round the lap: a small hop can come down a hair behind where it left.
    const half = track.length / 2
    const leftAt = car.motion._tag === "air" ? car.motion.leftAt : car.s
    const ahead = ((((below.s - leftAt + half) % track.length) + track.length) % track.length) - half
    if (ahead > handling.landAhead || ahead < -handling.landAhead) return "off-track"
    const groundVy = surfaceVy(car.vx, car.vz, below)
    const impact = Math.max(0, groundVy - car.vy)
    if (impact > handling.hardLanding) {
      const keep = 1 - Math.min(handling.landingLossMax, (impact - handling.hardLanding) * handling.landingLoss)
      car.vx *= keep
      car.vz *= keep
    }
    car.y = below.y
    car.vy = surfaceVy(car.vx, car.vz, below)
    car.motion = { _tag: "road" }
    car.hint = below.index
    car.s = below.s
    const tilt = tiltOf(car.yaw, below)
    car.pitch = tilt.pitch
    car.roll = tilt.roll
    context.emit({ kind: "land", impact, x: car.x, y: car.y, z: car.z })
    return "ok"
  }
  // Down on the terrain with no road under it, or fallen far below everything.
  if ((below === null && car.y <= track.wallHeight) || car.y < -20) return "off-track"
  return "ok"
}
