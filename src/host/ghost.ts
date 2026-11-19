/**
 * The ghost: a lap driven again beside the car. It is made from a replay (`runReplay` gives
 * its poses), once, when the ghost changes; during a lap it only reads the poses.
 *
 * A new ghost chosen while a lap runs waits for the lap to end, so a lap is raced against
 * one ghost from start to finish.
 *
 * A ghost by sector (`SectorGhost`) is one lap per sector: in each sector it is that sector's
 * driver, and each time the player crosses a line it becomes the next one's, from that line
 * at that moment. So every sector is raced from level against the driver picked for it.
 */
import { sectorTimes } from "../api/sectors.ts"
import { ghostStride, replayFromText, runReplay, type LapView, type RaceView } from "../sim/index.ts"
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
 * A ghost by sector: `legs[i]` drives sector `i`. Its time and splits are the ideal lap of
 * the legs (each one's own sector, added up), so the gap at each line is the player's against it.
 */
export interface SectorGhost {
  readonly kind: "sectors"
  readonly name: string
  readonly runId: null
  readonly timeMs: number
  readonly splitsMs: ReadonlyArray<number>
  readonly legs: ReadonlyArray<LapGhost>
}

/** What the player races: one lap, or one per sector. */
export type RaceGhost = LapGhost | SectorGhost

/** The ghost by sector made of `legs`, one per sector in order. */
export const sectorGhost = (legs: ReadonlyArray<LapGhost>): SectorGhost => {
  const own = legs.map((leg, i) => sectorTimes(leg.splitsMs, leg.timeMs, legs.length)[i] ?? 0)
  const splitsMs = own.map((_, i) => own.slice(0, i + 1).reduce((a, b) => a + b, 0))
  return { kind: "sectors", name: "BY SECTOR", runId: null, timeMs: splitsMs[splitsMs.length - 1] ?? 0, splitsMs, legs }
}

/** Where a ghost is at this point of the player's lap: which lap it drives, at what time on that lap's clock, and when (on the player's clock) its lap ends. */
export interface GhostAt {
  readonly leg: LapGhost
  readonly legMs: number
  readonly clockMs: number
  readonly endMs: number
}

/**
 * Where `ghost` is at this point of the player's lap. While ready it waits on the start line;
 * while running and finished it is where its lap was at the same time on the clock. A ghost
 * by sector drives the leg of the sector the player is in, from the line the player crossed
 * last, as long after its own crossing as the player is after theirs.
 */
export const ghostAt = (ghost: RaceGhost, lap: LapView): GhostAt | null => {
  const clockMs = lap.phase === "ready" ? 0 : lap.timeMs
  if (ghost.kind !== "sectors") return { leg: ghost, legMs: clockMs, clockMs, endMs: ghost.timeMs }
  const last = ghost.legs.length - 1
  const sector = lap.phase === "ready" ? 0 : Math.min(lap.splitsMs.length, last)
  const leg = ghost.legs[sector]
  if (leg === undefined) return null
  if (sector === 0) return { leg, legMs: clockMs, clockMs, endMs: last === 0 ? leg.timeMs : Number.POSITIVE_INFINITY }
  const mine = lap.splitsMs[sector - 1] ?? 0
  const theirs = leg.splitsMs[sector - 1] ?? mine
  return { leg, legMs: theirs + (clockMs - mine), clockMs, endMs: sector === last ? mine + (leg.timeMs - theirs) : Number.POSITIVE_INFINITY }
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
export const poseAt = (poses: ArrayLike<number>, timeMs: number): GhostPose | null => {
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

/** A ghost this close to the car (metres) is at its faintest, and from `NEAR_CLEAR` on fully drawn. */
const NEAR = 1.2
const NEAR_CLEAR = 2.8
/** The faintest a ghost gets over the car, as a share of its usual look. */
const NEAR_FLOOR = 0.2
/** How long a ghost takes to fade away once its lap is over. */
const GONE_MS = 600

/**
 * How solid to draw a ghost at `pose`, 0 to 1: fainter the closer it is to the car (so it never
 * hides the road ahead of the player), and fading away once its lap of `endMs` is over (instead
 * of parked on the line). `timeMs` is the race clock.
 */
export const ghostFade = (pose: { readonly x: number; readonly y: number; readonly z: number }, car: { readonly x: number; readonly y: number; readonly z: number }, timeMs: number, endMs: number): number => {
  const gone = timeMs <= endMs ? 1 : Math.max(0, 1 - (timeMs - endMs) / GONE_MS)
  const distance = Math.hypot(pose.x - car.x, pose.y - car.y, pose.z - car.z)
  const near = NEAR_FLOOR + (1 - NEAR_FLOOR) * Math.min(1, Math.max(0, (distance - NEAR) / (NEAR_CLEAR - NEAR)))
  return gone * near
}

export interface Ghost {
  /**
   * Where the ghost car is for this view (the player's race, or the lap shown again), or null
   * with no ghost. `racing` is whether a lap of the player's runs: a waiting ghost comes in
   * once it does not.
   */
  pose(view: RaceView, racing: boolean): GhostPose | null
  /** The ghost being raced (or the one about to be, between laps). */
  current(): RaceGhost | null
  /** The lap the ghost drives at this point of `view`'s lap (a ghost by sector changes at each line), or null with none. */
  leg(view: RaceView): LapGhost | null
  /** Race against `ghost` from the next lap on (at once when no lap runs). */
  set(ghost: RaceGhost | null): void
}

export const createGhost = (): Ghost => {
  let current: RaceGhost | null = null
  let waiting: { readonly ghost: RaceGhost | null } | null = null
  let running = false
  return {
    pose(view, racing) {
      running = racing
      if (waiting !== null && !running) {
        current = waiting.ghost
        waiting = null
      }
      if (current === null) return null
      const at = ghostAt(current, view.lap)
      const pose = at === null ? null : poseAt(at.leg.poses, at.legMs)
      return pose === null || at === null ? null : { ...pose, fade: ghostFade(pose, view.car, at.clockMs, at.endMs) }
    },
    current: () => (waiting !== null && !running ? waiting.ghost : current),
    leg: (view) => (current === null ? null : ghostAt(current, view.lap)?.leg ?? null),
    set(ghost) {
      if (running) waiting = { ghost }
      else {
        current = ghost
        waiting = null
      }
    }
  }
}
