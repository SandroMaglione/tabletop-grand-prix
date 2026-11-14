/**
 * The ghost of the best lap: recording the car while an attempt runs, keeping the
 * recording when it beats the best lap, and playing the best lap back beside the car.
 *
 * It is fed once per simulation tick (`afterTick`), so recording and finishing happen on
 * the exact tick, whatever the frame rate.
 */
import type { RaceEvent, RaceView, TrackData } from "../sim/index.ts"
import type { GhostPose } from "./contract.ts"
import { type BestLap, loadBest, poseStride, saveBest } from "./storage.ts"

/** Record one pose every this many ticks. */
const recordEveryTicks = 4

/** What the last finished lap was, for the result panel. */
export interface FinishResult {
  readonly attempt: number
  readonly timeMs: number
  readonly splitsMs: ReadonlyArray<number>
  /** The best lap before this one, or null when this was the first. */
  readonly previous: BestLap | null
  readonly improved: boolean
}

export interface Ghost {
  /** After every simulation tick, with that tick's view and events. */
  afterTick(view: RaceView, events: ReadonlyArray<RaceEvent>): void
  /** Where the ghost car is for this view, or null when there is no best lap. */
  pose(view: RaceView): GhostPose | null
  best(): BestLap | null
  /** The last lap finished in this session, or null. */
  lastFinish(): FinishResult | null
}

const TAU = Math.PI * 2

/** The angle from `a` toward `b` by the short way round, at fraction `t`. */
const lerpAngle = (a: number, b: number, t: number): number => {
  let delta = (b - a) % TAU
  if (delta > Math.PI) delta -= TAU
  if (delta < -Math.PI) delta += TAU
  return a + delta * t
}

/** The best lap's pose at `timeMs`, interpolated between recorded poses and held at both ends. */
const poseAt = (poses: ReadonlyArray<number>, timeMs: number): GhostPose | null => {
  const count = poses.length / poseStride
  if (count === 0) return null
  const at = (i: number, field: number): number => poses[i * poseStride + field] ?? 0
  const pose = (i: number): GhostPose => ({ x: at(i, 1), y: at(i, 2), z: at(i, 3), yaw: at(i, 4), pitch: at(i, 5), roll: at(i, 6) })
  if (timeMs <= at(0, 0)) return pose(0)
  if (timeMs >= at(count - 1, 0)) return pose(count - 1)
  // The last pose at or before `timeMs`, by bisection.
  let low = 0
  let high = count - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (at(mid, 0) <= timeMs) low = mid
    else high = mid
  }
  const span = at(high, 0) - at(low, 0)
  const t = span > 0 ? (timeMs - at(low, 0)) / span : 0
  const mix = (field: number): number => at(low, field) + (at(high, field) - at(low, field)) * t
  return { x: mix(1), y: mix(2), z: mix(3), yaw: lerpAngle(at(low, 4), at(high, 4), t), pitch: mix(5), roll: mix(6) }
}

export const createGhost = (track: TrackData, hz: number): Ghost => {
  let best = loadBest(track)
  let finish: FinishResult | null = null
  let attempt = -1
  /** The attempt being recorded, flat like `BestLap.poses`. */
  let recording: Array<number> = []
  let lastRecordedMs = -Infinity
  const stepMs = (recordEveryTicks * 1000) / hz

  const cut = (): void => {
    recording = []
    lastRecordedMs = -Infinity
  }

  const push = (timeMs: number, view: RaceView): void => {
    const car = view.car
    recording.push(timeMs, car.x, car.y, car.z, car.yaw, car.pitch, car.roll)
    lastRecordedMs = timeMs
  }

  return {
    afterTick(view, events) {
      if (view.lap.attempt !== attempt) {
        attempt = view.lap.attempt
        cut()
      }
      for (const event of events) {
        if (event.kind === "start") cut()
        if (event.kind !== "finish") continue
        // The car is past the line by now; the last pose closes the ghost at the exact finish time.
        if (recording.length > 0) push(event.timeMs, view)
        const improved = best === null || event.timeMs < best.timeMs
        finish = { attempt, timeMs: event.timeMs, splitsMs: event.splitsMs, previous: best, improved }
        if (improved && recording.length > 0) {
          best = { timeMs: event.timeMs, splitsMs: [...event.splitsMs], poses: recording }
          saveBest(track, best)
        }
        cut()
      }
      if (view.lap.phase !== "running") return
      const timeMs = view.lap.timeMs
      // A clock that went back means a new lap began without a new attempt number.
      if (timeMs < lastRecordedMs) cut()
      // A small slack keeps float drift from skipping a pose.
      if (timeMs - lastRecordedMs >= stepMs - 0.01) push(timeMs, view)
    },
    pose(view) {
      if (best === null) return null
      // While ready the ghost waits on the start line; while running and finished it is
      // where the best lap was at the same time on the clock.
      return poseAt(best.poses, view.lap.phase === "ready" ? 0 : view.lap.timeMs)
    },
    best: () => best,
    lastFinish: () => finish
  }
}
