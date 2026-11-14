/** Takes the player's input for this tick from the host, and asks for a reset on the tick `restart` turns true. */
import { DriveSource, Game, Input, ResetRequest, SteeringMode } from "../state.ts"

export const ReadInput = Game.System(
  "Race/ReadInput",
  {
    services: { drive: Game.System.consumeService(DriveSource) },
    events: { reset: Game.System.writeEvent(ResetRequest) },
    resources: { input: Game.System.writeResource(Input), steering: Game.System.writeResource(SteeringMode) }
  },
  ({ services, events, resources }) => {
    const { input, steering } = services.drive.snapshot()
    const held = resources.input.get().restartHeld
    resources.input.set({ throttle: input.throttle, brake: input.brake, steer: input.steer, aim: input.aim, restartHeld: input.restart })
    if (resources.steering.get() !== steering) resources.steering.set(steering)
    if (input.restart && !held) events.reset.emit({ reason: "manual" })
  }
)
