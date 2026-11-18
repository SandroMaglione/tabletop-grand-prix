/**
 * The lap just driven, driven again for the picture.
 *
 * A finished lap is a replay (its inputs), so showing it again is a second race session fed
 * those inputs one per simulation tick: the car, the props it shoved, the doors it opened and
 * every event are the lap's own, at the lap's own pace. The page draws this session's view
 * instead of the live one while it runs (`main.ts`); the live race is untouched.
 *
 * At the end the car is left to roll for a moment, then the lap starts again from the
 * standing start, for as long as the player watches. Each start hands the actors a `reset`
 * event before its first tick, so nothing is drawn from the car's last place to the start line.
 *
 * The same picture shows a run picked from the board (`WatchedRun`): someone's lap, watched
 * without racing, until the player drives again.
 */
import { createSession, decodeReplay, idleInput, replayFromText, unpack, type RaceEvent, type RaceSession, type RaceView, type Replay, type TrackData } from "../sim/index.ts"

/** A run of the board being watched: whose it is, and its place, for the car's paint and the HUD. */
export interface WatchedRun {
  readonly runId: string
  readonly name: string
  /** Its place on the board when it was picked, 1 the fastest. */
  readonly rank: number
  readonly timeMs: number
  /** It is the player's own run on the board. */
  readonly mine: boolean
}

export interface Rerun {
  /**
   * Show `replay` (as text) from its standing start: the lap just driven, or with `watched` a
   * run of the board. False when it is not a lap this build can drive.
   */
  start(replay: string, watched?: WatchedRun): boolean
  stop(): void
  active(): boolean
  /** The run of the board on screen, or null when none is (the lap just driven, or nothing). */
  watched(): WatchedRun | null
  /** Once per simulation tick while active: one tick of the lap, and what happened in it. */
  tick(): ReadonlyArray<RaceEvent>
  /** The lap as it is now. Only while active. */
  view(): RaceView
}

/** How long the car rolls on after the line before the lap starts again, in ticks (120 a second). */
const restTicks = 300

export const createRerun = (track: TrackData): Rerun => {
  let playing: { readonly replay: Replay; readonly watched: WatchedRun | null; readonly session: RaceSession; cursor: number; rest: number } | null = null
  /** The picture cuts to the start line: the actors are told before the lap's first tick. */
  let cut = false
  const cutEvent: RaceEvent = { kind: "reset", reason: "manual", x: track.start.x, y: track.start.y, z: track.start.z }

  const begin = (replay: Replay, watched: WatchedRun | null): void => {
    playing = { replay, watched, session: createSession(track, replay.steering), cursor: 0, rest: 0 }
    cut = true
  }

  return {
    start(text, watched) {
      const bytes = replayFromText(text)
      const replay = bytes === null ? null : decodeReplay(bytes)
      if (replay === null) return false
      begin(replay, watched ?? null)
      return true
    },
    stop() {
      playing = null
    },
    active: () => playing !== null,
    watched: () => playing?.watched ?? null,
    tick() {
      if (playing === null) return []
      const { replay, session } = playing
      if (playing.cursor >= replay.inputs.length / 4 && playing.rest >= restTicks) {
        // The lap and its rest are over: from the standing start again, on the next tick.
        begin(replay, playing.watched)
        return []
      }
      const events: Array<RaceEvent> = []
      if (cut) {
        events.push(cutEvent)
        cut = false
      }
      if (playing.cursor < replay.inputs.length / 4) {
        const at = playing.cursor * 4
        session.tick(unpack([replay.inputs[at] ?? 0, replay.inputs[at + 1] ?? 0, replay.inputs[at + 2] ?? 127, replay.inputs[at + 3] ?? 255]))
        playing.cursor++
      } else {
        session.tick(idleInput)
        playing.rest++
      }
      for (const event of session.drainEvents()) events.push(event)
      return events
    },
    view() {
      if (playing === null) throw new Error("No lap is being shown again")
      return playing.session.view()
    }
  }
}
