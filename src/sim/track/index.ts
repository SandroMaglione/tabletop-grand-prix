/**
 * The track the game runs on.
 *
 * `track` is the one every part of the game reads: the Spindle Leap layout from
 * `layout.ts`. The fixture oval stays exported for tests.
 */
import { layoutTrack } from "./layout.ts"
import type { TrackData } from "../types.ts"

export { fixtureTrack } from "./fixture.ts"
export { angleDelta, indexAt, locateBelow, locateNear, pointAt } from "./query.ts"
export type { TrackHit } from "./query.ts"

export const track: TrackData = layoutTrack
