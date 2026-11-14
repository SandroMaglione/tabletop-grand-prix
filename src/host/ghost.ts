/**
 * The ghost: a lap driven again beside the car. It is made from a replay (`runReplay` gives
 * its poses), once, when the ghost changes; during a lap it only reads the poses.
 *
 * A new ghost chosen while a lap runs waits for the lap to end, so a lap is raced against
 * one ghost from start to finish.
 */
import { ghostStride, replayFromText, runReplay, type RaceView } from "../sim/index.ts"
import type { GhostPose } from "./contract.ts"

/** A lap to race against: the player's own best, or another player's run. */
export interface LapGhost {
  readonly kind: "own" | "rival"
  /** Who drove it, for the timing panel. */
  readonly name: string
  /** The run on the leaderboard, or null for a lap only this device has. */
  readonly runId: string | null
  readonly timeMs: number
  readonly splitsMs: ReadonlyArray<number>
  /** One pose every few ticks, flat, `ghostStride` numbers each: elapsed ms, x, y, z, yaw, pitch, roll. */
  readonly poses: ReadonlyArray<number>
}

/**
 * The ghost of a replay given as text, or null when it is not a lap these rules can drive.
 * Drives the whole lap again (some tens of milliseconds): call it when the ghost changes.
 */
export const ghostFromReplay = (text: string, who: { readonly kind: LapGhost["kind"]; readonly name: string; readonly runId: string | null }): LapGhost | null => {
  const bytes = replayFromText(text)
  if (bytes === null) return null
  const run = runReplay(bytes)
  if (!run.ok) return null
  return { ...who, timeMs: run.timeMs, splitsMs: run.splitsMs, poses: run.poses }
}

const TAU = Math.PI * 2

/** The angle from `a` toward `b` by the short way round, at fraction `t`. */
const lerpAngle = (a: number, b: number, t: number): number => {
  let delta = (b - a) % TAU
  if (delta > Math.PI) delta -= TAU
  if (delta < -Math.PI) delta += TAU
  return a + delta * t
}

/** The pose at `timeMs`, interpolated between poses and held at both ends. */
export const poseAt = (poses: ReadonlyArray<number>, timeMs: number): GhostPose | null => {
  const count = poses.length / ghostStride
  if (count < 1) return null
  const at = (i: number, field: number): number => poses[i * ghostStride + field] ?? 0
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

export interface Ghost {
  /** Where the ghost car is for this view, or null with no ghost. Also lets a waiting ghost in once no lap runs. */
  pose(view: RaceView): GhostPose | null
  /** The ghost being raced (or the one about to be, between laps). */
  current(): LapGhost | null
  /** Race against `ghost` from the next lap on (at once when no lap runs). */
  set(ghost: LapGhost | null): void
}

export const createGhost = (): Ghost => {
  let current: LapGhost | null = null
  let waiting: { readonly ghost: LapGhost | null } | null = null
  let running = false
  return {
    pose(view) {
      running = view.lap.phase === "running"
      if (waiting !== null && !running) {
        current = waiting.ghost
        waiting = null
      }
      if (current === null) return null
      // While ready the ghost waits on the start line; while running and finished it is
      // where its lap was at the same time on the clock.
      return poseAt(current.poses, view.lap.phase === "ready" ? 0 : view.lap.timeMs)
    },
    current: () => (waiting !== null && !running ? waiting.ghost : current),
    set(ghost) {
      if (running) waiting = { ghost }
      else {
        current = ghost
        waiting = null
      }
    }
  }
}
