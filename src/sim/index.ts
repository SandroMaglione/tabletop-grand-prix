/**
 * Everything the page may use from the simulation: the contract types, the track, the
 * track queries, `createSession`, and the bot driver (`botInput`).
 */
export type * from "./types.ts"
export { idleInput } from "./types.ts"
export { angleDelta, fixtureTrack, indexAt, locateBelow, locateNear, pointAt, track } from "./track/index.ts"
export type { TrackHit } from "./track/index.ts"
export { createSession } from "./session.ts"
export { botInput } from "./bot.ts"
