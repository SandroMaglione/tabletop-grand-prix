/**
 * The leaderboard, as the game sees it: what it can ask and what comes back. The server
 * (`src/server`) answers these; the game talks to it only through the `Leaderboard`
 * service, so it runs the same against the real server, a local one, or none at all.
 *
 * Players have no account. A device registers a name once and keeps the `Identity` it is
 * given; the secret in it is what proves later requests come from that device. A name
 * belongs to one device, and one device has one name.
 *
 * A board is one track under one version of the rules. It holds each player's best run
 * only. A run is sent as its replay (`src/sim/replay.ts`); the server drives the replay
 * again and files the time it gets, so `timeMs` anywhere here is the server's own.
 */
import { Context, type Effect, Schema } from "effect"

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const Steering = Schema.Union([Schema.Literal("car"), Schema.Literal("screen")])

/** A player as others see them. */
export const Player = Schema.Struct({ id: Schema.String, name: Schema.String })
export type Player = typeof Player.Type

/** What a device keeps to be its player. The secret never leaves the device except to prove who asks. */
export const Identity = Schema.Struct({ id: Schema.String, name: Schema.String, secret: Schema.String })
export type Identity = typeof Identity.Type

/** One line of a board. */
export const Entry = Schema.Struct({
  /** 1 is the fastest. */
  rank: count,
  runId: Schema.String,
  name: Schema.String,
  /** Whole milliseconds. */
  timeMs: count,
  steering: Steering,
  /** This is the asking player's own run. */
  mine: Schema.Boolean,
  /**
   * Each sector's time, whole milliseconds adding up to `timeMs`. Left out for a run the
   * server has not driven for its sectors yet (filed before it kept them).
   */
  sectorsMs: Schema.optionalKey(Schema.Array(count))
})
export type Entry = typeof Entry.Type

/**
 * How a board is ordered: by the whole lap (null), or by one sector's time (0 is the first).
 * Ordered by a sector, a board ranks the runs by that sector alone and holds only the runs
 * whose sectors the server knows; `rank`, `total` and `me` are of that order.
 */
export type BoardOrder = number | null

export const Board = Schema.Struct({
  track: Schema.String,
  rules: count,
  /** How many players have a run on this board. */
  total: count,
  /** The fastest runs, fastest first. */
  top: Schema.Array(Entry),
  /** The asking player's run with the runs just ahead of and behind it, fastest first. Empty when they have none or it is already in `top`. */
  around: Schema.Array(Entry),
  me: Schema.NullOr(Entry)
})
export type Board = typeof Board.Type

/** The most runs one page of a board holds. */
export const pageMax = 200

/** A stretch of a board, for reading all of it: the runs from rank `from` on, fastest first. */
export const BoardPage = Schema.Struct({
  track: Schema.String,
  rules: count,
  total: count,
  /** The rank of the first run in `entries`. */
  from: count,
  /** At most `pageMax`; fewer at the end of the board, none past it. */
  entries: Schema.Array(Entry)
})
export type BoardPage = typeof BoardPage.Type

/** What the server made of a run that was sent. */
export const Submitted = Schema.Struct({
  runId: Schema.String,
  timeMs: count,
  /** False when the player already had a faster run on this board: that one stays. */
  improved: Schema.Boolean,
  /** The player's rank on the board after this run. */
  rank: count,
  total: count
})
export type Submitted = typeof Submitted.Type

/** A run to race against: who drove it, and its replay as text (`replayFromText`). */
export const RunReplay = Schema.Struct({ runId: Schema.String, name: Schema.String, timeMs: count, steering: Steering, replay: Schema.String })
export type RunReplay = typeof RunReplay.Type

// ── What can go wrong ──────────────────────────────────────────────────

/** The name cannot be used: its shape is wrong, it is kept back, or it is one the server refuses. */
export const NameRefused = Schema.Struct({
  _tag: Schema.Literal("NameRefused"),
  reason: Schema.Union([Schema.Literal("length"), Schema.Literal("characters"), Schema.Literal("reserved"), Schema.Literal("blocked")])
})
export type NameRefused = typeof NameRefused.Type

/** Another device has this name (or one that reads the same). */
export const NameTaken = Schema.Struct({ _tag: Schema.Literal("NameTaken") })
export type NameTaken = typeof NameTaken.Type

/** The identity is not one the server knows (or it was removed). The device must register again. */
export const Unauthorised = Schema.Struct({ _tag: Schema.Literal("Unauthorised") })
export type Unauthorised = typeof Unauthorised.Type

/** The run is not a lap the server can file. `fault` is a `ReplayFault`, or `too-large`. */
export const RunRefused = Schema.Struct({ _tag: Schema.Literal("RunRefused"), fault: Schema.String })
export type RunRefused = typeof RunRefused.Type

/** Too many requests from here. Try again after the wait. */
export const RateLimited = Schema.Struct({ _tag: Schema.Literal("RateLimited"), retryAfterSeconds: count })
export type RateLimited = typeof RateLimited.Type

export const NotFound = Schema.Struct({ _tag: Schema.Literal("NotFound") })
export type NotFound = typeof NotFound.Type

/** The server could not be reached, or it failed. The game goes on without it and tries again later. */
export const Unavailable = Schema.Struct({ _tag: Schema.Literal("Unavailable") })
export type Unavailable = typeof Unavailable.Type

// ── The service ────────────────────────────────────────────────────────

export interface LeaderboardShape {
  /** Whether a name could be registered now. Succeeds when it could. */
  readonly checkName: (name: string) => Effect.Effect<void, NameRefused | NameTaken | RateLimited | Unavailable>
  /** Makes this device a player with this name. */
  readonly register: (name: string) => Effect.Effect<Identity, NameRefused | NameTaken | RateLimited | Unavailable>
  /** Changes the player's name. Their runs keep their place. */
  readonly rename: (identity: Identity, name: string) => Effect.Effect<Identity, NameRefused | NameTaken | Unauthorised | RateLimited | Unavailable>
  /** Sends a run. `replay` is the replay as text (`replayToText`). */
  readonly submit: (identity: Identity, replay: string) => Effect.Effect<Submitted, RunRefused | Unauthorised | RateLimited | Unavailable>
  /** The board of a track under the server's rules in `order`, seen by `identity` (or by nobody). `NotFound` for a sector the track has not. */
  readonly board: (track: string, identity: Identity | null, order: BoardOrder) => Effect.Effect<Board, NotFound | Unavailable>
  /** Up to `count` runs of a board in `order` (capped at `pageMax`) from rank `from` on (1 is the fastest), seen by `identity` (or by nobody). */
  readonly page: (track: string, from: number, count: number, identity: Identity | null, order: BoardOrder) => Effect.Effect<BoardPage, NotFound | Unavailable>
  /**
   * The run to chase: the slowest one that is still faster than `fasterThanMs`, never the
   * asking player's own. With `fasterThanMs` null (no lap yet), the slowest run on the
   * board. Null when nobody is ahead.
   */
  readonly rival: (track: string, fasterThanMs: number | null, identity: Identity | null) => Effect.Effect<Entry | null, NotFound | Unavailable>
  /** A run's replay, to drive beside. */
  readonly replay: (runId: string) => Effect.Effect<RunReplay, NotFound | Unavailable>
}

export class Leaderboard extends Context.Service<Leaderboard, LeaderboardShape>()("Tabletop/Leaderboard") {}
