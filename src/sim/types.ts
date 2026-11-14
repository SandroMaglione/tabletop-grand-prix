/**
 * The contract between the simulation and everything that draws it.
 *
 * Plain data only. The track is static; a `RaceView` is the state after one tick;
 * `RaceEvent`s are what happened during ticks, for effects and sound.
 *
 * Coordinates: right-handed, +Y up, the ground is the XZ plane, units are metres.
 * `yaw` turns around +Y and yaw 0 faces +Z, so forward is `(sin yaw, 0, cos yaw)` and a
 * mesh that faces +Z shows the heading with `rotation.y = yaw`. Left of the direction of
 * travel is `(cos yaw, 0, -sin yaw)`. A positive lateral offset `d` is to the left, and a
 * positive `steer` turns left (yaw grows).
 */

/** One point of the road's centreline. Samples are evenly spaced by `TrackData.spacing`. */
export interface TrackSample {
  /** Distance along the centreline from the start line, in metres. */
  readonly s: number
  /** Centre of the road surface. */
  readonly x: number
  readonly y: number
  readonly z: number
  /** Direction of travel. */
  readonly yaw: number
  /** Slope along the direction of travel, radians, positive when climbing. */
  readonly pitch: number
  /** Sideways tilt, radians: the surface height at lateral offset `d` is `y + d * tan(bank)`, so a positive bank lifts the left edge. */
  readonly bank: number
  /** Half the drivable width. */
  readonly halfWidth: number
  /** False inside a jump gap: there is no road here and nothing to land on. */
  readonly surface: boolean
  /** A wall stands on this edge. Walls are missing only where the design wants a way out (a jump gap has neither). */
  readonly wallLeft: boolean
  readonly wallRight: boolean
  /**
   * What holds the road up, for the picture:
   * - `ground`: carved into the terrain, the road is the bottom of a channel.
   * - `solid`: a solid mass from the terrain up to the road (ramps, embankments).
   * - `bridge`: a deck with open space under it, because another part of the track passes below.
   * - `none`: a jump gap.
   */
  readonly support: "ground" | "solid" | "bridge" | "none"
}

/** The loose things on the road. */
export type PropKind = "crate" | "barrel" | "cone" | "ball"

/**
 * A loose thing standing on the road. The car shoves it, it slides, spins and knocks into
 * walls and other props, and it stays where it comes to rest until the attempt starts again.
 * Nothing breaks.
 *
 * For collisions every prop is an upright cylinder of `radius` and `height`. How it looks
 * follows from its kind: a crate is a cube with `height` as its edge, a barrel and a cone
 * are as wide as `radius`, a ball is a sphere of `radius` (`height` is twice that).
 */
export interface PropPlacement {
  readonly kind: PropKind
  /** Centre of its base, where it stands before an attempt: on the road, or on the crate under it. */
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yaw: number
  readonly radius: number
  readonly height: number
}

/** A post fixed in the road. The car and the props bounce off it; it never moves. */
export interface Bollard {
  /** Centre of its base on the road surface. */
  readonly x: number
  readonly y: number
  readonly z: number
  readonly radius: number
  readonly height: number
}

/**
 * One leaf of a swing door across the road, hinged at one end. The car pushes it open and
 * it stays where it stops: hitting it near its free end costs little, near the hinge it is
 * almost a wall.
 */
export interface SwingDoor {
  /** The hinge, on the road surface. */
  readonly x: number
  readonly y: number
  readonly z: number
  /** The direction the closed leaf points from the hinge (like every yaw: `(sin yaw, 0, cos yaw)`). */
  readonly yaw: number
  readonly length: number
  readonly height: number
  readonly thickness: number
  /** The furthest it swings either way from closed, radians. */
  readonly maxAngle: number
}

/** A strip of road that pushes the car forward while it is on it. */
export interface BoostPad {
  /** Centre of the pad on the road surface. */
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yaw: number
  readonly pitch: number
  readonly length: number
  readonly width: number
  /** Centreline distance of the pad's centre. */
  readonly s: number
}

/** A named stretch of track, for the picture and the HUD (never for rules). */
export interface TrackFeature {
  readonly kind: "jump" | "spiral" | "banked" | "bridge" | "boost" | "crates" | "slalom" | "balls" | "doors"
  readonly sFrom: number
  readonly sTo: number
}

export interface TrackData {
  readonly name: string
  /** Samples in order of travel; the last connects back to the first. */
  readonly samples: ReadonlyArray<TrackSample>
  /** Metres between consecutive samples. */
  readonly spacing: number
  /** Length of one lap along the centreline. */
  readonly length: number
  /** Height of the walls above the road surface. The terrain's top is at this height where the road is at y = 0. */
  readonly wallHeight: number
  /**
   * Centreline distances of the lines a lap must cross, in order. The first is the
   * start/finish line at `s = 0`; the rest end sectors one, two, ... A lap counts only
   * when every line was crossed in order.
   */
  readonly checkpoints: ReadonlyArray<number>
  /** Where the car stands before an attempt: just behind the start line, on the road. */
  readonly start: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number }
  readonly boosts: ReadonlyArray<BoostPad>
  readonly props: ReadonlyArray<PropPlacement>
  readonly bollards: ReadonlyArray<Bollard>
  readonly doors: ReadonlyArray<SwingDoor>
  readonly features: ReadonlyArray<TrackFeature>
  /** The box that holds every sample, walls included, for fitting the camera and the terrain. */
  readonly bounds: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number; readonly maxY: number }
  /** Lap times to beat, in milliseconds, slowest first. */
  readonly medals: { readonly bronze: number; readonly silver: number; readonly gold: number }
}

