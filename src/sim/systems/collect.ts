/** Keeps this tick's events in `Outbox` for the session. */
import { Game, Happened, Outbox } from "../state.ts"

export const Collect = Game.System(
  "Race/Collect",
  { events: { happened: Game.System.readEvent(Happened) }, resources: { outbox: Game.System.writeResource(Outbox) } },
  ({ events, resources }) => {
    const happened = events.happened.all()
    if (happened.length > 0 || resources.outbox.get().length > 0) resources.outbox.set(happened)
  }
)
