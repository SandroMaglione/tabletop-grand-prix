/** Puts everything back on the line when a restart or a reset was asked for this tick. */
import { Car, CourseService, Game, Happened, Lap, Obstacles, ResetRequest } from "../state.ts"

export const Reset = Game.System(
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
