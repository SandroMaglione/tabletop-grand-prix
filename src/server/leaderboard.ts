/**
 * What the server does, apart from HTTP: players, names, runs and boards over `Sql`. The
 * Worker (`worker.ts`) and the tests run this same code, on D1 and on Node's SQLite.
 *
 * A time is never taken from the request: `submit` drives the replay again with `runReplay`
 * and files `Math.floor` of the time that gives.
 */
import { Effect } from "effect"
import { pageMax, type Board, type BoardPage, type Entry, type Identity, type NameRefused, type NameTaken, type NotFound, type RunRefused, type RunReplay, type Submitted, type Unauthorised } from "../api/contract.ts"
import { replayFromText, replayToText, rulesVersion, runReplay, trackById } from "../sim/index.ts"
import { tidyName } from "../api/names.ts"
import { foldName, judgeName } from "./names.ts"
import type { Sql, SqlError, Statement } from "./sql.ts"

/** The longest replay text the server reads. A three-minute lap that changes input every tick is about 56 KB. */
export const maxReplayText = 64 * 1024
/** How many runs a board shows from the top. */
export const topCount = 10
/** How many runs `around` shows on each side of the asking player's. */
export const aroundCount = 2

/** A player who proved who they are. */
export interface Player {
  readonly id: string
  readonly name: string
  /** From the request: the server keeps only its hash. */
  readonly secret: string
}

interface RunRow {
  readonly id: string
  readonly player_id: string
  readonly name: string
  readonly time_ms: number
  readonly steering: "car" | "screen"
  readonly posted_at: number
}

// ── Randomness and hashing ─────────────────────────────────────────────

const base64url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const randomText = (byteCount: number): string => base64url(crypto.getRandomValues(new Uint8Array(byteCount)))

/** A player's or a run's id: public, unguessable enough to not be walked. */
export const newId = (): string => randomText(12)
const newSecret = (): string => randomText(32)

/** SHA-256, hex. The secret is 32 random bytes, so a plain hash is all it needs. */
export const hashSecret = (secret: string): Effect.Effect<string> =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))).pipe(
    Effect.map((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""))
  )

/** Compares two strings in time that does not depend on where they differ. */
export const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let difference = 0
  for (let at = 0; at < a.length; at++) difference |= a.charCodeAt(at) ^ b.charCodeAt(at)
  return difference === 0
}

/** The id and secret in an `Authorization: Bearer <id>.<secret>` header, or null. */
export const readAuthorization = (header: string | undefined): { readonly id: string; readonly secret: string } | null => {
  const match = /^Bearer ([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,128})$/.exec(header?.trim() ?? "")
  return match === null ? null : { id: match[1] ?? "", secret: match[2] ?? "" }
}

// ── Failures ───────────────────────────────────────────────────────────

const refused = (reason: NameRefused["reason"]): NameRefused => ({ _tag: "NameRefused", reason })
const taken: NameTaken = { _tag: "NameTaken" }
const unauthorised: Unauthorised = { _tag: "Unauthorised" }
const notFound: NotFound = { _tag: "NotFound" }
const runRefused = (fault: string): RunRefused => ({ _tag: "RunRefused", fault })

// ── The server ─────────────────────────────────────────────────────────

export interface LeaderboardOptions {
  /** The clock, in ms since 1970. */
  readonly now?: () => number
}

