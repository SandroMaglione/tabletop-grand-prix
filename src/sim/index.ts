/**
 * Everything the page may use from the simulation: the contract types, the track, the
 * track queries, `createSession`, and the bot driver (`botInput`).
 */
export type * from "./types.ts"
export { idleInput } from "./types.ts"
export { angleDelta, fixtureTrack, indexAt, locateBelow, locateNear, pointAt, track, trackById, tracks } from "./track/index.ts"
export type { TrackEntry, TrackHit } from "./track/index.ts"
export { createRecorder, decodeReplay, ghostEveryTicks, ghostStride, maxReplayTicks, quantise, replayFromText, replayToText, runReplay } from "./replay.ts"
export type { Recorder, Replay, ReplayFault, ReplayRun, Steering } from "./replay.ts"
export { rulesVersion } from "./version.ts"
export { createSession } from "./session.ts"
export { botInput } from "./bot.ts"
