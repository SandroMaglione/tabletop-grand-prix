/**
 * The things on the road the car collides with: loose props, fixed posts and swing doors.
 *
 * Seen from above everything is a circle (the car, a prop, a post) or a line (a door leaf),
 * and a collision trades momentum along the line between the two. A prop also has a height
 * above the road, so a crate stacked on another falls when the one under it is knocked
 * away. Nothing breaks: a prop stays where it stops until the attempt starts again.
 *
 * Plain functions over working copies, like `car.ts`. No state lives in this module.
 */
import { Ops } from "@typeonce/ritmo"
import type { CarWork } from "./car.ts"
import { angleDelta, locateBelow, locateNear } from "./track/query.ts"
import { contact, propPhysics } from "./tuning.ts"
import type { Handling } from "./tuning.ts"
import type { RaceEvent, SwingDoor, TrackData } from "./types.ts"

/** A prop between ticks. */
export interface PropState {
  readonly x: number
  readonly z: number
  /** Height of the road under it, and how far its base is above that. */
  readonly roadY: number
  readonly lift: number
  readonly vx: number
  readonly vz: number
  /** Vertical speed while it falls. */
  readonly vlift: number
  readonly yaw: number
  /** Turn rate around the vertical, rad/s. */
  readonly spin: number
  /** Sample index near it, the search hint for `locateNear`. */
  readonly hint: number
  /** False once it rests: a resting prop costs nothing until something touches it. */
  readonly awake: boolean
  /** The car touched it last tick. Sends one `prop` event per contact. */
  readonly touched: boolean
  /** The wall it leans on: 1 left, -1 right, 0 none. A prop held against a wall cannot be pushed further into it. */
  readonly wall: number
}

export interface DoorState {
  /** Turn from closed, radians. */
  readonly angle: number
  /** Turn rate, rad/s. */
  readonly speed: number
  readonly touched: boolean
}

/** Everything the car can knock into, between ticks. */
export interface ObstacleState {
  readonly props: ReadonlyArray<PropState>
  readonly doors: ReadonlyArray<DoorState>
  /** Index of the post the car touched last tick, or -1. */
  readonly post: number
}

type PropWork = { -readonly [K in keyof PropState]: PropState[K] }
type DoorWork = { -readonly [K in keyof DoorState]: DoorState[K] }

export interface ObstacleContext {
  readonly track: TrackData
  readonly handling: Handling
  readonly dt: number
  readonly emit: (event: RaceEvent) => void
}

/** Everything standing where the track puts it. Throws when a prop is not over the road. */
export const restingObstacles = (track: TrackData): ObstacleState => ({
  props: track.props.map((prop, index) => {
    const hit = locateBelow(track, prop.x, prop.y + 0.5, prop.z, 0, 0.5)
    if (hit === null) throw new Error(`Prop ${index} of ${track.name} (${prop.kind}) is not over the road`)
    return {
      x: prop.x,
      z: prop.z,
      roadY: hit.y,
      lift: Math.max(0, prop.y - hit.y),
      vx: 0,
      vz: 0,
      vlift: 0,
      yaw: prop.yaw,
      spin: 0,
      hint: hit.index,
      awake: false,
      touched: false,
      wall: 0
    }
  }),
  doors: track.doors.map(() => ({ angle: 0, speed: 0, touched: false })),
  post: -1
})

/** Whether two things overlap in height: bases `a` and `b`, heights `ha` and `hb`. */
const levelWith = (a: number, ha: number, b: number, hb: number): boolean => a < b + hb - 0.05 && b < a + ha - 0.05

/** One tick of every obstacle, and of the car against them. Changes `car` in place; returns the obstacles after the tick (the same object when nothing moved). */
export const stepObstacles = (car: CarWork, state: ObstacleState, context: ObstacleContext): ObstacleState => {
  const { track, handling } = context
  const reach = handling.radius + 0.1
  const propsBusy = state.props.some((prop, index) => {
    if (prop.awake || prop.touched) return true
    const shape = track.props[index]
    if (shape === undefined) return false
    const dx = prop.x - car.x
    const dz = prop.z - car.z
    const near = reach + shape.radius
    return dx * dx + dz * dz < near * near
  })
  const props = propsBusy ? stepProps(car, state.props, context) : state.props
  const post = hitPosts(car, state.post, context)
  const doors = stepDoors(car, state.doors, context)
  if (props === state.props && doors === state.doors && post === state.post) return state
  return { props, doors, post }
}

