/**
 * Every number that shapes how the car feels, and the named handling variants the game
 * switches between (`RaceSession.setVariant`).
 *
 * A variant is a whole `Handling`: the shared `base` with a few numbers or rules changed.
 * Add a variant by adding its name to `variantNames` and an entry to `variants`.
 */
import { Clock } from "@typeonce/ritmo"
import type { PropKind } from "./types.ts"

/** The simulation's fixed step: 120 ticks per second. */
export const step = Clock.hz(120)

/** How long the raised speed limit takes to fall back after the car leaves a boost pad. */
export const boostFade = Clock.duration(step, 1)

/**
 * How each kind of prop answers a push. `mass` is relative to the car (the car is 1): a
 * head-on hit costs the car about `mass / (1 + mass)` of its speed. `friction` is how fast
 * it slows on the road, m/s^2 (a ball rolls, so it is low). `bounce` is the share of the
 * closing speed it springs back with off the car, a wall or another prop.
 */
export const propPhysics: Record<PropKind, { readonly mass: number; readonly friction: number; readonly bounce: number }> = {
  crate: { mass: 0.08, friction: 8, bounce: 0.15 },
  barrel: { mass: 0.05, friction: 6, bounce: 0.25 },
  cone: { mass: 0.01, friction: 7, bounce: 0.2 },
  ball: { mass: 0.3, friction: 3, bounce: 0.5 }
}

/** The numbers shared by every collision with props, posts and doors. */
export const contact = {
  /** Gravity on a prop that falls off a stack, m/s^2. */
  gravity: 24,
  /** Share of the speed of the prop under it that a prop keeps when it loses its footing. */
  carry: 0.6,
  /** How fast a prop's spin dies on the road, 1/s. */
  spinDrag: 2.5,
  /** Share of the sideways speed of a hit that becomes spin, and the most spin a hit gives, rad/s. */
  spinShare: 0.35,
  spinMax: 9,
  /** The most two overlapping props move apart in one tick, metres. */
  separate: 0.03,
  /** A prop slower than this rests, m/s. */
  restSpeed: 0.08,
  /** Closing speed from which the car's hit sends an event, and from which a prop's own knock does, m/s. */
  eventFrom: 1,
  knockFrom: 3.5,
  /** A post: share of the speed into it that bounces the car back, share of speed a square hit costs, and share of the angle the nose turns to slide round it. */
  postBounce: 0.15,
  postLoss: 0.35,
  postAlign: 0.5,
  /** A door leaf: mass relative to the car, how fast its swing dies (1/s), the swing below which it stops (rad/s), and its bounce off the car and its end stops. */
  doorMass: 0.25,
  doorDrag: 1.4,
  doorRest: 0.03,
  doorBounce: 0.1
}

export interface Handling {
  /** `car`: `DriveInput.steer` turns the wheel. `screen`: the car turns toward `DriveInput.aim`. */
  readonly steering: "car" | "screen"

  // Engine and brakes, along the car's heading.
  /** Push of the engine from standstill at full throttle, m/s^2. It fades to zero at the speed limit. */
  readonly engineAccel: number
  /** Speed limit on the road without boost, m/s. */
  readonly topSpeed: number
  /** Slowing with the throttle off: a constant part, m/s^2 ... */
  readonly rolling: number
  /** ... and a part that grows with the square of speed (1/m). */
  readonly drag: number
  /** Slowing at full brake while moving forward, m/s^2. */
  readonly brakeDecel: number
  /** Fastest reverse, m/s, and how hard reverse pulls, m/s^2. */
  readonly reverseSpeed: number
  readonly reverseAccel: number
  /** Slowing when above the speed limit (after a boost), per m/s over the limit, 1/s. */
  readonly overspeedPull: number

  // Steering and grip.
  /** How fast the wheel follows the input, 1/s: higher feels twitchier, lower smooths keyboard taps. */
  readonly steerResponse: number
  /** Tightest turn at low speed at full lock, metres: sets the turn rate below ~10 m/s. */
  readonly minTurnRadius: number
  /** Most sideways acceleration the steering may ask for, m/s^2: sets the turn rate at speed (less lock when fast). */
  readonly turnAccel: number
  /** Slowing in a turn held at the car's limit, as a share of `turnAccel`. Higher makes the car slow itself more in a corner. */
  readonly turnDrag: number
  /** How fast that slowing builds while a turn is held, 1/s. Lower forgives taps on a straight. */
  readonly turnDragBuild: number
  /** How fast grip removes the sideways part of the velocity, 1/s. Lower slides more. */
  readonly grip: number
  /** Share of the sideways speed grip removes that is lost rather than turned forward (0 to 1). Higher makes slides cost more. */
  readonly scrub: number
  /** Sideways speed where `slip` starts to rise, and the extra sideways speed over which it reaches 1, m/s. */
  readonly slipFrom: number
  readonly slipRange: number
  /** Screen steering: wheel lock per radian of angle between the heading and the aim. Higher snaps to the aim. */
  readonly aimGain: number

