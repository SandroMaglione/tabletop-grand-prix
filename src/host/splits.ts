/**
 * A run's sectors against the run just above it on the board: where the time to catch it is
 * lost. The fastest run is shown alone.
 *
 * The board's lines carry no splits, so the runs' replays are fetched (`Online.replay`) and
 * driven again here (`runReplay`, some tens of milliseconds each, out of the frame through
 * `defer`). A run never changes under its id, so each is driven once a visit.
 */
import type { Entry } from "../api/contract.ts"
import { replayFromText, runReplay } from "../sim/index.ts"
import type { Online } from "./online.ts"

/** One sector of a run, and how much slower it was than the run above (negative: faster); null with none above. */
export interface SectorSplit {
  readonly ms: number
  readonly deltaMs: number | null
}

export interface RunSplits {
  /** The run it is held against: the one just above, or null for the fastest. */
  readonly above: Entry | null
  readonly sectors: ReadonlyArray<SectorSplit>
  /** The sector it loses the most in, or -1 when it loses in none. */
  readonly worst: number
}

/**
 * Each sector's own time from a lap's splits (time at each line crossed, the finish last). A
 * lap whose splits leave out the finish ends its last sector on `timeMs`.
 */
export const sectorTimes = (splitsMs: ReadonlyArray<number>, timeMs: number, count: number): Array<number> => {
  const lines = splitsMs.length < count ? [...splitsMs, timeMs] : splitsMs.slice(0, count)
  return lines.map((at, i) => at - (i === 0 ? 0 : (lines[i - 1] ?? 0)))
}

/** A run's sectors against those of the run above (null for none), and the one it loses the most in. */
export const compareSectors = (mine: ReadonlyArray<number>, theirs: ReadonlyArray<number> | null): { readonly sectors: ReadonlyArray<SectorSplit>; readonly worst: number } => {
  const sectors = mine.map((ms, i) => {
    const other = theirs?.[i]
    return { ms, deltaMs: other === undefined ? null : ms - other }
  })
  let worst = -1
  for (let i = 0; i < sectors.length; i++) {
    const delta = sectors[i]?.deltaMs ?? 0
    if (delta > 0 && (worst < 0 || delta > (sectors[worst]?.deltaMs ?? 0))) worst = i
  }
  return { sectors, worst }
}

export interface Splits {
  /** The splits of `entry` when both runs were driven already (drawn at once), else null. */
  known(entry: Entry, above: Entry | null): RunSplits | null
  /**
   * The splits of `entry` against `above`, the run just above it; with `above` null for a run
   * that is not the fastest, the board is asked for it. Null when they cannot be had.
   */
  load(entry: Entry, above: Entry | null): Promise<RunSplits | null>
}

export const createSplits = (online: Online, sectorCount: number, defer: (work: () => void) => void = (work) => setTimeout(work, 0)): Splits => {
  /** Each run's sectors, once driven; null for one that cannot be driven. */
  const driven = new Map<string, Array<number> | null>()
  /** The run found above a run (by its id) when it was not given. */
  const found = new Map<string, Entry>()

  const sectorsOf = async (runId: string): Promise<Array<number> | null> => {
    const known = driven.get(runId)
    if (known !== undefined) return known
    const got = await online.replay(runId)
    // Unreachable: not kept, so it is asked for again next time.
    if (got === null) return null
    const sectors = await new Promise<Array<number> | null>((resolve) =>
      defer(() => {
        const bytes = replayFromText(got.replay)
        const run = bytes === null ? null : runReplay(bytes, { ghost: false })
        resolve(run === null || !run.ok ? null : sectorTimes(run.splitsMs, run.timeMs, sectorCount))
      })
    )
    driven.set(runId, sectors)
    return sectors
  }

  const aboveOf = (entry: Entry, above: Entry | null): Entry | null => (entry.rank <= 1 ? null : above ?? found.get(entry.runId) ?? null)

  const make = (mine: ReadonlyArray<number>, above: Entry | null, theirs: ReadonlyArray<number> | null): RunSplits => ({ above, ...compareSectors(mine, theirs) })

  return {
    known(entry, given) {
      const mine = driven.get(entry.runId)
      if (mine === undefined || mine === null) return null
      if (entry.rank <= 1) return make(mine, null, null)
      const above = aboveOf(entry, given)
      const theirs = above === null ? undefined : driven.get(above.runId)
      return above === null || theirs === undefined || theirs === null ? null : make(mine, above, theirs)
    },
    async load(entry, given) {
      let above = aboveOf(entry, given)
      if (above === null && entry.rank > 1) {
        const page = await online.page(entry.rank - 1, 1)
        above = page?.entries[0] ?? null
        if (above === null) return null
        found.set(entry.runId, above)
      }
      const [mine, theirs] = await Promise.all([sectorsOf(entry.runId), above === null ? Promise.resolve(null) : sectorsOf(above.runId)])
      if (mine === null || (above !== null && theirs === null)) return null
      return make(mine, above, theirs)
    }
  }
}