// ── Props ──────────────────────────────────────────────────────────────

const stepProps = (car: CarWork, before: ReadonlyArray<PropState>, context: ObstacleContext): ReadonlyArray<PropState> => {
  const { track, handling, dt, emit } = context
  const props: Array<PropWork> = before.map((prop) => ({ ...prop }))
  const shapeOf = (index: number) => {
    const shape = track.props[index]
    if (shape === undefined) throw new Error(`No prop ${index}`)
    return shape
  }
  const knock = (index: number, impact: number): void => {
    const prop = props[index]
    if (prop === undefined || impact < contact.knockFrom) return
    emit({ kind: "knock", index, prop: shapeOf(index).kind, impact, x: prop.x, y: prop.roadY + prop.lift, z: prop.z })
  }

  // What holds each raised prop up: another prop right under it.
  const supportOf = (index: number): number => {
    const prop = props[index]
    if (prop === undefined) return -1
    for (let other = 0; other < props.length; other++) {
      const under = props[other]
      if (other === index || under === undefined) continue
      const shape = shapeOf(other)
      if (Math.abs(under.lift + shape.height - prop.lift) > 0.12) continue
      const dx = prop.x - under.x
      const dz = prop.z - under.z
      if (dx * dx + dz * dz < shape.radius * shape.radius * 0.5) return other
    }
    return -1
  }

  // Move.
  for (let index = 0; index < props.length; index++) {
    const prop = props[index]
    if (prop === undefined) continue
    const shape = shapeOf(index)
    const physics = propPhysics[shape.kind]
    // Fallen through a jump gap and out of sight: it rests there.
    if (prop.lift < -15) {
      prop.awake = false
      continue
    }
    if (prop.lift > 0 || prop.vlift !== 0) {
      const support = supportOf(index)
      const under = support >= 0 ? props[support] : undefined
      if (under !== undefined && !under.awake) {
        prop.vlift = 0
      } else {
        // Nothing under it, or what is under it is moving: it comes down.
        if (!prop.awake && under !== undefined) {
          prop.vx = under.vx * contact.carry
          prop.vz = under.vz * contact.carry
        }
        prop.awake = true
        prop.vlift -= contact.gravity * dt
      }
    }
    if (!prop.awake) continue

    const onRoad = prop.lift <= 0 && prop.vlift === 0
    const speed = Math.sqrt(prop.vx * prop.vx + prop.vz * prop.vz)
    if (onRoad && speed > 0) {
      const keep = Math.max(0, 1 - (physics.friction * dt) / speed)
      prop.vx *= keep
      prop.vz *= keep
    }
    prop.spin *= Ops.exp(-(onRoad ? contact.spinDrag : 0.3) * dt)
    prop.x += prop.vx * dt
    prop.z += prop.vz * dt
    prop.yaw += prop.spin * dt

    // The road under it, and its walls.
    const hit = locateNear(track, prop.x, prop.z, prop.hint, 12)
    prop.hint = hit.index
    prop.wall = 0
    if (hit.surface) {
      prop.roadY = hit.y
      const side = hit.d >= 0 ? 1 : -1
      const inner = hit.halfWidth - shape.radius
      const walled = side > 0 ? hit.wallLeft : hit.wallRight
      if (walled && Math.abs(hit.d) > inner && prop.lift < track.wallHeight) {
        const lx = Ops.cos(hit.yaw)
        const lz = -Ops.sin(hit.yaw)
        const over = Math.abs(hit.d) - inner
        prop.x -= lx * over * side
        prop.z -= lz * over * side
        const into = (prop.vx * lx + prop.vz * lz) * side
        if (into > 0) {
          prop.vx -= lx * side * into * (1 + physics.bounce)
          prop.vz -= lz * side * into * (1 + physics.bounce)
          knock(index, into)
        }
        prop.wall = side
      }
    }

    // Falling: onto the road, or through a gap.
    if (prop.vlift !== 0 || prop.lift > 0) {
      prop.lift += prop.vlift * dt
      if (hit.surface && prop.lift <= 0) {
        knock(index, -prop.vlift)
        prop.lift = 0
        prop.vlift = 0
      }
    } else if (!hit.surface) {
      prop.vlift = -contact.gravity * dt
    }
  }

  // The car against each prop.
  const carMass = 1
  for (let index = 0; index < props.length; index++) {
    const prop = props[index]
    if (prop === undefined) continue
    const shape = shapeOf(index)
    const physics = propPhysics[shape.kind]
    const dx = prop.x - car.x
    const dz = prop.z - car.z
    const reach = handling.radius + shape.radius
    const distanceSquared = dx * dx + dz * dz
    const touching = distanceSquared < reach * reach && levelWith(car.y, handling.height, prop.roadY + prop.lift, shape.height)
    if (!touching) {
      prop.touched = false
      continue
    }
    const distance = Math.sqrt(distanceSquared)
    // From the car to the prop. Right on top of each other: push it along the car's way.
    const nx = distance > 1e-6 ? dx / distance : Ops.sin(car.yaw)
    const nz = distance > 1e-6 ? dz / distance : Ops.cos(car.yaw)
    // A prop held against a wall has nowhere to go that way: the car meets something fixed.
    let mass = physics.mass
    if (prop.wall !== 0) {
      const hit = locateNear(track, prop.x, prop.z, prop.hint, 4)
      const outward = (nx * Ops.cos(hit.yaw) - nz * Ops.sin(hit.yaw)) * prop.wall
      if (outward > 0.3) mass = 1e6
    }
    const closing = (car.vx - prop.vx) * nx + (car.vz - prop.vz) * nz
    if (closing > 0) {
      const impulse = ((1 + physics.bounce) * closing * carMass * mass) / (carMass + mass)
      car.vx -= (impulse / carMass) * nx
      car.vz -= (impulse / carMass) * nz
      prop.vx += (impulse / mass) * nx
      prop.vz += (impulse / mass) * nz
      // A hit off its centre spins it.
      const across = (car.vx - prop.vx) * nz - (car.vz - prop.vz) * nx
      prop.spin += Math.max(-contact.spinMax, Math.min(contact.spinMax, (across / shape.radius) * contact.spinShare))
      prop.awake = true
      if (!prop.touched && closing > contact.eventFrom) {
        emit({ kind: "prop", index, prop: shape.kind, impact: closing, x: prop.x, y: prop.roadY + prop.lift, z: prop.z })
      }
    }
    const overlap = reach - distance
    const share = carMass / (carMass + mass)
    prop.x += nx * overlap * share
    prop.z += nz * overlap * share
    car.x -= nx * overlap * (1 - share)
    car.z -= nz * overlap * (1 - share)
    prop.touched = true
  }

  // Props against each other.
  for (let a = 0; a < props.length; a++) {
    const first = props[a]
    if (first === undefined) continue
    const shapeA = shapeOf(a)
    for (let b = a + 1; b < props.length; b++) {
      const second = props[b]
      if (second === undefined || (!first.awake && !second.awake)) continue
      const shapeB = shapeOf(b)
      const dx = second.x - first.x
      const dz = second.z - first.z
      const reach = shapeA.radius + shapeB.radius
      const distanceSquared = dx * dx + dz * dz
      if (distanceSquared >= reach * reach) continue
      if (!levelWith(first.roadY + first.lift, shapeA.height, second.roadY + second.lift, shapeB.height)) continue
      const distance = Math.sqrt(distanceSquared)
      const nx = distance > 1e-6 ? dx / distance : 1
      const nz = distance > 1e-6 ? dz / distance : 0
      const massA = propPhysics[shapeA.kind].mass
      const massB = propPhysics[shapeB.kind].mass
      const closing = (first.vx - second.vx) * nx + (first.vz - second.vz) * nz
      if (closing > 0) {
        const bounce = Math.min(propPhysics[shapeA.kind].bounce, propPhysics[shapeB.kind].bounce)
        const impulse = ((1 + bounce) * closing * massA * massB) / (massA + massB)
        first.vx -= (impulse / massA) * nx
        first.vz -= (impulse / massA) * nz
        second.vx += (impulse / massB) * nx
        second.vz += (impulse / massB) * nz
        const across = (first.vx - second.vx) * nz - (first.vz - second.vz) * nx
        second.spin += Math.max(-contact.spinMax, Math.min(contact.spinMax, (across / shapeB.radius) * contact.spinShare))
        first.spin -= Math.max(-contact.spinMax, Math.min(contact.spinMax, (across / shapeA.radius) * contact.spinShare))
        knock(massA < massB ? a : b, closing)
        first.awake = true
        second.awake = true
      }
      // Apart, a little each tick: a crate that lands on another slides off it instead of jumping aside.
      const overlap = Math.min(reach - distance, contact.separate)
      const share = massA / (massA + massB)
      first.x -= nx * overlap * (1 - share)
      first.z -= nz * overlap * (1 - share)
      second.x += nx * overlap * share
      second.z += nz * overlap * share
      if (reach - distance > 0.02) {
        first.awake = true
        second.awake = true
      }
    }
  }

  // Props against the posts.
  for (let index = 0; index < props.length; index++) {
    const prop = props[index]
    if (prop === undefined || !prop.awake) continue
    const shape = shapeOf(index)
    for (const post of track.bollards) {
      const dx = prop.x - post.x
      const dz = prop.z - post.z
      const reach = shape.radius + post.radius
      const distanceSquared = dx * dx + dz * dz
      if (distanceSquared >= reach * reach || !levelWith(prop.roadY + prop.lift, shape.height, post.y, post.height)) continue
      const distance = Math.sqrt(distanceSquared)
      const nx = distance > 1e-6 ? dx / distance : 1
      const nz = distance > 1e-6 ? dz / distance : 0
      prop.x += nx * (reach - distance)
      prop.z += nz * (reach - distance)
      const into = -(prop.vx * nx + prop.vz * nz)
      if (into > 0) {
        const bounce = propPhysics[shape.kind].bounce
        prop.vx += nx * into * (1 + bounce)
        prop.vz += nz * into * (1 + bounce)
        knock(index, into)
      }
    }
  }

  // Rest.
  for (let index = 0; index < props.length; index++) {
    const prop = props[index]
    if (prop === undefined || !prop.awake) continue
    const still = prop.vx * prop.vx + prop.vz * prop.vz < contact.restSpeed * contact.restSpeed && Math.abs(prop.spin) < 0.2
    if (still && prop.vlift === 0 && !prop.touched) {
      prop.vx = 0
      prop.vz = 0
      prop.spin = 0
      prop.awake = false
    }
  }
  return props
}

