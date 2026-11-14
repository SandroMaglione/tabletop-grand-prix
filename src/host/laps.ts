/**
 * The attempt as it is driven, and the best lap the device keeps.
 *
 * Every tick's input (already through `quantise`) goes to a recorder, cleared whenever the
 * attempt starts again. On the finish the recorder gives the lap as a replay. A lap that
 * beats the best becomes the best: its replay, time, splits and steering.
 *
 * It is fed once per simulation tick (`afterTick`), so the replay holds exactly the ticks the
 * simulation ran, whatever the frame rate.
 */
import { createRecorder, replayToText, type DriveInput, type RaceEvent, type RaceView, type Steering } from "../sim/index.ts"
import type { BestRun } from "./boards.ts"

/** The last finished lap, for the result panel and the leaderboard. */
export interface FinishResult {
  readonly attempt: number
  readonly timeMs: number
  readonly splitsMs: ReadonlyArray<number>
  /** The best lap before this one, or null when this was the first. */
  readonly previous: BestRun | null
  /** It beat the best lap (and could be kept: it fit in a replay). */
  readonly improved: boolean
  /** The lap as a replay, as text; null when it was too long to keep. */
  readonly replay: string | null
  readonly steering: Steering
}

export interface Laps {
  /** After every simulation tick, with the input the simulation was given and the tick's events. Returns the finish when the lap ended on this tick. */
  afterTick(input: DriveInput, view: RaceView, events: ReadonlyArray<RaceEvent>): FinishResult | null
  /** Whether the attempt so far holds any input: changing the steering then must start it again. */
  recording(): boolean
  best(): BestRun | null
  lastFinish(): FinishResult | null
}

export const createLaps = (trackId: string, best: BestRun | null, steering: () => Steering): Laps => {
  const recorder = createRecorder()
  let kept = best
  let finish: FinishResult | null = null
  let attempt = -1
  /** The attempt's lap has been taken: nothing more is recorded until the next attempt. */
  let taken = false
  let recorded = false

  return {
    afterTick(input, view, events) {
      if (attempt === -1) attempt = view.lap.attempt
      let finished: FinishResult | null = null
      if (!taken) {
        const started = view.lap.phase !== "ready"
        recorder.push(input, started)
        if (started || input.throttle > 0 || input.brake > 0 || input.steer !== 0 || input.aim !== null) recorded = true
      }
      for (const event of events) {
        if (event.kind !== "finish" || taken) continue
        taken = true
        const current = steering()
        const bytes = recorder.take(trackId, current)
        const replay = bytes === null ? null : replayToText(bytes)
        const improved = replay !== null && (kept === null || event.timeMs < kept.timeMs)
        finished = { attempt: view.lap.attempt, timeMs: event.timeMs, splitsMs: [...event.splitsMs], previous: kept, improved, replay, steering: current }
        finish = finished
        if (improved && replay !== null) kept = { version: 1, replay, timeMs: event.timeMs, splitsMs: [...event.splitsMs], steering: current }
      }
      // The tick that started the attempt again belonged to the old one: the new one starts clean.
      if (view.lap.attempt !== attempt) {
        attempt = view.lap.attempt
        recorder.clear()
        taken = false
        recorded = false
      }
      return finished
    },
    recording: () => recorded && !taken,
    best: () => kept,
    lastFinish: () => finish
  }
}
