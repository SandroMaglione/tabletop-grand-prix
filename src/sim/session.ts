/**
 * `createSession`: the race behind the `RaceSession` contract.
 *
 * Each `tick(input)` hands the input to the runtime through its input source, runs the
 * `update` schedule once, and collects the tick's `Race/Outbox` for `drainEvents`. `view()`
 * runs the `Race/ReadView` inspector. All race state lives in the runtime; the session
 * holds only host-side things: the input about to be read, the pending events and the
 * steering the page asked for.
 */
import { ReadOutbox, ReadView, idleIntent, makeRuntime, update } from "./game.ts"
import { STEERINGS, isSteering } from "./schema.ts"
import type { Steering } from "./schema.ts"
import { step } from "./tuning.ts"
import type { DriveInput, RaceEvent, RaceSession, RaceView, TrackData } from "./types.ts"

export const createSession = (track: TrackData, steering: Steering = "car"): RaceSession => {
  let chosen: Steering = steering
  let asked = idleIntent(chosen)
  const runtime = makeRuntime(track, steering, { snapshot: () => asked })
  let pending: Array<RaceEvent> = []
  return {
    track,
    hz: step.hz,
    tick(input: DriveInput) {
      asked = { input, steering: chosen }
      const result = runtime.tick(update)
      if (!result.ok) throw new Error(`The race failed: ${JSON.stringify(result.error)}`)
      for (const event of runtime.inspect(ReadOutbox)) pending.push(event)
    },
    view(): RaceView {
      return runtime.inspect(ReadView)
    },
    drainEvents() {
      const drained = pending
      pending = []
      return drained
    },
    variants: STEERINGS,
    variant: () => chosen,
    setVariant(name: string) {
      if (!isSteering(name)) throw new Error(`No steering named ${name}; they are ${STEERINGS.join(", ")}`)
      chosen = name
    }
  }
}
