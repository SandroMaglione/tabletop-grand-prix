/** What the session reads from the world: the race as plain data for the page, and this tick's events. */
import { Ops } from "@typeonce/ritmo"
import { Car, CourseService, Game, HandlingValues, Lap, Obstacles, Outbox, Time } from "./state.ts"
import { speedLimit } from "./systems/boost.ts"
import { msOf } from "./systems/lap.ts"
import { locateNear, surfaceAt } from "./track/query.ts"
import type { CarView, RaceView } from "./types.ts"

export const ReadView = Game.Inspector(
  "Race/ReadView",
  {
    resources: {
      time: Game.System.readResource(Time),
      car: Game.System.readResource(Car),
      lap: Game.System.readResource(Lap),
      obstacles: Game.System.readResource(Obstacles),
      handling: Game.System.readResource(HandlingValues)
    },
    services: { course: Game.System.service(CourseService) }
  },
  ({ resources, services }): RaceView => {
    const time = resources.time.get()
    const now = time.step
    const car = resources.car.get()
    const lap = resources.lap.get()
    const handling = resources.handling.get()
    const fx = Ops.sin(car.yaw)
    const fz = Ops.cos(car.yaw)
    const { track } = services.course
    const grounded = car.motion._tag === "road"
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
      grounded,
      boosting: speedLimit(car.boost, handling, time) > handling.topSpeed,
      s: car.s,
      surface: (grounded ? surfaceAt(track, car.s, locateNear(track, car.x, car.z, car.hint).d) : null) ?? "road"
    }
    const ticks = lap._tag === "ready" ? 0 : now - lap.startStep
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

export const ReadOutbox = Game.Inspector("Race/ReadOutbox", { resources: { outbox: Game.System.readResource(Outbox) } }, ({ resources }) => resources.outbox.get())
