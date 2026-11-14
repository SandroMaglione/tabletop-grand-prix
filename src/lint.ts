/**
 * The entry for `ritmo-devtools lint src/lint.ts`: the race's runtime and its schedule, for
 * the static lints of the simulation. The page has no ritmo schedules of its own.
 */
import { HostClock } from "@typeonce/ritmo"
import type * as Lint from "@typeonce/ritmo-devtools/Lint"
import { Drive, Game, Root, makeDebugRuntime, update } from "./sim/game.ts"
import { fixtureTrack } from "./sim/track/index.ts"

export const lintTarget = async (): Promise<Lint.Target<typeof Game.schema, typeof Root>> => ({
  runtime: makeDebugRuntime(fixtureTrack, "car", { hostClock: HostClock.test() }),
  schedules: { update },
  hostEvents: [Drive]
})
