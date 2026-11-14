/**
 * The race as a ritmo game: the schedule of one tick and the runtime that runs it. This is
 * the simulation's entry module: tests, the lint target and the session build on it. What
 * the world holds is in `state.ts`, each system in `systems/`, the inspectors in `view.ts`.
 *
 * One tick of `update`, in order:
 * 1. the clock advances;
 * 2. `ReadInput` takes the player's input and the steering from the host;
 * 3. `FindBoost` finds the pad under the car;
 * 4. `DriveCar` moves the car (road, air, walls) and asks for a reset when it is off the track;
 * 5. `MoveObstacles` moves the props and the doors, and knocks the car against them and the posts;
 * 6. `CountLap` starts the clock and counts the lines crossed;
 * 7. `Reset` puts everything back on the line when a restart or a reset was asked for;
 * 8. `Collect` keeps this tick's events in `Outbox` for the session.
 */
import { Clock } from "@typeonce/ritmo"
import type { Debug } from "@typeonce/ritmo"
import type { Source } from "@typeonce/ritmo/Schedule"
import { carAt } from "./car.ts"
import { restingObstacles } from "./obstacles.ts"
import type { Steering } from "./schema.ts"
import { CourseService, DriveSource, Game, Time } from "./state.ts"
import type { Course, DriveIntent } from "./state.ts"
import { FindBoost } from "./systems/boost.ts"
import { Collect } from "./systems/collect.ts"
import { DriveCar } from "./systems/drive.ts"
import { ReadInput } from "./systems/input.ts"
import { CountLap } from "./systems/lap.ts"
import { MoveObstacles } from "./systems/obstacles.ts"
import { Reset } from "./systems/reset.ts"
import { locateBelow } from "./track/query.ts"
import { contact, handling, step } from "./tuning.ts"
import type { TrackData } from "./types.ts"

export { Car, ContactValues, CourseService, DriveSource, Game, HandlingValues, Input, Lap, Obstacles, Outbox, Root, SteeringMode, Time } from "./state.ts"
export type { Course, DriveIntent, RaceSchema } from "./state.ts"
export { ReadOutbox, ReadView } from "./view.ts"

const AdvanceTime = Clock.system(Game, { name: "Race/AdvanceTime", resource: Time })

export const update = Game.Schedule(AdvanceTime, ReadInput, FindBoost, DriveCar, MoveObstacles, CountLap, Reset, Collect)

/** The course for a track: the start and the obstacles at rest, worked out once. Throws when the start is not on the road. */
export const courseOf = (track: TrackData): Course => {
  const { start } = track
  const hit = locateBelow(track, start.x, start.y + 0.5, start.z, 0, 1)
  if (hit === null) throw new Error(`The start of ${track.name} is not on the road`)
  return { track, startCar: carAt(start.x, start.z, start.yaw, hit), rest: restingObstacles(track) }
}

/** The input a runtime is given when nothing is pressed. */
export const idleIntent = (steering: Steering): DriveIntent => ({ input: { throttle: 0, brake: 0, steer: 0, aim: null, restart: false }, steering })

const build = <const Enabled extends Debug.Option | undefined>(track: TrackData, steering: Steering, drive: Source<DriveIntent>, debug: Enabled) => {
  const course = courseOf(track)
  const made = Game.Runtime.make({
    services: Game.Runtime.services(Game.Runtime.service(CourseService, course), Game.Runtime.service(DriveSource, drive)),
    resources: {
      Time: Clock.start(step),
      Input: { throttle: 0, brake: 0, steer: 0, aim: null, restartHeld: false },
      SteeringMode: steering,
      Car: course.startCar,
      Lap: { _tag: "ready", attempt: 1 },
      Obstacles: course.rest,
      Outbox: [],
      HandlingValues: handling,
      ContactValues: contact
    },
    debug
  })
  if (!made.ok) throw new Error(`The race could not start: ${JSON.stringify(made.error)}`)
  return made.value
}

/** A runtime for `track`, steered as `steering`, taking each tick's input from `drive`. Throws when the start is off the road. */
export const makeRuntime = (track: TrackData, steering: Steering, drive: Source<DriveIntent>) => build(track, steering, drive, undefined)

/** The same with a devtools debug handle, for `ritmo-devtools lint`, the fuzzer and replays. */
export const makeDebugRuntime = (track: TrackData, steering: Steering, drive: Source<DriveIntent>, debug: Debug.Option) => build(track, steering, drive, debug)
