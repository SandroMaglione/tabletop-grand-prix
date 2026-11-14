/**
 * The race as a ritmo game: what the world holds, the systems that change it each tick, and
 * the inspectors the session reads it through.
 *
 * One tick of `update`, in order:
 * 1. the clock advances;
 * 2. `ReadInput` takes the `DriveInput` the session sent and the variant in use;
 * 3. `Boost` finds the pad under the car and the speed limit;
 * 4. `Drive` moves the car (road, air, walls) and asks for a reset when it is off the track;
 * 5. `Obstacles` moves the props and the doors, and knocks the car against them and the posts;
 * 6. `Lap` starts the clock and counts the lines crossed;
 * 7. `Reset` puts everything back on the line when a restart or a reset was asked for;
 * 8. `Collect` keeps this tick's events in `Outbox` for the session.
 */
import { Clock, Descriptor, Ops, Schema } from "@typeonce/ritmo"
import type { Debug } from "@typeonce/ritmo"
import { carAt, driveCar, keepInside } from "./car.ts"
import type { CarState, CarWork } from "./car.ts"
import { restingObstacles, stepObstacles } from "./obstacles.ts"
import type { ObstacleState } from "./obstacles.ts"
import { locateBelow } from "./track/query.ts"
import { boostFade, isVariant, step, variants } from "./tuning.ts"
import type { VariantName } from "./tuning.ts"
import type { CarView, DriveInput, RaceEvent, RaceView, TrackData } from "./types.ts"

// ── What the world holds ───────────────────────────────────────────────

/** The track and what is worked out from it once: where the car starts and how the obstacles stand. */
export interface Course {
  readonly track: TrackData
  /** The car on the start line. */
  readonly startCar: CarState
  /** Every prop and door as an attempt begins. */
  readonly rest: ObstacleState
}

/** The input for this tick, as the systems read it. */
export interface Controls {
  readonly throttle: number
  readonly brake: number
  readonly steer: number
  readonly aim: { readonly x: number; readonly z: number } | null
  /** `DriveInput.restart` as last sent, to see the tick it turns true. */
  readonly restartHeld: boolean
}

/** The attempt: before the clock starts, while it runs, and once the lap is done. */
export type LapState =
  | { readonly _tag: "ready"; readonly attempt: number }
  | {
      readonly _tag: "running"
      readonly attempt: number
      /** The clock reads zero at this step. */
      readonly startStep: number
      /** Index into `TrackData.checkpoints` of the next line to cross. */
      readonly next: number
      readonly splitsMs: ReadonlyArray<number>
    }
  | {
      readonly _tag: "finished"
      readonly attempt: number
      readonly startStep: number
      readonly timeMs: number
      readonly splitsMs: ReadonlyArray<number>
    }

export const Time = Clock.resource("Race/Time", step)
export const Input = Descriptor.Resource<Controls>()("Race/Input")
export const Variant = Descriptor.Resource<VariantName>()("Race/Variant")
export const Car = Descriptor.Resource<CarState>()("Race/Car")
export const Lap = Descriptor.Resource<LapState>()("Race/Lap")
/** The props, the doors and the post the car touches. */
export const Obstacles = Descriptor.Resource<ObstacleState>()("Race/Obstacles")
/** What happened during the last tick, for the session to collect. */
export const Outbox = Descriptor.Resource<ReadonlyArray<RaceEvent>>()("Race/Outbox")
export const CourseService = Descriptor.Service<Course>()("Race/Course")

/** What the session sends each tick: the player's input and the variant in use. */
export const Drive = Descriptor.Event<{ readonly input: DriveInput; readonly variant: VariantName }>()("Race/Drive")
/** Everything the page hears about, collected by the session for `drainEvents`. */
export const Happened = Descriptor.Event<RaceEvent>()("Race/Happened")
/** A request to start the attempt again, handled at the end of the tick. */
export const ResetRequest = Descriptor.Event<{ readonly reason: "off-track" | "manual" }>()("Race/ResetRequest")

export const Root = Schema.defineRoot("Race")
export const Game = Schema.bind(
  Schema.fragment({
    resources: { Time, Input, Variant, Car, Lap, Obstacles, Outbox },
    events: { Drive, Happened, ResetRequest }
  }),
  Root
)

