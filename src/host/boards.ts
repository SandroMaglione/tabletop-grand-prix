/**
 * What the device keeps for each board (a track under one version of the rules), each under
 * its own key from `boardKey`:
 *
 * - `Bests`: the best lap driven here, as its replay with its time and splits.
 * - `Rivals`: which ghost the player races, the runs they added beside it, how the board is
 *   shown (by lap or by one sector), and the last rival's run, so it is there offline.
 * - `Outbox`: the run waiting to be sent to the leaderboard. Only the fastest is kept: a
 *   board keeps each player's best, so a slower one would change nothing.
 *
 * A read never fails (an unreadable value is kept aside and reads as nothing) and a write
 * never fails (a refused write is lost and the game goes on).
 */
import { Context, Effect, Layer, Schema } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { RunReplay, Steering } from "../api/contract.ts"
import { read, remove, write } from "./persisted.ts"
import { boardKey, gameStore } from "./storage.ts"

const time = Schema.Finite

// ── the best lap ───────────────────────────────────────────────────────

export const BestRunV1 = Schema.Struct({
  version: Schema.Literal(1),
  /** The lap as a replay, as text (`replayToText`). */
  replay: Schema.String,
  timeMs: time,
  /** Time at each checkpoint, the finish line last. */
  splitsMs: Schema.Array(time),
  steering: Steering
})
const BestJson = Schema.fromJsonString(Schema.Union([BestRunV1]))
const BestLatest = Schema.fromJsonString(BestRunV1)
export type BestRun = typeof BestRunV1.Type

export interface BestsShape {
  readonly get: (track: string, rules: number) => Effect.Effect<BestRun | null>
  readonly set: (track: string, rules: number, best: BestRun) => Effect.Effect<void>
}

export class Bests extends Context.Service<Bests, BestsShape>()("Tabletop/Bests") {}

export const bestsLayer: Layer.Layer<Bests, never, KeyValueStore.KeyValueStore> = Layer.effect(
  Bests,
  Effect.map(gameStore, (store) =>
    Bests.of({
      get: (track, rules) => read(store, boardKey("best", track, rules), BestJson).pipe(Effect.map((got) => (got._tag === "Read" ? got.value : null))),
      set: (track, rules, best) => write(store, boardKey("best", track, rules), BestLatest, best)
    })
  )
)

// ── the rival ──────────────────────────────────────────────────────────

/** Which ghost to race, until the player could race the fastest runs or one driver per sector, and add ghosts from the board. */
const GhostChoiceV1 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("next") }),
  Schema.Struct({ kind: Schema.Literal("run"), runId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("own") }),
  Schema.Struct({ kind: Schema.Literal("none") })
])

/**
 * Which ghost to race:
 * - `next`: the next closest, the slowest run still faster than the player's best;
 * - `fastest`: the fastest run of the board in the order it is shown (the lap, or one sector);
 * - `sectors`: one driver per sector, `runs[i]` for sector `i` (null: the fastest in it), the
 *   ghost becoming the next one's at each line the player crosses (`SectorGhost`);
 * - `own`: the player's own best;
 * - `none`: no ghost.
 *
 * The runs the player adds from the board race beside it (`SavedRival.picked`).
 */
export const GhostChoice = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("next") }),
  Schema.Struct({ kind: Schema.Literal("fastest") }),
  Schema.Struct({ kind: Schema.Literal("sectors"), runs: Schema.Array(Schema.NullOr(Schema.String)) }),
  Schema.Struct({ kind: Schema.Literal("own") }),
  Schema.Struct({ kind: Schema.Literal("none") })
])
export type GhostChoice = typeof GhostChoice.Type

/** How the board is shown: by the lap (null) or by one sector (0 is the first). */
export const BoardOrder = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))