export const makeLeaderboard = <R>(sql: Sql<R>, options: LeaderboardOptions = {}) => {
  const now = options.now ?? Date.now
  /** A database failure is the server failing: the client sees `Unavailable`. */
  const all = <Row>(query: string, values: ReadonlyArray<string | number | null> = []): Effect.Effect<ReadonlyArray<Row>, never, R> =>
    Effect.orDie(sql.all<Row>(query, values) as Effect.Effect<ReadonlyArray<Row>, SqlError, R>)
  const run = (query: string, values: ReadonlyArray<string | number | null> = []): Effect.Effect<number, never, R> => Effect.orDie(sql.run(query, values))
  const batch = (statements: ReadonlyArray<Statement>): Effect.Effect<ReadonlyArray<ReadonlyArray<unknown> | undefined>, never, R> =>
    Effect.orDie(sql.batch(statements))
  const one = <Row>(query: string, values: ReadonlyArray<string | number | null> = []): Effect.Effect<Row | undefined, never, R> =>
    Effect.map(all<Row>(query, values), (rows) => rows[0])

  /** A name the server accepts, as it is kept and as it is compared; or why not. An admin may give a name the game keeps back. */
  const acceptable = (raw: string, allowReserved = false): Effect.Effect<{ readonly name: string; readonly folded: string }, NameRefused> => {
    const verdict = judgeName(raw)
    if (verdict.ok) return Effect.succeed(verdict)
    if (allowReserved && verdict.reason === "reserved") {
      const name = tidyName(raw)
      return Effect.succeed({ name, folded: foldName(name) })
    }
    return Effect.fail(refused(verdict.reason))
  }

  const checkName = (name: string): Effect.Effect<void, NameRefused | NameTaken, R> =>
    Effect.gen(function* () {
      const free = yield* acceptable(name)
      const holder = yield* one<{ id: string }>("SELECT id FROM players WHERE folded = ?", [free.folded])
      if (holder !== undefined) return yield* Effect.fail(taken)
    })

  const register = (name: string): Effect.Effect<Identity, NameRefused | NameTaken, R> =>
    Effect.gen(function* () {
      const free = yield* acceptable(name)
      const id = newId()
      const secret = newSecret()
      const hash = yield* hashSecret(secret)
      // The folded name is unique, so of two devices asking for one name at once only one gets it.
      const inserted = yield* all<{ id: string }>(
        "INSERT INTO players (id, name, folded, secret_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (folded) DO NOTHING RETURNING id",
        [id, free.name, free.folded, hash, now()]
      )
      if (inserted.length === 0) return yield* Effect.fail(taken)
      return { id, name: free.name, secret }
    })

  /** The player whose id and secret the header carries; `Unauthorised` when it carries none that work. */
  const authenticate = (header: string | undefined): Effect.Effect<Player, Unauthorised, R> =>
    Effect.gen(function* () {
      const claimed = readAuthorization(header)
      if (claimed === null) return yield* Effect.fail(unauthorised)
      const row = yield* one<{ id: string; name: string; secret_hash: string; banned_at: number | null }>(playerStatement(claimed.id).query, [claimed.id])
      if (row === undefined || !(yield* proves(row, claimed.secret))) return yield* Effect.fail(unauthorised)
      return { id: row.id, name: row.name, secret: claimed.secret }
    })

  const setName = (playerId: string, raw: string, allowReserved: boolean): Effect.Effect<string, NameRefused | NameTaken | NotFound, R> =>
    Effect.gen(function* () {
      const free = yield* acceptable(raw, allowReserved)
      // `OR IGNORE`: when another player holds the folded name nothing changes. The player's own
      // folded name is no conflict, so they may change how it is written.
      const changed = yield* run("UPDATE OR IGNORE players SET name = ?, folded = ? WHERE id = ?", [free.name, free.folded, playerId])
      if (changed === 0) {
        const exists = yield* one<{ id: string }>("SELECT id FROM players WHERE id = ?", [playerId])
        return yield* Effect.fail(exists === undefined ? notFound : taken)
      }
      return free.name
    })

  const rename = (player: Player, name: string): Effect.Effect<Identity, NameRefused | NameTaken | Unauthorised, R> =>
    setName(player.id, name, false).pipe(
      Effect.map((newName) => ({ id: player.id, name: newName, secret: player.secret })),
      Effect.catchTag("NotFound", () => Effect.fail(unauthorised))
    )

  // ── Runs ─────────────────────────────────────────────────────────────

  const runColumns = "r.id, r.player_id, p.name, r.time_ms, r.steering, r.posted_at"
  /** The rank of run `r` on its board: the runs ahead of it, plus one. */
  const rankColumn = `(SELECT COUNT(*) FROM runs o WHERE o.track = r.track AND o.rules = r.rules
      AND (o.time_ms < r.time_ms OR (o.time_ms = r.time_ms AND (o.posted_at < r.posted_at OR (o.posted_at = r.posted_at AND o.id < r.id))))) + 1 AS rank`
  const boardOrder = "ORDER BY r.time_ms, r.posted_at, r.id"
  const fromBoard = "FROM runs r JOIN players p ON p.id = r.player_id WHERE r.track = ? AND r.rules = ?"

  const totalStatement = (track: string, rules: number): Statement => ({
    query: "SELECT COUNT(*) AS total FROM runs WHERE track = ? AND rules = ?",
    values: [track, rules]
  })
  const pageStatement = (track: string, rules: number, offset: number, limit: number): Statement => ({
    query: `SELECT ${runColumns} ${fromBoard} ${boardOrder} LIMIT ? OFFSET ?`,
    values: [track, rules, limit, offset]
  })
  const myRunStatement = (track: string, rules: number, playerId: string): Statement => ({
    query: `SELECT ${runColumns}, ${rankColumn} ${fromBoard} AND r.player_id = ?`,
    values: [track, rules, playerId]
  })
  const playerStatement = (id: string): Statement => ({ query: "SELECT id, name, secret_hash, banned_at FROM players WHERE id = ?", values: [id] })

  const totalOf = (rows: ReadonlyArray<unknown> | undefined): number => (rows?.[0] as { total: number } | undefined)?.total ?? 0

  const entry = (row: RunRow, rank: number, viewerId: string | null): Entry => ({
    rank,
    runId: row.id,
    name: row.name,
    timeMs: row.time_ms,
    steering: row.steering,
    mine: row.player_id === viewerId
  })

  const submit = (player: Player, text: string): Effect.Effect<Submitted, RunRefused, R> =>
    Effect.gen(function* () {
      if (text.length > maxReplayText) return yield* Effect.fail(runRefused("too-large"))
      const bytes = replayFromText(text)
      if (bytes === null) return yield* Effect.fail(runRefused("unreadable"))
      const lap = runReplay(bytes, { ghost: false })
      if (!lap.ok) return yield* Effect.fail(runRefused(lap.fault))
      if (lap.rules !== rulesVersion) return yield* Effect.fail(runRefused("other-rules"))
      const timeMs = Math.floor(lap.timeMs)
      // One statement, so two runs sent at once cannot both be kept: the faster one stays. An
      // equal time is not an improvement, so the run posted first keeps its place.
      const [stored, best, total] = yield* batch([
        {
          query: `INSERT INTO runs (id, player_id, track, rules, time_ms, steering, replay, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (player_id, track, rules) DO UPDATE SET
              id = excluded.id, time_ms = excluded.time_ms, steering = excluded.steering, replay = excluded.replay, posted_at = excluded.posted_at
            WHERE excluded.time_ms < runs.time_ms
            RETURNING id`,
          values: [newId(), player.id, lap.track, lap.rules, timeMs, lap.steering, replayToText(bytes), now()]
        },
        myRunStatement(lap.track, lap.rules, player.id),
        totalStatement(lap.track, lap.rules)
      ])
      const mine = best?.[0] as (RunRow & { rank: number }) | undefined
      if (mine === undefined) return yield* Effect.die(new Error("the run just filed is not on the board"))
      return { runId: mine.id, timeMs, improved: (stored?.length ?? 0) > 0, rank: mine.rank, total: totalOf(total) }
    })

  /** Whether the player row a request claimed is the one whose secret it sent. */
  const proves = (row: unknown, secret: string): Effect.Effect<boolean> => {
    const player = row as { secret_hash: string; banned_at: number | null } | undefined
    if (player === undefined || player.banned_at !== null) return Effect.succeed(false)
    return Effect.map(hashSecret(secret), (hash) => sameText(player.secret_hash, hash))
  }

  /**
   * A board, seen by whoever `authorization` proves, or by nobody. One round trip: the
   * player's row and run are read with the board, and kept only if the secret matches.
   */
  const board = (track: string, authorization: string | undefined): Effect.Effect<Board, NotFound, R> =>
    Effect.gen(function* () {
      if (trackById(track) === undefined) return yield* Effect.fail(notFound)
      const rules = rulesVersion
      const claimed = readAuthorization(authorization)
      const [total, topRows, playerRows, mineRows] = yield* batch([
        totalStatement(track, rules),
        pageStatement(track, rules, 0, topCount),
        ...(claimed === null ? [] : [playerStatement(claimed.id), myRunStatement(track, rules, claimed.id)])
      ])
      const viewerId = claimed !== null && (yield* proves(playerRows?.[0], claimed.secret)) ? claimed.id : null
      const top = ((topRows ?? []) as ReadonlyArray<RunRow>).map((row, at) => entry(row, at + 1, viewerId))
      const mineRow = viewerId === null ? undefined : (mineRows?.[0] as (RunRow & { rank: number }) | undefined)
      const base = { track, rules, total: totalOf(total), top }
      if (mineRow === undefined) return { ...base, around: [], me: null }
      const me = entry(mineRow, mineRow.rank, viewerId)
      if (mineRow.rank <= topCount) return { ...base, around: [], me }
      // The runs on each side of the player's, leaving out those `top` already shows.
      const from = Math.max(topCount, mineRow.rank - 1 - aroundCount)
      const [rows = []] = yield* batch([pageStatement(track, rules, from, mineRow.rank + aroundCount - from)])
      return { ...base, around: (rows as ReadonlyArray<RunRow>).map((row, at) => entry(row, from + at + 1, viewerId)), me }
    })

  /**
   * Up to `count` runs of a board from rank `from` on, seen by whoever `authorization` proves.
   * `from` and `count` come from the request: `from` is at least 1 and `count` 1 to `pageMax`.
   */
  const page = (track: string, from: number, count: number, authorization: string | undefined): Effect.Effect<BoardPage, NotFound, R> =>
    Effect.gen(function* () {
      if (trackById(track) === undefined) return yield* Effect.fail(notFound)
      const rules = rulesVersion
      const first = Number.isFinite(from) ? Math.max(1, Math.floor(from)) : 1
      const size = Number.isFinite(count) ? Math.max(1, Math.min(pageMax, Math.floor(count))) : pageMax
      const claimed = readAuthorization(authorization)
      const [total, rows, playerRows] = yield* batch([
        totalStatement(track, rules),
        pageStatement(track, rules, first - 1, size),
        ...(claimed === null ? [] : [playerStatement(claimed.id)])
      ])
      const viewerId = claimed !== null && (yield* proves(playerRows?.[0], claimed.secret)) ? claimed.id : null
      const entries = ((rows ?? []) as ReadonlyArray<RunRow>).map((row, at) => entry(row, first + at, viewerId))
      return { track, rules, total: totalOf(total), from: first, entries }
    })

  const rivalStatement = (track: string, rules: number, fasterThanMs: number | null, except: string): Statement => ({
    query: `SELECT ${runColumns}, ${rankColumn} ${fromBoard} AND r.player_id != ? ${fasterThanMs === null ? "" : "AND r.time_ms < ?"}
      ORDER BY r.time_ms DESC, r.posted_at DESC, r.id DESC LIMIT 1`,
    values: fasterThanMs === null ? [track, rules, except] : [track, rules, except, fasterThanMs]
  })

  const rival = (track: string, fasterThanMs: number | null, authorization: string | undefined): Effect.Effect<Entry | null, NotFound, R> =>
    Effect.gen(function* () {
      if (trackById(track) === undefined) return yield* Effect.fail(notFound)
      const rules = rulesVersion
      const claimed = readAuthorization(authorization)
      // Read as if the claim is true; if it is not, ask again as nobody.
      const results = yield* batch(
        claimed === null ? [rivalStatement(track, rules, fasterThanMs, "")] : [playerStatement(claimed.id), rivalStatement(track, rules, fasterThanMs, claimed.id)]
      )
      const playerRows = claimed === null ? undefined : results[0]
      const rivalRows = claimed === null ? results[0] : results[1]
      const viewerId = claimed !== null && (yield* proves(playerRows?.[0], claimed.secret)) ? claimed.id : null
      const rows = claimed !== null && viewerId === null ? (yield* batch([rivalStatement(track, rules, fasterThanMs, "")]))[0] : rivalRows
      const row = rows?.[0] as (RunRow & { rank: number }) | undefined
      return row === undefined ? null : entry(row, row.rank, viewerId)
    })

  const replay = (runId: string): Effect.Effect<RunReplay, NotFound, R> =>
    Effect.gen(function* () {
      const row = yield* one<{ id: string; name: string; time_ms: number; steering: "car" | "screen"; replay: string }>(
        "SELECT r.id, p.name, r.time_ms, r.steering, r.replay FROM runs r JOIN players p ON p.id = r.player_id WHERE r.id = ?",
        [runId]
      )
      if (row === undefined) return yield* Effect.fail(notFound)
      return { runId: row.id, name: row.name, timeMs: row.time_ms, steering: row.steering, replay: row.replay }
    })

  // ── Admin ────────────────────────────────────────────────────────────

  const adminPlayers = (search: string, limit: number) =>
    all<{ id: string; name: string; created_at: number; banned_at: number | null; runs: number }>(
      `SELECT p.id, p.name, p.created_at, p.banned_at, (SELECT COUNT(*) FROM runs r WHERE r.player_id = p.id) AS runs
       FROM players p WHERE p.name LIKE ? ESCAPE '\\' OR p.id = ? ORDER BY p.created_at DESC LIMIT ?`,
      [`%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`, search, limit]
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, banned: row.banned_at !== null, runs: row.runs }))
      )
    )

  const adminRuns = (track: string, rules: number, limit: number) =>
    batch([pageStatement(track, rules, 0, limit)]).pipe(
      Effect.map(([rows = []]) => (rows as ReadonlyArray<RunRow>).map((row, at) => ({ rank: at + 1, runId: row.id, playerId: row.player_id, name: row.name, timeMs: row.time_ms, postedAt: row.posted_at })))
    )

  /** An admin may give a name the game keeps back (a placeholder for a name taken away), never a refused one. */
  const adminRename = (playerId: string, name: string) => setName(playerId, name, true)

  const adminRemoveRun = (runId: string): Effect.Effect<void, NotFound, R> =>
    Effect.flatMap(run("DELETE FROM runs WHERE id = ?", [runId]), (changed) => (changed === 0 ? Effect.fail(notFound) : Effect.void))

  /** The player's identity stops working and their runs go; the name stays taken so it cannot simply be registered again. */
  const adminBan = (playerId: string): Effect.Effect<{ readonly runsRemoved: number }, NotFound, R> =>
    Effect.gen(function* () {
      const changed = yield* run("UPDATE players SET banned_at = COALESCE(banned_at, ?) WHERE id = ?", [now(), playerId])
      if (changed === 0) return yield* Effect.fail(notFound)
      const runsRemoved = yield* run("DELETE FROM runs WHERE player_id = ?", [playerId])
      return { runsRemoved }
    })

  return {
    checkName,
    register,
    authenticate,
    rename,
    submit,
    board,
    page,
    rival,
    replay,
    adminPlayers,
    adminRuns,
    adminRename,
    adminRemoveRun,
    adminBan
  }
}

export type LeaderboardServer<R> = ReturnType<typeof makeLeaderboard<R>>