// ── Posts ──────────────────────────────────────────────────────────────

/** The car against the fixed posts: it slides round them and loses speed by how square it hit. Returns the post touched, or -1. */
const hitPosts = (car: CarWork, before: number, context: ObstacleContext): number => {
  const { track, handling, emit } = context
  let touched = -1
  for (let index = 0; index < track.bollards.length; index++) {
    const post = track.bollards[index]
    if (post === undefined) continue
    const dx = car.x - post.x
    const dz = car.z - post.z
    const reach = handling.radius + post.radius
    const distanceSquared = dx * dx + dz * dz
    if (distanceSquared >= reach * reach || !levelWith(car.y, handling.height, post.y, post.height)) continue
    const distance = Math.sqrt(distanceSquared)
    const nx = distance > 1e-6 ? dx / distance : -Ops.sin(car.yaw)
    const nz = distance > 1e-6 ? dz / distance : -Ops.cos(car.yaw)
    car.x += nx * (reach - distance)
    car.z += nz * (reach - distance)
    const into = -(car.vx * nx + car.vz * nz)
    if (into > 0) {
      const speed = Math.sqrt(car.vx * car.vx + car.vz * car.vz)
      const square = speed > 0 ? into / speed : 0
      car.vx += nx * into * (1 + contact.postBounce)
      car.vz += nz * into * (1 + contact.postBounce)
      const keep = 1 - contact.postLoss * square
      car.vx *= keep
      car.vz *= keep
      // The nose turns to slide round the post, on the side it was already heading for.
      const turned = (Ops.sin(car.yaw) * nz - Ops.cos(car.yaw) * nx >= 0 ? 1 : -1) * (Math.PI / 2)
      const round = Ops.atan2(nx, nz) + turned
      car.yaw += angleDelta(car.yaw, round) * contact.postAlign * square
      if (before !== index && into > contact.eventFrom) emit({ kind: "bollard", index, impact: into, x: post.x, y: post.y, z: post.z })
    }
    touched = index
  }
  return touched
}