// ── Rules shared by systems and inspectors ─────────────────────────────

const msOf = (ticks: number): number => (ticks * 1000) / step.hz

/** The speed limit now: raised on a pad, falling back over `boostFade` after it. */
const speedLimit = (car: CarState, variant: VariantName, now: number): number => {
  const handling = variants[variant]
  if (car.pad >= 0) return handling.boostTopSpeed
  if (car.boostUntil === null || now >= car.boostUntil) return handling.topSpeed
  const left = (car.boostUntil - now) / Clock.steps(boostFade)
  return handling.topSpeed + (handling.boostTopSpeed - handling.topSpeed) * left
}

// ── Systems ────────────────────────────────────────────────────────────

const AdvanceTime = Clock.system(Game, { name: "Race/AdvanceTime", resource: Time })

const ReadInput = Game.System(
  "Race/ReadInput",
  {
    events: { drive: Game.System.readEvent(Drive), reset: Game.System.writeEvent(ResetRequest) },
    resources: { input: Game.System.writeResource(Input), variant: Game.System.writeResource(Variant) }
  },
  ({ events, resources }) => {
    const sent = events.drive.all()
    const last = sent[sent.length - 1]
    const held = resources.input.get().restartHeld
    if (last === undefined) return
    const { input } = last
    resources.input.set({ throttle: input.throttle, brake: input.brake, steer: input.steer, aim: input.aim, restartHeld: input.restart })
    resources.variant.set(last.variant)
    if (input.restart && !held) events.reset.emit({ reason: "manual" })
  }
)

const Boost = Game.System(
  "Race/Boost",
  {
    resources: { time: Game.System.readResource(Time), car: Game.System.writeResource(Car) },
    services: { course: Game.System.service(CourseService) },
    events: { happened: Game.System.writeEvent(Happened) }
  },
  ({ resources, services, events }) => {
    const car = resources.car.get()
    const { boosts } = services.course.track
    let pad = -1
    if (car.grounded) {
      for (let index = 0; index < boosts.length; index++) {
        const boost = boosts[index]
        if (boost === undefined) continue
        const px = car.x - boost.x
        const pz = car.z - boost.z
        const fx = Ops.sin(boost.yaw)
        const fz = Ops.cos(boost.yaw)
        const ahead = px * fx + pz * fz
        const across = px * fz - pz * fx
        if (Math.abs(ahead) <= boost.length / 2 && Math.abs(across) <= boost.width / 2 && Math.abs(car.y - boost.y) < 1.5) pad = index
      }
    }
    if (pad === car.pad) return
    if (pad >= 0) events.happened.emit({ kind: "boost", index: pad })
    // Leaving a pad starts the fall back to the normal speed limit.
    resources.car.set({ ...car, pad, boostUntil: pad >= 0 ? null : Clock.deadline(resources.time.get(), boostFade) })
  }
)

const DriveCar = Game.System(
  "Race/Drive",
  {
    resources: {
      time: Game.System.readResource(Time),
      input: Game.System.readResource(Input),
      variant: Game.System.readResource(Variant),
      lap: Game.System.readResource(Lap),
      car: Game.System.writeResource(Car)
    },
    services: { course: Game.System.service(CourseService) },
    events: { happened: Game.System.writeEvent(Happened), reset: Game.System.writeEvent(ResetRequest) }
  },
  ({ resources, services, events }) => {
    const time = resources.time.get()
    const lap = resources.lap.get()
    const variant = resources.variant.get()
    const { track } = services.course
    const car: CarWork = { ...resources.car.get() }
    const outcome = driveCar(car, resources.input.get(), {
      track,
      handling: variants[variant],
      dt: time.dt,
      limit: speedLimit(car, variant, time.step),
      onPad: car.pad >= 0,
      ready: lap._tag === "ready",
      emit: (event) => events.happened.emit(event)
    })
    resources.car.set(car)
    if (outcome === "off-track") events.reset.emit({ reason: "off-track" })
  }
)

