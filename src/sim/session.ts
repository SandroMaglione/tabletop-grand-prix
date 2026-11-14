/**
 * `createSession`: the race behind the `RaceSession` contract.
 *
 * Each `tick(input)` sends the input to the runtime as a `Race/Drive` event, runs the
 * `update` schedule once, and collects the tick's `Race/Outbox` for `drainEvents`. `view()` runs the
 * `Race/ReadView` inspector. All race state lives in the runtime; the session holds only
 * host-side things: the pending events and the variant the page asked for.
 */
import { Drive, ReadOutbox, ReadView, makeRuntime, update } from "./game.ts"
import { isVariant, step, variantNames } from "./tuning.ts"
import type { VariantName } from "./tuning.ts"
import type { DriveInput, RaceEvent, RaceSession, RaceView, TrackData } from "./types.ts"

export const createSession = (track: TrackData, variant: VariantName = "car"): RaceSession => {
  const runtime = makeRuntime(track, variant)
  let chosen: VariantName = variant
  let pending: Array<RaceEvent> = []
  return {
    track,
    hz: step.hz,
    tick(input: DriveInput) {
      runtime.send(Drive, { input, variant: chosen })
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
    variants: variantNames,
    variant: () => chosen,
    setVariant(name: string) {
      if (!isVariant(name)) throw new Error(`No handling variant named ${name}; the variants are ${variantNames.join(", ")}`)
      chosen = name
    }
  }
}
