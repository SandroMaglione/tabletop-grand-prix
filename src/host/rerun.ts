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
 * without racing, until the player drives again; picked from a board by sector, only that
 * sector, from its line to the next, again and again.
 */
import { createSession, decodeReplay, idleInput, replayFromText, unpack, type RaceEvent, type RaceSession, type RaceView, type Replay, type TrackData } from "../sim/index.ts"

/** A run of the board being watched: whose it is, and its place, for the car's paint and the HUD. */
export interface WatchedRun {
  readonly runId: string
  readonly name: string
  /** Its place on the board when it was picked, 1 the fastest (on a board by sector, its place in that sector). */
  readonly rank: number
  /** Its lap's time, or with `sector` its time in that sector. */
  readonly timeMs: number
  /** It is the player's own run on the board. */
  readonly mine: boolean
  /** Only this sector of it (0 is the first) is shown, again and again; null for the whole lap. */
  readonly sector: number | null
}

export interface Rerun {
  /**
   * Show `replay` (as text) from its standing start: the lap just driven, or with `watched` a
   * run of the board (only one of its sectors, when `watched.sector` says so). False when it
   * is not a lap this build can drive.
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
/** How long it rolls on past a sector's end before the sector starts again. */
const sectorRestTicks = 72

/** One tick of `replay`'s inputs (idle past its end), into `session`. */
const feed = (session: RaceSession, replay: Replay, cursor: number): void => {
  const at = cursor * 4
  session.tick(
    cursor < replay.inputs.length / 4 ? unpack([replay.inputs[at] ?? 0, replay.inputs[at + 1] ?? 0, replay.inputs[at + 2] ?? 127, replay.inputs[at + 3] ?? 255]) : idleInput
  )
}

/** Whether `event` ends sector `sector`: the next line, or the finish for the last. */
const endsSector = (event: RaceEvent, sector: number): boolean => event.kind === "finish" || (event.kind === "checkpoint" && event.index === sector + 1)

/**
 * One sector of a lap, shown again and again. The lap is driven unseen up to the sector's
 * line (`from`, in ticks), then shown to the line that ends it, and on for a moment; meanwhile
 * the next showing's session is driven up to `from` a few ticks at a time, so starting again
 * costs no frame.
 */
interface Clip {
  readonly sector: number
  readonly from: number
  ended: boolean
  next: { readonly session: RaceSession; cursor: number } | null
}

export const createRerun = (track: TrackData): Rerun => {
  let playing: { readonly replay: Replay; readonly watched: WatchedRun | null; session: RaceSession; cursor: number; rest: number; readonly clip: Clip | null } | null = null
  /** The picture cuts to where the car starts: the actors are told before the first tick shown. */
  let cut = false
  const cutAt = (session: RaceSession): RaceEvent => {
    const { x, y, z } = session.view().car
    return { kind: "reset", reason: "manual", x, y, z }
  }

  const begin = (replay: Replay, watched: WatchedRun | null): void => {
    const session = createSession(track, replay.steering)
    const sector = watched?.sector ?? null
    if (sector === null) {
      playing = { replay, watched, session, cursor: 0, rest: 0, clip: null }
      cut = true
      return
    }
    // Drive unseen to the line the sector starts at (the start for the first).
    let cursor = 0
    let found = sector === 0
    while (!found && cursor < replay.inputs.length / 4) {
      feed(session, replay, cursor++)
      found = session.drainEvents().some((event) => event.kind === "checkpoint" && event.index === sector)
    }
    // A lap that never reaches the sector is shown whole.
    if (!found) return begin(replay, watched === null ? null : { ...watched, sector: null })
    playing = { replay, watched, session, cursor, rest: 0, clip: { sector, from: cursor, ended: false, next: null } }
    cut = true
  }

  /** Drives the next showing of a clip toward its start, `ticks` at most. */
  const prepare = (replay: Replay, clip: Clip, ticks: number): void => {
    clip.next ??= { session: createSession(track, replay.steering), cursor: 0 }
    const next = clip.next
    for (let i = 0; i < ticks && next.cursor < clip.from; i++) {
      feed(next.session, replay, next.cursor++)
      next.session.drainEvents()
    }
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
      const { replay, clip } = playing
      const inputs = replay.inputs.length / 4
      if (clip === null && playing.cursor >= inputs && playing.rest >= restTicks) {
        // The lap and its rest are over: from the standing start again, on the next tick.
        begin(replay, playing.watched)
        return []
      }
      if (clip !== null && clip.ended) {
        // Past the sector's end: the next showing gets ready a share at a time, and takes over once the car has rolled on.
        prepare(replay, clip, playing.rest >= sectorRestTicks ? clip.from : Math.ceil(clip.from / sectorRestTicks) + 1)
        if (playing.rest >= sectorRestTicks && clip.next !== null) {
          playing.session = clip.next.session
          playing.cursor = clip.from
          playing.rest = 0
          clip.ended = false
          clip.next = null
          cut = true
        }
      }
      const events: Array<RaceEvent> = []
      if (cut) {
        events.push(cutAt(playing.session))
        cut = false
      }
      feed(playing.session, replay, playing.cursor)
      if (playing.cursor < inputs) playing.cursor++
      else if (clip === null) playing.rest++
      if (clip !== null && clip.ended) playing.rest++
      for (const event of playing.session.drainEvents()) {
        if (clip !== null && !clip.ended && endsSector(event, clip.sector)) clip.ended = true
        events.push(event)
      }
      return events
    },
    view() {
      if (playing === null) throw new Error("No lap is being shown again")
      return playing.session.view()
    }
  }
}