const MoveObstacles = Game.System(
  "Race/Obstacles",
  {
    resources: {
      time: Game.System.readResource(Time),
      variant: Game.System.readResource(Variant),
      car: Game.System.writeResource(Car),
      obstacles: Game.System.writeResource(Obstacles)
    },
    services: { course: Game.System.service(CourseService) },
    events: { happened: Game.System.writeEvent(Happened) }
  },
  ({ resources, services, events }) => {
    const before = resources.car.get()
    const car: CarWork = { ...before }
    const state = resources.obstacles.get()
    const next = stepObstacles(car, state, {
      track: services.course.track,
      handling: variants[resources.variant.get()],
      dt: resources.time.get().dt,
      emit: (event) => events.happened.emit(event)
    })
    if (next !== state) resources.obstacles.set(next)
    if (car.x === before.x && car.z === before.z && car.vx === before.vx && car.vz === before.vz) return
    if (car.x !== before.x || car.z !== before.z) keepInside(car, services.course.track, variants[resources.variant.get()])
    resources.car.set(car)
  }
)

const CountLap = Game.System(
  "Race/Lap",
  {
    resources: {
      time: Game.System.readResource(Time),
      input: Game.System.readResource(Input),
      car: Game.System.readResource(Car),
      lap: Game.System.writeResource(Lap)
    },
    services: { course: Game.System.service(CourseService) },
    events: { happened: Game.System.writeEvent(Happened) }
  },
  ({ resources, services, events }) => {
    const { track } = services.course
    const now = resources.time.get().step
    const lap = resources.lap.get()
    if (lap._tag === "ready") {
      if (resources.input.get().throttle <= 0) return
      // The car moved during this tick, so the clock covers it.
      resources.lap.set({ _tag: "running", attempt: lap.attempt, startStep: now - 1, next: track.checkpoints.length > 1 ? 1 : 0, splitsMs: [] })
      events.happened.emit({ kind: "start" })
      return
    }
    if (lap._tag !== "running") return
    const car = resources.car.get()
    const line = track.checkpoints[lap.next]
    if (line === undefined) return
    // Distance moved along the lap this tick, the short way round; backwards never counts.
    let moved = (car.s - car.prevS) % track.length
    if (moved > track.length / 2) moved -= track.length
    if (moved < -track.length / 2) moved += track.length
    if (moved <= 0 || moved > 20) return
    const toLine = (((line - car.prevS) % track.length) + track.length) % track.length
    if (toLine <= 0 || toLine > moved) return
    // Exact to the crossing inside the tick.
    const timeMs = msOf(now - 1 - lap.startStep + toLine / moved)
    const splitsMs = [...lap.splitsMs, timeMs]
    if (lap.next === 0) {
      resources.lap.set({ _tag: "finished", attempt: lap.attempt, startStep: lap.startStep, timeMs, splitsMs })
      events.happened.emit({ kind: "finish", timeMs, splitsMs })
      return
    }
    resources.lap.set({ _tag: "running", attempt: lap.attempt, startStep: lap.startStep, next: (lap.next + 1) % track.checkpoints.length, splitsMs })
    events.happened.emit({ kind: "checkpoint", index: lap.next, timeMs })
  }
)

const Reset = Game.System(
  "Race/Reset",
  {
    events: { reset: Game.System.readEvent(ResetRequest), happened: Game.System.writeEvent(Happened) },
    resources: { car: Game.System.writeResource(Car), lap: Game.System.writeResource(Lap), obstacles: Game.System.writeResource(Obstacles) },
    services: { course: Game.System.service(CourseService) }
  },
  ({ events, resources, services }) => {
    const request = events.reset.all()[0]
    if (request === undefined) return
    const car = resources.car.get()
    events.happened.emit({ kind: "reset", reason: request.reason, x: car.x, y: car.y, z: car.z })
    resources.car.set(services.course.startCar)
    resources.lap.set({ _tag: "ready", attempt: resources.lap.get().attempt + 1 })
    if (resources.obstacles.get() !== services.course.rest) resources.obstacles.set(services.course.rest)
  }
)

const Collect = Game.System(
  "Race/Collect",
  { events: { happened: Game.System.readEvent(Happened) }, resources: { outbox: Game.System.writeResource(Outbox) } },
  ({ events, resources }) => {
    const happened = events.happened.all()
    if (happened.length > 0 || resources.outbox.get().length > 0) resources.outbox.set(happened)
  }
)

