/** Starts the clock when the car is first asked to move, and counts the lines crossed, in order, to the finish. */
import { CourseService, Car, Game, Happened, Input, Lap, Time } from "../state.ts"
import { step } from "../tuning.ts"

export const msOf = (ticks: number): number => (ticks * 1000) / step.hz

export const CountLap = Game.System(
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
