/**
 * What must hold after every tick of a race, whatever the player presses: checked by the
 * fuzzer and by the tests that drive laps. `broken` returns what went wrong, or undefined.
 */
import { Schema } from "effect"
import { CarSchema, LapSchema, ObstaclesSchema } from "../src/sim/schema.ts"
import type { CarState, LapState, ObstacleState } from "../src/sim/schema.ts"
import { locateNear } from "../src/sim/track/index.ts"
import { handling } from "../src/sim/tuning.ts"
import type { TrackData } from "../src/sim/types.ts"

export interface World {
  readonly track: TrackData
  readonly car: CarState
  readonly lap: LapState
  readonly obstacles: ObstacleState
}

type Check = (world: World) => string | undefined

/** The world is valid saved data: every number finite, every value in its schema. */
const SavesAndLoads: Check = ({ car, lap, obstacles }) =>
  !Schema.is(CarSchema)(car)
    ? "the car no longer fits its schema, so a save of it would not load"
    : !Schema.is(LapSchema)(lap)
      ? "the lap no longer fits its schema"
      : !Schema.is(ObstaclesSchema)(obstacles)
        ? "the obstacles no longer fit their schema"
        : undefined

/** On the road the car is between its walls. */
const CarInsideWalls: Check = ({ track, car }) => {
  if (car.motion._tag !== "road") return undefined
  const hit = locateNear(track, car.x, car.z, car.hint)
  const walled = hit.d >= 0 ? hit.wallLeft : hit.wallRight
  const over = Math.abs(hit.d) - (hit.halfWidth - handling.radius)
  return walled && over > 0.01 ? `the car is ${over.toFixed(3)} m through a wall at s=${hit.s.toFixed(1)}` : undefined
}

/** The car never goes faster than anything in the game can make it. */
const CarSpeedSane: Check = ({ car }) => {
  const speed = Math.hypot(car.vx, car.vy, car.vz)
  return speed > 90 ? `the car moves at ${speed.toFixed(1)} m/s` : undefined
}

/** A prop over the road is between the walls, whatever shoved it and however high it is. */
const PropsOnTheRoad: Check = ({ track, obstacles }) => {
  for (let index = 0; index < obstacles.props.length; index++) {
    const prop = obstacles.props[index]
    const shape = track.props[index]
    if (prop === undefined || shape === undefined || prop.lift < 0) continue
    const hit = locateNear(track, prop.x, prop.z, prop.hint, 12)
    if (!hit.surface || !(hit.d >= 0 ? hit.wallLeft : hit.wallRight)) continue
    const over = Math.abs(hit.d) - (hit.halfWidth - shape.radius)
    if (over > 0.01) return `prop ${index} (${shape.kind}) is ${over.toFixed(2)} m through a wall at s=${hit.s.toFixed(1)}`
  }
  return undefined
}

/** A prop never sinks into the road it stands on (below it only when it fell through a jump's gap). */
const PropsAboveTheRoad: Check = ({ track, obstacles }) => {
  for (let index = 0; index < obstacles.props.length; index++) {
    const prop = obstacles.props[index]
    if (prop === undefined || prop.lift >= 0) continue
    if (locateNear(track, prop.x, prop.z, prop.hint, 12).surface && prop.lift > -0.5) return `prop ${index} is ${(-prop.lift).toFixed(2)} m into the road`
  }
  return undefined
}

/** A door leaf stays between its end stops. */
const DoorsWithinStops: Check = ({ track, obstacles }) => {
  for (let index = 0; index < obstacles.doors.length; index++) {
    const door = obstacles.doors[index]
    const max = track.doors[index]?.maxAngle ?? 0
    if (door !== undefined && Math.abs(door.angle) > max + 1e-9) return `door ${index} is at ${door.angle.toFixed(3)} rad, past its stop at ${max}`
  }
  return undefined
}

/** The lap's splits only grow, and the next line to cross is one the track has. */
const LapInOrder: Check = ({ track, lap }) => {
  if (lap._tag === "ready") return undefined
  for (let i = 1; i < lap.splitsMs.length; i++) {
    if ((lap.splitsMs[i] ?? 0) <= (lap.splitsMs[i - 1] ?? 0)) return `split ${i} (${lap.splitsMs[i]}) is not after split ${i - 1} (${lap.splitsMs[i - 1]})`
  }
  if (lap._tag === "running" && lap.next >= track.checkpoints.length) return `the next line is ${lap.next}, and the track has ${track.checkpoints.length}`
  if (lap._tag === "finished" && lap.splitsMs.length !== track.checkpoints.length) return `a finished lap has ${lap.splitsMs.length} splits for ${track.checkpoints.length} lines`
  return undefined
}

const checks: ReadonlyArray<Check> = [SavesAndLoads, CarInsideWalls, CarSpeedSane, PropsOnTheRoad, PropsAboveTheRoad, DoorsWithinStops, LapInOrder]

export const broken = (world: World): string | undefined => {
  for (const check of checks) {
    const found = check(world)
    if (found !== undefined) return found
  }
  return undefined
}