export const update = Game.Schedule(AdvanceTime, ReadInput, Boost, DriveCar, MoveObstacles, CountLap, Reset, Collect)

// ── What the session reads ─────────────────────────────────────────────

export const ReadView = Game.Inspector(
  "Race/ReadView",
  {
    resources: {
      time: Game.System.readResource(Time),
      car: Game.System.readResource(Car),
      lap: Game.System.readResource(Lap),
      obstacles: Game.System.readResource(Obstacles),
      variant: Game.System.readResource(Variant)
    },
    services: { course: Game.System.service(CourseService) }
  },
  ({ resources, services }): RaceView => {
    const now = resources.time.get().step
    const car = resources.car.get()
    const lap = resources.lap.get()
    const fx = Ops.sin(car.yaw)
    const fz = Ops.cos(car.yaw)
    const limit = speedLimit(car, resources.variant.get(), now)
    const carView: CarView = {
      x: car.x,
      y: car.y,
      z: car.z,
      yaw: car.yaw,
      pitch: car.pitch,
      roll: car.roll,
      vx: car.vx,
      vy: car.vy,
      vz: car.vz,
      speed: car.vx * fx + car.vz * fz,
      steer: car.steer,
      slip: car.slip,
      throttle: car.throttle,
      brake: car.brake,
      grounded: car.grounded,
      boosting: limit > variants[resources.variant.get()].topSpeed,
      s: car.s
    }
    const ticks = lap._tag === "ready" ? 0 : now - lap.startStep
    const { track } = services.course
    const obstacles = resources.obstacles.get()
    return {
      tick: now,
      car: carView,
      lap: {
        phase: lap._tag,
        attempt: lap.attempt,
        timeMs: lap._tag === "finished" ? lap.timeMs : msOf(ticks),
        splitsMs: lap._tag === "ready" ? [] : lap.splitsMs,
        nextCheckpoint: lap._tag === "running" ? lap.next : lap._tag === "ready" ? Math.min(1, track.checkpoints.length - 1) : 0
      },
      props: obstacles.props.map((prop) => ({ x: prop.x, y: prop.roadY + prop.lift, z: prop.z, yaw: prop.yaw, vx: prop.vx, vy: prop.vlift, vz: prop.vz })),
      doors: obstacles.doors.map((door) => door.angle)
    }
  }
)

export const ReadOutbox = Game.Inspector("Race/ReadOutbox", { resources: { outbox: Game.System.readResource(Outbox) } }, ({ resources }) =>
  resources.outbox.get()
)

// ── Making a runtime ───────────────────────────────────────────────────

/** The course for a track: the start and the obstacles at rest, worked out once. Throws when the start is not on the road. */
export const courseOf = (track: TrackData): Course => {
  const { start } = track
  const hit = locateBelow(track, start.x, start.y + 0.5, start.z, 0, 1)
  if (hit === null) throw new Error(`The start of ${track.name} is not on the road`)
  return { track, startCar: carAt(start.x, start.z, start.yaw, hit), rest: restingObstacles(track) }
}

const build = <const Enabled extends Debug.Option | undefined>(track: TrackData, variant: string, debug: Enabled) => {
  if (!isVariant(variant)) throw new Error(`No handling variant named ${variant}`)
  const course = courseOf(track)
  const made = Game.Runtime.make({
    services: Game.Runtime.services(Game.Runtime.service(CourseService, course)),
    resources: {
      Time: Clock.start(step),
      Input: { throttle: 0, brake: 0, steer: 0, aim: null, restartHeld: false },
      Variant: variant,
      Car: course.startCar,
      Lap: { _tag: "ready", attempt: 1 },
      Obstacles: course.rest,
      Outbox: []
    },
    debug
  })
  if (!made.ok) throw new Error(`The race could not start: ${JSON.stringify(made.error)}`)
  return made.value
}

/** A runtime for `track` with the named variant. Throws on an unknown variant or a start off the road. */
export const makeRuntime = (track: TrackData, variant: string) => build(track, variant, undefined)

/** The same with a devtools debug handle, for `ritmo-devtools lint`. */
export const makeDebugRuntime = (track: TrackData, variant: string, debug: Debug.Option) => build(track, variant, debug)
