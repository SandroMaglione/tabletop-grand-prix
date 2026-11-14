/** Finds the boost pad under the car: on one the speed limit is raised, and leaving it starts the fall back. */
import { Clock, Ops } from "@typeonce/ritmo"
import type { Boost, CarState } from "../schema.ts"
import { Car, CourseService, Game, Happened, Time } from "../state.ts"
import { boostFade } from "../tuning.ts"
import type { Handling } from "../tuning.ts"

/** The speed limit now: raised on a pad, falling back over `boostFade` after it. */
export const speedLimit = (boost: Boost, handling: Handling, time: Clock.Time): number => {
  if (boost._tag === "pad") return handling.boostTopSpeed
  if (boost._tag === "off" || Clock.reached(time, boost.until)) return handling.topSpeed
  const left = Clock.remaining(time, boost.until) / Clock.steps(boostFade)
  return handling.topSpeed + (handling.boostTopSpeed - handling.topSpeed) * left
}

const padOf = (car: CarState): number => (car.boost._tag === "pad" ? car.boost.index : -1)

export const FindBoost = Game.System(
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
    if (car.motion._tag === "road") {
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
    const was = padOf(car)
    if (pad === was) return
    if (pad >= 0) {
      events.happened.emit({ kind: "boost", index: pad })
      resources.car.set({ ...car, boost: { _tag: "pad", index: pad } })
      return
    }
    // Leaving a pad starts the fall back to the normal speed limit.
    resources.car.set({ ...car, boost: { _tag: "fading", until: Clock.deadline(resources.time.get(), boostFade) } })
  }
)
