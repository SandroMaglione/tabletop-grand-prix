/** Moves the car (road, air, walls) and asks for a reset when it is off the track. */
import { driveCar } from "../car.ts"
import type { CarWork } from "../car.ts"
import { Car, CourseService, Game, Happened, HandlingValues, Input, Lap, ResetRequest, SteeringMode, Time } from "../state.ts"
import { speedLimit } from "./boost.ts"

export const DriveCar = Game.System(
  "Race/Drive",
  {
    resources: {
      time: Game.System.readResource(Time),
      input: Game.System.readResource(Input),
      steering: Game.System.readResource(SteeringMode),
      handling: Game.System.readResource(HandlingValues),
      lap: Game.System.readResource(Lap),
      car: Game.System.writeResource(Car)
    },
    services: { course: Game.System.service(CourseService) },
    events: { happened: Game.System.writeEvent(Happened), reset: Game.System.writeEvent(ResetRequest) }
  },
  ({ resources, services, events }) => {
    const time = resources.time.get()
    const handling = resources.handling.get()
    const car: CarWork = { ...resources.car.get() }
    const outcome = driveCar(car, resources.input.get(), {
      track: services.course.track,
      handling,
      steering: resources.steering.get(),
      dt: time.dt,
      limit: speedLimit(car.boost, handling, time),
      onPad: car.boost._tag === "pad",
      ready: resources.lap.get()._tag === "ready",
      emit: (event) => events.happened.emit(event)
    })
    resources.car.set(car)
    if (outcome === "off-track") events.reset.emit({ reason: "off-track" })
  }
)
