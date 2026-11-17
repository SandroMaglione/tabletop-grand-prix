/** A leaderboard that never answers: every request is `Unavailable`. For `?server=down`, and to stand in when there is no server. */
import { Effect, Layer } from "effect"
import { Leaderboard } from "../../api/contract.ts"

const unavailable = Effect.fail({ _tag: "Unavailable" } as const)

export const layerDown: Layer.Layer<Leaderboard> = Layer.succeed(
  Leaderboard,
  Leaderboard.of({
    checkName: () => unavailable,
    register: () => unavailable,
    rename: () => unavailable,
    submit: () => unavailable,
    board: () => unavailable,
    page: () => unavailable,
    rival: () => unavailable,
    replay: () => unavailable
  })
)