/** What the player asks of the car for one tick. */
export interface DriveInput {
  /** 0 to 1. */
  readonly throttle: number
  /** 0 to 1. Brakes, then reverses once the car has stopped. */
  readonly brake: number
  /** -1 (right) to 1 (left). Used by the car-relative steering variant. */
  readonly steer: number
  /**
   * A direction on the ground the player points at, or null. Used by the screen-relative
   * steering variant: the car turns toward it. Need not be normalized.
   */
  readonly aim: { readonly x: number; readonly z: number } | null
  /** Start the attempt again from the start line. Read on the tick it turns true. */
  readonly restart: boolean
}

export interface CarView {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yaw: number
  /** Nose up is positive. */
  readonly pitch: number
  /** Left side up is positive. */
  readonly roll: number
  /** World velocity, metres per second. */
  readonly vx: number
  readonly vy: number
  readonly vz: number
  /** Signed speed along the car's heading, metres per second. */
  readonly speed: number
  /** Front wheel angle as a fraction of full lock, -1 (right) to 1 (left). */
  readonly steer: number
  /** How hard the car is sliding sideways, 0 to 1. Skid marks and tyre smoke read this. */
  readonly slip: number
  readonly throttle: number
  readonly brake: number
  /** False while in the air. */
  readonly grounded: boolean
  readonly boosting: boolean
  /** Centreline distance of the car, in metres. */
  readonly s: number
}

export interface LapView {
  /**
   * - `ready`: on the start line, the clock has not started.
   * - `running`: the clock runs.
   * - `finished`: the lap is done and the clock holds its time until the next attempt.
   */
  readonly phase: "ready" | "running" | "finished"
  /** Counts attempts from 1. It changes on every restart and reset, so the host knows when to cut a recording. */
  readonly attempt: number
  /** Time of the attempt in milliseconds. Whole ticks while running; exact to the finish line crossing once finished. */
  readonly timeMs: number
  /** Time at each checkpoint crossed in this attempt, in order (the finish line is the last). */
  readonly splitsMs: ReadonlyArray<number>
  /** Index into `TrackData.checkpoints` of the next line to cross. */
  readonly nextCheckpoint: number
}

export interface RaceView {
  /** Ticks since the session began. */
  readonly tick: number
  readonly car: CarView
  readonly lap: LapView
  /** One entry per `TrackData.props`, in the same order. */
  readonly props: ReadonlyArray<PropView>
  /** One entry per `TrackData.doors`: how far the leaf has turned from closed, radians. Positive turns it left (its yaw grows). */
  readonly doors: ReadonlyArray<number>
}

/** Where a prop is now. */
export interface PropView {
  /** Centre of its base. `y` is above the road while it falls off a stack. */
  readonly x: number
  readonly y: number
  readonly z: number
  /** Turn around the vertical. The simulation spins a prop when it is hit off-centre. */
  readonly yaw: number
  /** World velocity, metres per second: all zero once it rests. A ball rolls by it, a crate tumbles by it. */
  readonly vx: number
  readonly vy: number
  readonly vz: number
}

/** Something that happened during a tick. Positions are where it happened. */
export type RaceEvent =
  | { readonly kind: "start" }
  | { readonly kind: "checkpoint"; readonly index: number; readonly timeMs: number }
  | { readonly kind: "finish"; readonly timeMs: number; readonly splitsMs: ReadonlyArray<number> }
  | { readonly kind: "reset"; readonly reason: "off-track" | "manual"; readonly x: number; readonly y: number; readonly z: number }
  | { readonly kind: "wall"; readonly side: "left" | "right"; readonly impact: number; readonly x: number; readonly y: number; readonly z: number }
  | { readonly kind: "takeoff"; readonly speed: number; readonly x: number; readonly y: number; readonly z: number }
  | { readonly kind: "land"; readonly impact: number; readonly x: number; readonly y: number; readonly z: number }
  | { readonly kind: "boost"; readonly index: number }
  /** The car hit a prop. `impact` is the speed they closed at, m/s. */
  | { readonly kind: "prop"; readonly index: number; readonly prop: PropKind; readonly impact: number; readonly x: number; readonly y: number; readonly z: number }
  /** A prop hit a wall, a bollard, the road (falling off a stack) or another prop, hard enough to hear. */
  | { readonly kind: "knock"; readonly index: number; readonly prop: PropKind; readonly impact: number; readonly x: number; readonly y: number; readonly z: number }
  /** The car hit a bollard. */
  | { readonly kind: "bollard"; readonly index: number; readonly impact: number; readonly x: number; readonly y: number; readonly z: number }
  /** The car hit a door leaf. */
  | { readonly kind: "door"; readonly index: number; readonly impact: number; readonly x: number; readonly y: number; readonly z: number }

/**
 * One race, as the page drives it. The simulation runs behind this: the page sends an
 * input per tick and reads plain data back.
 */
export interface RaceSession {
  readonly track: TrackData
  /** Ticks per second of the simulation. */
  readonly hz: number
  /** Advance one tick with this input. Throws if the simulation fails. */
  tick(input: DriveInput): void
  /** The state after the last tick. */
  view(): RaceView
  /** Every event since the last call, oldest first. */
  drainEvents(): ReadonlyArray<RaceEvent>
  /** The ways to steer (`STEERINGS` in `schema.ts`): by the wheel, or by pointing where to go. */
  readonly variants: ReadonlyArray<string>
  /** The variant in use. */
  variant(): string
  /** Switch variant. Takes effect on the next tick. */
  setVariant(name: string): void
}

export const idleInput: DriveInput = { throttle: 0, brake: 0, steer: 0, aim: null, restart: false }