/** Until the board could be shown by sector and ghosts added from it. */
export const RivalV1 = Schema.Struct({
  version: Schema.Literal(1),
  choice: GhostChoiceV1,
  run: Schema.NullOr(RunReplay)
})
export const RivalV2 = Schema.Struct({
  version: Schema.Literal(2),
  choice: GhostChoice,
  /** How the board is shown, which the `fastest` ghost follows. */
  order: BoardOrder,
  /** The runs of the board the player added to race beside the ghost, in the order added. */
  picked: Schema.Array(Schema.String),
  /** The last rival's run, kept for when the server cannot be reached. */
  run: Schema.NullOr(RunReplay)
})
const RivalJson = Schema.fromJsonString(Schema.Union([RivalV1, RivalV2]))
const RivalLatest = Schema.fromJsonString(RivalV2)
export type SavedRival = typeof RivalV2.Type

export const noRival: SavedRival = { version: 2, choice: { kind: "next" }, order: null, picked: [], run: null }

/** A run chosen from the board to race used to be the ghost itself: it races beside the next closest now. */
const latestRival = (saved: typeof RivalV1.Type | SavedRival): SavedRival => {
  if (saved.version === 2) return saved
  if (saved.choice.kind === "run") return { version: 2, choice: { kind: "next" }, order: null, picked: [saved.choice.runId], run: saved.run }
  return { version: 2, choice: saved.choice, order: null, picked: [], run: saved.run }
}

export interface RivalsShape {
  readonly get: (track: string, rules: number) => Effect.Effect<SavedRival>
  readonly set: (track: string, rules: number, rival: SavedRival) => Effect.Effect<void>
}

export class Rivals extends Context.Service<Rivals, RivalsShape>()("Tabletop/Rivals") {}

export const rivalsLayer: Layer.Layer<Rivals, never, KeyValueStore.KeyValueStore> = Layer.effect(
  Rivals,
  Effect.map(gameStore, (store) =>
    Rivals.of({
      get: (track, rules) => read(store, boardKey("rival", track, rules), RivalJson).pipe(Effect.map((got) => (got._tag === "Read" ? latestRival(got.value) : noRival))),
      set: (track, rules, rival) => write(store, boardKey("rival", track, rules), RivalLatest, rival)
    })
  )
)

// ── the run waiting to be sent ─────────────────────────────────────────

export const PendingV1 = Schema.Struct({
  version: Schema.Literal(1),
  replay: Schema.String,
  /** The time this device drove, to keep only the fastest. The server files its own. */
  timeMs: time
})
const PendingJson = Schema.fromJsonString(Schema.Union([PendingV1]))
const PendingLatest = Schema.fromJsonString(PendingV1)
export type PendingRun = typeof PendingV1.Type

export interface OutboxShape {
  readonly get: (track: string, rules: number) => Effect.Effect<PendingRun | null>
  /** Keeps `run` to send, unless a faster one is already waiting. */
  readonly put: (track: string, rules: number, run: PendingRun) => Effect.Effect<void>
  /** Forgets the waiting run, if it is still `replay` (a faster one may have arrived meanwhile). */
  readonly clear: (track: string, rules: number, replay: string) => Effect.Effect<void>
}

export class Outbox extends Context.Service<Outbox, OutboxShape>()("Tabletop/Outbox") {}

export const outboxLayer: Layer.Layer<Outbox, never, KeyValueStore.KeyValueStore> = Layer.effect(
  Outbox,
  Effect.map(gameStore, (store) => {
    const get = (track: string, rules: number): Effect.Effect<PendingRun | null> =>
      read(store, boardKey("outbox", track, rules), PendingJson).pipe(Effect.map((got) => (got._tag === "Read" ? got.value : null)))
    return Outbox.of({
      get,
      put: (track, rules, run) =>
        get(track, rules).pipe(
          Effect.flatMap((waiting) => (waiting !== null && waiting.timeMs <= run.timeMs ? Effect.void : write(store, boardKey("outbox", track, rules), PendingLatest, run)))
        ),
      clear: (track, rules, replay) =>
        get(track, rules).pipe(Effect.flatMap((waiting) => (waiting !== null && waiting.replay === replay ? remove(store, boardKey("outbox", track, rules)) : Effect.void)))
    })
  })
)

/** Every per-board service, on one store. */
export const boardsLayer: Layer.Layer<Bests | Rivals | Outbox, never, KeyValueStore.KeyValueStore> = Layer.mergeAll(bestsLayer, rivalsLayer, outboxLayer)
