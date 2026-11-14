/**
 * What the page keeps between visits, in localStorage: the best lap of each track (its
 * time, splits and ghost) and two settings (the handling variant and sound on or off).
 *
 * Every read and write is wrapped: a private window or blocked storage reads as empty and
 * writes nothing, and the game runs the same without it.
 */
import type { TrackData } from "../sim/index.ts"

/** The best lap of one track, with the ghost recorded on it. */
export interface BestLap {
  readonly timeMs: number
  /** Time at each checkpoint, the finish line last, as `LapView.splitsMs` gave it. */
  readonly splitsMs: ReadonlyArray<number>
  /**
   * The ghost: one pose every few ticks, flat, seven numbers each:
   * elapsed ms, x, y, z, yaw, pitch, roll.
   */
  readonly poses: ReadonlyArray<number>
}

/** Numbers per ghost pose in `BestLap.poses`. */
export const poseStride = 7

const prefix = "tabletop-grand-prix"

/** One key per track: its name and length, so a changed track starts with no best lap. */
const bestKey = (track: TrackData): string =>
  `${prefix}:best:${track.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${Math.round(track.length)}`

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage full or blocked: the game goes on without saving.
  }
}

const isNumberArray = (value: unknown): value is ReadonlyArray<number> =>
  Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item))

export const loadBest = (track: TrackData): BestLap | null => {
  const raw = read(bestKey(track))
  if (raw === null) return null
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== "object" || data === null) return null
    const { timeMs, splitsMs, poses } = data as { readonly timeMs?: unknown; readonly splitsMs?: unknown; readonly poses?: unknown }
    if (typeof timeMs !== "number" || !Number.isFinite(timeMs) || timeMs <= 0) return null
    if (!isNumberArray(splitsMs) || !isNumberArray(poses) || poses.length % poseStride !== 0) return null
    return { timeMs, splitsMs, poses }
  } catch {
    return null
  }
}

/** Rounds the ghost to millimetres and thousandths of a radian, so it stays small as JSON. */
export const saveBest = (track: TrackData, best: BestLap): void => {
  const poses = best.poses.map((value) => Math.round(value * 1000) / 1000)
  write(bestKey(track), JSON.stringify({ timeMs: best.timeMs, splitsMs: best.splitsMs, poses }))
}

export const loadVariant = (): string | null => read(`${prefix}:variant`)
export const saveVariant = (name: string): void => write(`${prefix}:variant`, name)

export const loadMuted = (): boolean => read(`${prefix}:muted`) === "1"
export const saveMuted = (muted: boolean): void => write(`${prefix}:muted`, muted ? "1" : "0")
