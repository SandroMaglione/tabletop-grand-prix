/**
 * A lap's sectors: the stretches between the lines it crosses, the finish last. The server
 * files each run's sectors with it (for the boards ordered by one sector), and the page shows
 * them under a run's row (`splits.ts`); both work them out here, from the lap's splits.
 */

/** How many sectors a track's lap has: one per line it crosses, the finish included. */
export const sectorCount = (track: { readonly checkpoints: ReadonlyArray<number> }): number => Math.max(1, track.checkpoints.length)

/**
 * Each sector's own time from a lap's splits (time at each line crossed, the finish last). A
 * lap whose splits leave out the finish ends its last sector on `timeMs`.
 */
export const sectorTimes = (splitsMs: ReadonlyArray<number>, timeMs: number, count: number): Array<number> => {
  const lines = splitsMs.length < count ? [...splitsMs, timeMs] : splitsMs.slice(0, count)
  return lines.map((at, i) => at - (i === 0 ? 0 : (lines[i - 1] ?? 0)))
}

/**
 * The sectors as the server files them: whole milliseconds that add up to the lap's filed
 * time (`Math.floor` of the time driven), so a board by sector and the board by lap agree.
 */
export const wholeSectors = (splitsMs: ReadonlyArray<number>, timeMs: number, count: number): Array<number> => {
  const lines = (splitsMs.length < count ? [...splitsMs, timeMs] : splitsMs.slice(0, count)).map(Math.floor)
  if (lines.length === count) lines[count - 1] = Math.floor(timeMs)
  return lines.map((at, i) => at - (i === 0 ? 0 : (lines[i - 1] ?? 0)))
}
