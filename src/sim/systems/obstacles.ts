/** Moves the props and the doors, and knocks the car against them and the posts. */
import { keepInside } from "../car.ts"
import type { CarWork } from "../car.ts"
import { stepObstacles } from "../obstacles.ts"
import { Car, ContactValues, CourseService, Game, Happened, HandlingValues, Obstacles, Time } from "../state.ts"

export const MoveObstacles = Game.System(
  "Race/Obstacles",
  {
    resources: {
      time: Game.System.readResource(Time),
      handling: Game.System.readResource(HandlingValues),
      contact: Game.System.readResource(ContactValues),
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
    const handling = resources.handling.get()
    const next = stepObstacles(car, state, {
      track: services.course.track,
      handling,
      contact: resources.contact.get(),
      dt: resources.time.get().dt,
      emit: (event) => events.happened.emit(event)
    })
    if (next !== state) resources.obstacles.set(next)
    if (car.x === before.x && car.z === before.z && car.vx === before.vx && car.vz === before.vz) return
    if (car.x !== before.x || car.z !== before.z) keepInside(car, services.course.track, handling)
    resources.car.set(car)
  }
)
