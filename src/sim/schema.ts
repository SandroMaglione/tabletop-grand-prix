/**
 * The race as saved data: every value the world keeps is an Effect schema here (through
 * `codec`), so a race can be saved, restored, replayed and fuzzed, and every type the rules
 * work on is read off its schema. The rules change a mutable copy (`CarWork`, and the
 * working copies in `obstacles.ts`); Ritmo and the page see the values read-only.
 *
 * A value that only means something in one situation lives in that situation's state: the
 * car is on the road or in the air (and only in the air does it remember where it left the
 * ground); its boost is off, on a pad, or fading out (and only then does it have an end);
 * the lap is ready, running or finished, each with its own fields.
 */
import { Clock } from "@typeonce/ritmo"
import { Schema as S } from "effect"
import { step } from "./tuning.ts"

/** An Effect schema as a Ritmo codec: decodes saved JSON, and encodes values back to it. */
export const codec = <Sc extends S.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(schema: Sc) => {
  const json = S.toCodecJson(schema)
  return {
    "~standard": S.toStandardSchemaV1(json)["~standard"],
    "~encode": S.toStandardSchemaV1(S.flip(json))
  }
}

/** A finite number: a save holding Infinity or NaN would not load again. */
const num = S.Finite
/** A whole number, zero or more. */
const count = S.Int.check(S.isGreaterThanOrEqualTo(0))
/** A value from 0 to 1. */
const share = S.Finite.check(S.isGreaterThanOrEqualTo(0), S.isLessThanOrEqualTo(1))
/** A step of the race's clock something ends on. */
const deadline = S.declare(Clock.isDeadline(step))

// ── Steering and input ─────────────────────────────────────────────────

/** How the car is steered: by the wheel, or by pointing where to go. The physics is the same. */
export const STEERINGS = ["car", "screen"] as const
export const SteeringSchema = S.Literals(STEERINGS)
export type Steering = typeof SteeringSchema.Type
export const isSteering = (name: string): name is Steering => STEERINGS.some((known) => known === name)

const AimSchema = S.NullOr(S.Struct({ x: num, z: num }))

/** The input for this tick, as the systems read it. */
export const ControlsSchema = S.Struct({
  throttle: num,
  brake: num,
  steer: num,
  aim: AimSchema,
  /** `DriveInput.restart` as last given, to see the tick it turns true. */
  restartHeld: S.Boolean
})
export type Controls = typeof ControlsSchema.Type

// ── The car ────────────────────────────────────────────────────────────

/** On the road, or in the air since it left the ground at centreline distance `leftAt` (a landing far from it is not this jump's landing). */
export const MotionSchema = S.Union([S.Struct({ _tag: S.Literal("road") }), S.Struct({ _tag: S.Literal("air"), leftAt: num })])
export type Motion = typeof MotionSchema.Type

/** The raised speed limit: off, held while the car is on pad `index`, or falling back until step `until` after it left one. */
export const BoostSchema = S.Union([
  S.Struct({ _tag: S.Literal("off") }),
  S.Struct({ _tag: S.Literal("pad"), index: count }),
  S.Struct({ _tag: S.Literal("fading"), until: deadline })
])
export type Boost = typeof BoostSchema.Type

/**
 * How the tyres hold:
 * - `grip`: as a car does.
 * - `drift`: sliding round a corner to one `side` (1 left, -1 right) since step `since`; how
 *   long it has been held is what the push at the end is paid by.
 * - `spent`: a drift was cut short (a wall, too slow, a jump) with the brake still held. The
 *   brake does nothing until it is let go, so the hand that held the slide does not stop the car.
 */
export const DriftSchema = S.Union([
  S.Struct({ _tag: S.Literal("grip") }),
  S.Struct({ _tag: S.Literal("drift"), side: S.Literals([-1, 1]), since: count }),
  S.Struct({ _tag: S.Literal("spent") })
])
export type Drift = typeof DriftSchema.Type

/** The car between ticks. */
export const CarSchema = S.Struct({
  x: num,
  y: num,
  z: num,
  yaw: num,
  vx: num,
  vy: num,
  vz: num,
  /** Smoothed wheel angle, -1 (right) to 1 (left). */
  steer: num,
  slip: share,
  pitch: num,
  roll: num,
  /** The throttle and brake applied this tick, for the picture. */
  throttle: share,
  brake: share,
  motion: MotionSchema,
  /** Sample index near the car, the search hint for `locateNear`. */
  hint: S.Int,
  /** Centreline distance now and before this tick's move, for line crossings. */
  s: num,
  prevS: num,
  boost: BoostSchema,
  /** The wall touched last tick: 1 left, -1 right, 0 none. Sends one `wall` event per contact. */
  wallSide: S.Literals([-1, 0, 1]),
  /** How hard the car has been turning lately: -1 (right) to 1 (left), as a share of the most it can. A held turn costs speed by it. */
  load: num,
  drift: DriftSchema
})
export type CarState = typeof CarSchema.Type

// ── The lap ────────────────────────────────────────────────────────────

const splits = S.Array(num)

/** The attempt: before the clock starts, while it runs, and once the lap is done. */
export const LapSchema = S.Union([
  S.Struct({ _tag: S.Literal("ready"), attempt: count }),
  S.Struct({
    _tag: S.Literal("running"),
    attempt: count,
    /** The clock reads zero at this step. */
    startStep: count,
    /** Index into `TrackData.checkpoints` of the next line to cross. */
    next: count,
    splitsMs: splits
  }),
  S.Struct({ _tag: S.Literal("finished"), attempt: count, startStep: count, timeMs: num, splitsMs: splits })
])
export type LapState = typeof LapSchema.Type

// ── Props, doors and posts ─────────────────────────────────────────────

/** A prop between ticks. */
export const PropSchema = S.Struct({
  x: num,
  z: num,
  /** Height of the road under it, and how far its base is above that. */
  roadY: num,
  lift: num,
  vx: num,
  vz: num,
  /** Vertical speed while it falls. */
  vlift: num,
  yaw: num,
  /** Turn rate around the vertical, rad/s. */
  spin: num,
  /** Sample index near it, the search hint for `locateNear`. */
  hint: S.Int,
  /** False once it rests: a resting prop costs nothing until something touches it. */
  awake: S.Boolean,
  /** The car touched it last tick. Sends one `prop` event per contact. */
  touched: S.Boolean,
  /** The wall it leans on: 1 left, -1 right, 0 none. A prop held against a wall cannot be pushed further into it. */
  wall: S.Literals([-1, 0, 1])
})
export type PropState = typeof PropSchema.Type

export const DoorSchema = S.Struct({
  /** Turn from closed, radians. */
  angle: num,
  /** Turn rate, rad/s. */
  speed: num,
  touched: S.Boolean
})
export type DoorState = typeof DoorSchema.Type

/** Everything the car can knock into, between ticks. */
export const ObstaclesSchema = S.Struct({
  props: S.Array(PropSchema),
  doors: S.Array(DoorSchema),
  /** Index of the post the car touched last tick, or null. */
  post: S.NullOr(count)
})
export type ObstacleState = typeof ObstaclesSchema.Type
