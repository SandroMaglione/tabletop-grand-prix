/**
 * The version of the rules: everything that decides where the car is after a given input,
 * so every number in `tuning.ts`, the physics in `car.ts` and `obstacles.ts`, the order of
 * the systems, and the shape of every track.
 *
 * A replay is only inputs, so it reproduces a lap only under the rules it was driven on.
 * Raise this whenever a change moves a lap by even a millisecond: the leaderboard keeps one
 * board per track and rules version, so older runs stay on their own board instead of being
 * judged by rules they were not driven on. `test/replay.test.ts` holds a lap recorded under
 * the current rules and fails when the rules moved without this number.
 */
export const rulesVersion = 5
