/**
 * What the race's world holds, and what the host gives it.
 *
 * - Saved state (a snapshot keeps it, a restore brings it back): the clock, the input held
 *   this tick, the steering, the car, the lap and the obstacles. Each is built from its
 *   schema in `schema.ts`.
 * - Unsaved state: `Outbox` (this tick's events, for the session) and the game's values
 *   (`HandlingValues`, `ContactValues`). The values are the rules, not the race: after a
 *   restore they are what this build was made with, never what an old save held.
 * - From the host: the track (`CourseService`, plain data worked out once) and the player's
 *   input, one value per tick (`DriveSource`), which is also what replays and the fuzzer feed.
 */
import { Clock, Descriptor, Schema } from "@typeonce/ritmo"
import type { Source } from "@typeonce/ritmo/Schedule"
import { CarSchema, ControlsSchema, LapSchema, ObstaclesSchema, SteeringSchema, codec } from "./schema.ts"
import type { CarState, ObstacleState, Steering } from "./schema.ts"
import { contactMeta, handlingMeta, step } from "./tuning.ts"
import type { Contact, Handling } from "./tuning.ts"
import type { DriveInput, RaceEvent, TrackData } from "./types.ts"

/** The track and what is worked out from it once: where the car starts and how the obstacles stand. */
export interface Course {
  readonly track: TrackData
  /** The car on the start line. */
  readonly startCar: CarState
  /** Every prop and door as an attempt begins. */
  readonly rest: ObstacleState
}

/** What the host asks for one tick: the player's input and how the car is steered. */
export interface DriveIntent {
  readonly input: DriveInput
  readonly steering: Steering
}

export const Time = Clock.resource("Race/Time", step)
export const Input = Descriptor.ConstructedResource(codec(ControlsSchema))("Race/Input", {
  meta: {
    throttle: { unit: "share", range: [0, 1] },
    brake: { unit: "share", range: [0, 1] },
    steer: { unit: "lock", range: [-1, 1], hint: "Positive turns left." }
  }
})
export const SteeringMode = Descriptor.ConstructedResource(codec(SteeringSchema))("Race/Steering")
export const Car = Descriptor.ConstructedResource(codec(CarSchema))("Race/Car", {
  meta: {
    x: { unit: "m" },
    y: { unit: "m", range: [-25, 40], hint: "Height of the car's base; far below the road it is off the track." },
    z: { unit: "m" },
    yaw: { unit: "rad", hint: "Yaw 0 faces +Z; it grows turning left and is not wrapped." },
    vx: { unit: "m/s", range: [-60, 60] },
    vy: { unit: "m/s", range: [-60, 60] },
    vz: { unit: "m/s", range: [-60, 60] },
    steer: { unit: "lock", range: [-1, 1] },
    slip: { unit: "share", range: [0, 1] },
    pitch: { unit: "rad", range: [-1.2, 1.2] },
    roll: { unit: "rad", range: [-1.2, 1.2] },
    s: { unit: "m", hint: "Centreline distance from the start line." },
    prevS: { unit: "m" },
    load: { unit: "share", range: [-1, 1] }
  }
})
export const Lap = Descriptor.ConstructedResource(codec(LapSchema))("Race/Lap")
/** The props, the doors and the post the car touches. */
export const Obstacles = Descriptor.ConstructedResource(codec(ObstaclesSchema))("Race/Obstacles")
/** What happened during the last tick, for the session to collect. */
export const Outbox = Descriptor.TransientResource<ReadonlyArray<RaceEvent>>()("Race/Outbox")
/** The car's numbers (`tuning.ts`). */
export const HandlingValues = Descriptor.TransientResource<Handling>()("Race/Handling", { meta: handlingMeta })
/** The numbers of every collision with props, posts and doors (`tuning.ts`). */
export const ContactValues = Descriptor.TransientResource<Contact>()("Race/Contact", { meta: contactMeta })

export const CourseService = Descriptor.Service<Course>()("Race/Course")
/** The player's input for the tick about to run. */
export const DriveSource = Descriptor.Service<Source<DriveIntent>>()("Race/DriveSource")

/** Everything the page hears about, collected by the session for `drainEvents`. */
export const Happened = Descriptor.Event<RaceEvent>()("Race/Happened")
/** A request to start the attempt again, handled at the end of the tick. */
export const ResetRequest = Descriptor.Event<{ readonly reason: "off-track" | "manual" }>()("Race/ResetRequest")

export const Root = Schema.defineRoot("Race")
const schema = Schema.fragment({
  resources: { Time, Input, SteeringMode, Car, Lap, Obstacles, Outbox, HandlingValues, ContactValues },
  events: { Happened, ResetRequest }
})
type SchemaOf = typeof schema
/** The race's schema by name, so a type error prints `RaceSchema` instead of every descriptor. */
export interface RaceSchema extends SchemaOf {}
const named: RaceSchema = schema
export const Game = Schema.bind(named, Root)