  // The road's shape.
  /** Share of gravity along the road that speeds the car up downhill and slows it uphill. */
  readonly slopeGain: number
  /** Share of gravity that a banked turn adds to `turnAccel` when the bank leans into the turn. */
  readonly bankGrip: number
  /** Share of gravity across the road that pulls the car toward the bank's low side (in a banked turn, toward the inside). */
  readonly bankSlide: number
  /** Speed from which that pull is whole, m/s; below it the pull fades, so a stopped car does not creep. */
  readonly bankSlideSpeed: number
  /** How far below its own flight the road may drop in one tick before the car leaves it over a crest, metres. */
  readonly crestTolerance: number

  // Air.
  /** Gravity, m/s^2. */
  readonly gravity: number
  /** Turn rate at full lock in the air, rad/s. */
  readonly airSteer: number
  /** How far above the car a landing surface still catches it, metres. */
  readonly landReach: number
  /** How far along the lap from the take-off a landing may be, metres. Further is another part of the track: a reset. */
  readonly landAhead: number
  /** Landing speed into the road above which a landing is hard and costs speed, m/s ... */
  readonly hardLanding: number
  /** ... the share of speed lost per m/s over it ... */
  readonly landingLoss: number
  /** ... and the most a landing can cost. */
  readonly landingLossMax: number

  // Contact.
  /** The car's footprint for walls, posts, doors and props: a circle of this radius, metres. */
  readonly radius: number
  /** Height of the car's body, for props above the road, metres. */
  readonly height: number
  /** Share of speed a square wall hit costs (a glancing hit costs in proportion to its angle). */
  readonly wallLoss: number
  /** Share of speed lost per second while the car leans on a wall. Higher makes riding a wall through a corner slower than driving it. */
  readonly wallRub: number
  /** Share of the angle to the wall the car turns along it on a square hit. */
  readonly wallAlign: number
  /** Speed into a wall that sends a `wall` event when the car meets it, m/s ... */
  readonly wallEventFrom: number
  /** ... and the speed into it that sends another while already scraping it. */
  readonly wallEventImpact: number
  /** How far off a wall the car must come before the next touch is a new hit, metres. */
  readonly wallLetGo: number

  // Boost pads.
  /** Extra push while on a pad, m/s^2. */
  readonly boostAccel: number
  /** Speed limit while on a pad, m/s; it falls back to `topSpeed` over `boostFade` after the pad. */
  readonly boostTopSpeed: number
}

/** The shared handling: steering relative to the car, firm grip. */
const base: Handling = {
  steering: "car",
  engineAccel: 15,
  topSpeed: 30,
  rolling: 1.5,
  drag: 0.004,
  brakeDecel: 30,
  reverseSpeed: 7,
  reverseAccel: 8,
  overspeedPull: 1.5,
  steerResponse: 14,
  minTurnRadius: 6.5,
  turnAccel: 40,
  turnDrag: 0.3,
  turnDragBuild: 5,
  grip: 7,
  scrub: 0.2,
  slipFrom: 1.2,
  slipRange: 4,
  aimGain: 3,
  slopeGain: 0.6,
  bankGrip: 1.5,
  bankSlide: 1,
  bankSlideSpeed: 8,
  crestTolerance: 0.08,
  gravity: 24,
  airSteer: 1.2,
  landReach: 0.4,
  landAhead: 70,
  hardLanding: 6,
  landingLoss: 0.03,
  landingLossMax: 0.3,
  radius: 0.75,
  height: 1.1,
  wallLoss: 0.5,
  wallRub: 0.9,
  wallAlign: 0.35,
  wallEventFrom: 0.8,
  wallEventImpact: 4,
  wallLetGo: 0.25,
  boostAccel: 34,
  boostTopSpeed: 36
}

/** The handling variants, in the order the game cycles them. */
export const variantNames = ["car", "car-loose", "screen"] as const
export type VariantName = (typeof variantNames)[number]

export const variants = {
  /** Steering relative to the car, from `DriveInput.steer`. */
  car: base,
  /** The same with half the grip: the car slides wide and slides cost more. */
  "car-loose": { ...base, grip: 3.2, scrub: 0.45, turnAccel: 36 },
  /** The player points where to go (`DriveInput.aim`); the car turns toward it. */
  screen: { ...base, steering: "screen" }
} as const satisfies Record<VariantName, Handling>

export const isVariant = (name: string): name is VariantName => variantNames.some((known) => known === name)
