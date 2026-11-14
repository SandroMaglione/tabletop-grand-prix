/**
 * The track the game runs on.
 *
 * `tracks` lists them by id; `track` is the first, the Spindle Leap layout from
 * `layout.ts`. The fixture oval stays exported for tests.
 */
import { layoutTrack } from "./layout.ts"
import type { TrackData } from "../types.ts"

export { fixtureTrack } from "./fixture.ts"
export { angleDelta, indexAt, locateBelow, locateNear, pointAt } from "./query.ts"
export type { TrackHit } from "./query.ts"

/** A track the game offers. `id` never changes once runs are kept under it: saves and the leaderboard are filed by it. */
export interface TrackEntry {
  readonly id: string
  readonly name: string
  readonly data: TrackData
}

/** Every track, in the order the game lists them. A new track is one more entry here (and a new rules version). */
export const tracks: ReadonlyArray<TrackEntry> = [{ id: "spindle-leap", name: layoutTrack.name, data: layoutTrack }]

export const trackById = (id: string): TrackEntry | undefined => tracks.find((entry) => entry.id === id)

/** The first track: what the game opens on. */
export const track: TrackData = layoutTrack