// ── Doors ──────────────────────────────────────────────────────────────

/** The leaf's turning inertia about its hinge, for a mass spread evenly along it. */
const inertiaOf = (door: SwingDoor): number => (contact.doorMass * door.length * door.length) / 3

const stepDoors = (car: CarWork, before: ReadonlyArray<DoorState>, context: ObstacleContext): ReadonlyArray<DoorState> => {
  const { track, handling, dt, emit } = context
  let doors: Array<DoorWork> | null = null
  for (let index = 0; index < track.doors.length; index++) {
    const door = track.doors[index]
    const was = before[index]
    if (door === undefined || was === undefined) continue
    let angle = was.angle
    let speed = was.speed
    let touched = false

    // Swing on, slowing; it stops against its end stops.
    if (speed !== 0) {
      speed *= Ops.exp(-contact.doorDrag * dt)
      if (Math.abs(speed) < contact.doorRest) speed = 0
      angle += speed * dt
      if (Math.abs(angle) > door.maxAngle) {
        angle = Math.sign(angle) * door.maxAngle
        speed = -speed * contact.doorBounce
      }
    }

    if (Math.abs(car.y - door.y) < 1.5) {
      const heading = door.yaw + angle
      const ux = Ops.sin(heading)
      const uz = Ops.cos(heading)
      const along = Math.max(0, Math.min(door.length, (car.x - door.x) * ux + (car.z - door.z) * uz))
      const dx = car.x - (door.x + ux * along)
      const dz = car.z - (door.z + uz * along)
      const reach = handling.radius + door.thickness / 2
      const distanceSquared = dx * dx + dz * dz
      if (distanceSquared < reach * reach) {
        const distance = Math.sqrt(distanceSquared)
        // The way a point of the leaf moves as the angle grows.
        const px = uz
        const pz = -ux
        // From the leaf to the car.
        const side = (car.x - door.x) * px + (car.z - door.z) * pz >= 0 ? 1 : -1
        const nx = distance > 1e-6 ? dx / distance : px * side
        const nz = distance > 1e-6 ? dz / distance : pz * side
        const lever = along * (px * nx + pz * nz)
        const closing = speed * lever - (car.vx * nx + car.vz * nz)
        if (closing > 0) {
          // Against its end stop it cannot turn further: the car meets something fixed.
          const blocked = Math.abs(angle) >= door.maxAngle - 1e-6 && Math.sign(-lever) === Math.sign(angle)
          const give = blocked ? 0 : (lever * lever) / inertiaOf(door)
          const impulse = ((1 + contact.doorBounce) * closing) / (1 + give)
          car.vx += impulse * nx
          car.vz += impulse * nz
          if (!blocked) speed -= (impulse * lever) / inertiaOf(door)
          if (!was.touched && closing > contact.eventFrom) emit({ kind: "door", index, impact: closing, x: door.x + ux * along, y: door.y, z: door.z + uz * along })
        }
        car.x += nx * (reach - distance)
        car.z += nz * (reach - distance)
        touched = true
      }
    }

    if (angle === was.angle && speed === was.speed && touched === was.touched) continue
    doors ??= before.map((state) => ({ ...state }))
    doors[index] = { angle, speed, touched }
  }
  return doors ?? before
}
