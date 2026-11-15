/**
 * The server, whole: the Worker's routes and handlers answering in memory on SQLite with the
 * real migrations, asked through the game's own client (`layerHttp`), so the HTTP definition,
 * the handlers, the SQL and the client's mapping of failures are all under test.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { Effect, Exit, Redacted } from "effect"
import * as HttpRouter from "effect/http/HttpRouter"
import { type Identity, Leaderboard } from "../src/api/contract.ts"
import { authorization, layerHttp } from "../src/api/http.ts"
import { makeAdminClient } from "../src/server/admin-client.ts"
import { serverLayer } from "../src/server/api.ts"
import { makeLeaderboard, maxReplayText } from "../src/server/leaderboard.ts"
import type { Limiter } from "../src/server/limits.ts"
import type { Sql } from "../src/server/sql.ts"
import { decodeReplay, replayFromText, replayToText, rulesVersion } from "../src/sim/index.ts"
import { encodeReplay } from "../src/sim/replay.ts"
import { memorySql } from "./sqlite.ts"

const kept = JSON.parse(readFileSync(new URL("./replays/spindle-leap.json", import.meta.url), "utf8")) as { track: string; timeMs: number; replay: string }
const track = kept.track
const adminSecret = "test-admin-secret-0123456789abcdef"

interface Server {
  readonly call: <A, E>(effect: Effect.Effect<A, E, Leaderboard>) => Promise<Exit.Exit<A, E>>
  readonly ok: <A, E>(effect: Effect.Effect<A, E, Leaderboard>) => Promise<A>
  readonly fail: <A, E>(effect: Effect.Effect<A, E, Leaderboard>) => Promise<E>
  readonly fetch: typeof globalThis.fetch
  /** Puts a player with a run straight into the database, for boards bigger than one real lap can fill. */
  readonly seed: (name: string, timeMs: number, postedAt?: number) => string
  readonly setClock: (ms: number) => void
}

const serve = (options: { readonly limiter?: Limiter; readonly sql?: Sql } = {}): Server => {
  const memory = memorySql()
  let clock = 1_000_000
  const leaderboard = makeLeaderboard(options.sql ?? memory.sql, { now: () => clock++ })
  const app = serverLayer({
    leaderboard,
    limiter: options.limiter ?? (() => Effect.succeed(true)),
    adminSecret: Redacted.make(adminSecret),
    allowedOrigins: ["https://site.example", "http://localhost:5380"]
  })
  const { handler } = HttpRouter.toWebHandler(app, { disableLogger: true })
  const fetch: typeof globalThis.fetch = (input, init) => handler(new Request(input, init))
  const layer = layerHttp("http://leaderboard.test", { fetch })
  const call = <A, E>(effect: Effect.Effect<A, E, Leaderboard>) => Effect.runPromise(Effect.exit(Effect.provide(effect, layer)))
  let seeded = 0
  return {
    call,
    fetch,
    ok: async (effect) => {
      const exit = await call(effect)
      if (Exit.isFailure(exit)) assert.fail(`expected success, got ${JSON.stringify(exit.cause)}`)
      return exit.value
    },
    fail: async (effect) => {
      const exit = await call(effect)
      if (Exit.isSuccess(exit)) assert.fail(`expected failure, got ${JSON.stringify(exit.value)}`)
      const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      assert.ok(error !== undefined && error._tag === "Fail", `expected a failure, got ${String(exit.cause)}`)
      return error.error
    },
    seed: (name, timeMs, postedAt) => {
      seeded++
      const playerId = `seed-player-${seeded}`
      memory.db.prepare("INSERT INTO players (id, name, folded, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(playerId, name, `seed${seeded}`, "x", 0)
      memory.db
        .prepare("INSERT INTO runs (id, player_id, track, rules, time_ms, steering, replay, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(`seed-run-${seeded}`, playerId, track, rulesVersion, timeMs, "car", kept.replay, postedAt ?? seeded)
      return `seed-run-${seeded}`
    },
    setClock: (ms) => {
      clock = ms
    }
  }
}

const lb = Effect.service(Leaderboard)
const register = (name: string) => Effect.flatMap(lb, (service) => service.register(name))

test("a device registers a name, and a name that reads the same is taken", async () => {
  const server = serve()
  const me = await server.ok(register("  Sandro "))
  assert.equal(me.name, "Sandro")
  assert.ok(me.id.length > 0 && me.secret.length >= 40)
  for (const same of ["s4ndr0", "S a n d r o", "SANDRO"]) {
    assert.deepEqual(await server.fail(register(same)), { _tag: "NameTaken" })
    assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.checkName(same))), { _tag: "NameTaken" })
  }
  assert.deepEqual(await server.fail(register("cazzo")), { _tag: "NameRefused", reason: "blocked" })
  assert.deepEqual(await server.fail(register("admin")), { _tag: "NameRefused", reason: "reserved" })
  assert.deepEqual(await server.fail(register("x")), { _tag: "NameRefused", reason: "length" })
  assert.deepEqual(await server.fail(register("a!b!c")), { _tag: "NameRefused", reason: "characters" })
  await server.ok(Effect.flatMap(lb, (service) => service.checkName("Giulia")))
})

test("a run is filed at the time the server drives it to, and only a faster one replaces it", async () => {
  const server = serve()
  const me = await server.ok(register("Sandro"))
  const first = await server.ok(Effect.flatMap(lb, (service) => service.submit(me, kept.replay)))
  assert.deepEqual({ ...first, runId: "" }, { runId: "", timeMs: Math.floor(kept.timeMs), improved: true, rank: 1, total: 1 })
  const again = await server.ok(Effect.flatMap(lb, (service) => service.submit(me, kept.replay)))
  assert.equal(again.improved, false, "an equal time is not an improvement")
  assert.equal(again.runId, first.runId, "the run that stays is the first one")

  const stored = await server.ok(Effect.flatMap(lb, (service) => service.replay(first.runId)))
  assert.deepEqual(stored, { runId: first.runId, name: "Sandro", timeMs: Math.floor(kept.timeMs), steering: "car", replay: kept.replay })

  // The replay is the truth: its time cannot be claimed, and a damaged one is refused with the fault.
  const bytes = replayFromText(kept.replay)
  assert.ok(bytes !== null)
  const read = decodeReplay(bytes)
  assert.ok(read !== null)
  const refusedWith = async (text: string) => server.fail(Effect.flatMap(lb, (service) => service.submit(me, text)))
  assert.deepEqual(await refusedWith("not base64 !"), { _tag: "RunRefused", fault: "unreadable" })
  assert.deepEqual(await refusedWith(replayToText(bytes.subarray(0, bytes.length - 6))), { _tag: "RunRefused", fault: "unreadable" })
  assert.deepEqual(await refusedWith(replayToText(encodeReplay({ ...read, track: "nowhere" }))), { _tag: "RunRefused", fault: "unknown-track" })
  assert.deepEqual(await refusedWith(replayToText(encodeReplay({ ...read, rules: rulesVersion + 1 }))), { _tag: "RunRefused", fault: "other-rules" })
  assert.deepEqual(await refusedWith(replayToText(encodeReplay({ ...read, inputs: read.inputs.subarray(0, read.inputs.length - 400) }))), {
    _tag: "RunRefused",
    fault: "unfinished"
  })
  assert.deepEqual(await refusedWith("A".repeat(maxReplayText + 1)), { _tag: "RunRefused", fault: "too-large" })
})

test("a slower run is not kept, a faster one replaces the best and moves up", async () => {
  const server = serve()
  const me = await server.ok(register("Sandro"))
  server.seed("Quick", Math.floor(kept.timeMs) - 500)
  const slowRun = server.seed("Slow", Math.floor(kept.timeMs) + 500)
  const filed = await server.ok(Effect.flatMap(lb, (service) => service.submit(me, kept.replay)))
  assert.deepEqual([filed.improved, filed.rank, filed.total], [true, 2, 3])
  const board = await server.ok(Effect.flatMap(lb, (service) => service.board(track, me)))
  assert.deepEqual(
    board.top.map((entry) => [entry.rank, entry.name, entry.mine]),
    [
      [1, "Quick", false],
      [2, "Sandro", true],
      [3, "Slow", false]
    ]
  )
  assert.equal(board.me?.runId, filed.runId)
  assert.deepEqual(board.around, [])
  assert.equal(board.top[2]?.runId, slowRun)
})

test("ties rank by who posted first", async () => {
  const server = serve()
  server.seed("Second", 20_000, 200)
  server.seed("First", 20_000, 100)
  server.seed("Fastest", 19_999, 300)
  const board = await server.ok(Effect.flatMap(lb, (service) => service.board(track, null)))
  assert.deepEqual(
    board.top.map((entry) => entry.name),
    ["Fastest", "First", "Second"]
  )
  assert.equal(board.me, null)
})

test("a board shows the top ten, and the asking player's run with two each side", async () => {
  const server = serve()
  const me = await server.ok(register("Sandro"))
  const mine = Math.floor(kept.timeMs)
  // Fourteen runs ahead of mine, six behind: mine ranks 15 of 21.
  for (let at = 0; at < 14; at++) server.seed(`Ahead${at}`, mine - 1000 + at)
  for (let at = 0; at < 6; at++) server.seed(`Behind${at}`, mine + 1 + at)
  await server.ok(Effect.flatMap(lb, (service) => service.submit(me, kept.replay)))
  const board = await server.ok(Effect.flatMap(lb, (service) => service.board(track, me)))
  assert.equal(board.total, 21)
  assert.equal(board.rules, rulesVersion)
  assert.deepEqual(
    board.top.map((entry) => entry.rank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  )
  assert.deepEqual(
    board.around.map((entry) => [entry.rank, entry.name]),
    [
      [13, "Ahead12"],
      [14, "Ahead13"],
      [15, "Sandro"],
      [16, "Behind0"],
      [17, "Behind1"]
    ]
  )
  assert.equal(board.me?.rank, 15)
  assert.ok(board.around.find((entry) => entry.mine)?.name === "Sandro")
  // Seen by nobody, the same board has no `me` and no `around`.
  const anonymous = await server.ok(Effect.flatMap(lb, (service) => service.board(track, null)))
  assert.deepEqual([anonymous.me, anonymous.around, anonymous.total], [null, [], 21])
})

test("just under the top ten, `around` leaves out what `top` already shows", async () => {
  const server = serve()
  const me = await server.ok(register("Sandro"))
  const mine = Math.floor(kept.timeMs)
  for (let at = 0; at < 10; at++) server.seed(`Ahead${at}`, mine - 100 + at)
  for (let at = 0; at < 5; at++) server.seed(`Behind${at}`, mine + 1 + at)
  await server.ok(Effect.flatMap(lb, (service) => service.submit(me, kept.replay)))
  const board = await server.ok(Effect.flatMap(lb, (service) => service.board(track, me)))
  assert.deepEqual(
    board.around.map((entry) => entry.rank),
    [11, 12, 13]
  )
})

test("the rival is the slowest run still ahead, never the player's own", async () => {
  const server = serve()
  const me = await server.ok(register("Sandro"))
  const rival = (fasterThanMs: number | null, identity: Identity | null) => Effect.flatMap(lb, (service) => service.rival(track, fasterThanMs, identity))
  assert.equal(await server.ok(rival(null, null)), null, "an empty board has nobody to chase")
  // Mine is the kept lap, 21977: third on this board.
  server.seed("Pro", 20_000)
  server.seed("Club", 21_500)
  server.seed("Rookie", 30_000)
  await server.ok(Effect.flatMap(lb, (service) => service.submit(me, kept.replay)))
  assert.equal((await server.ok(rival(null, me)))?.name, "Rookie", "with no lap yet, the slowest run on the board")
  assert.equal((await server.ok(rival(25_000, me)))?.name, "Club")
  assert.deepEqual(
    await server.ok(rival(21_500.5, me)).then((entry) => [entry?.name, entry?.rank, entry?.mine]),
    ["Club", 2, false]
  )
  assert.equal((await server.ok(rival(21_000, me)))?.name, "Pro")
  assert.equal(await server.ok(rival(20_000, me)), null, "nobody is ahead of the fastest")
  // Mine is never offered, even when it is the one just ahead.
  assert.equal((await server.ok(rival(22_100, me)))?.name, "Club")
  assert.equal((await server.ok(rival(22_100, null)))?.name, "Sandro")
})

test("unknown tracks and runs are not found", async () => {
  const server = serve()
  assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.board("nowhere", null))), { _tag: "NotFound" })
  assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.rival("nowhere", null, null))), { _tag: "NotFound" })
  assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.replay("nope"))), { _tag: "NotFound" })
})

test("a rename keeps the player's runs, and only the device with the secret can do it", async () => {
  const server = serve()
  const me = await server.ok(register("Sandro"))
  const other = await server.ok(register("Giulia"))
  const filed = await server.ok(Effect.flatMap(lb, (service) => service.submit(me, kept.replay)))
  const renamed = await server.ok(Effect.flatMap(lb, (service) => service.rename(me, "Lap King")))
  assert.deepEqual(renamed, { ...me, name: "Lap King" })
  assert.equal((await server.ok(Effect.flatMap(lb, (service) => service.replay(filed.runId)))).name, "Lap King")
  // The old name is free again; a name that reads like another player's is not.
  assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.rename(renamed, "G1ul1a"))), { _tag: "NameTaken" })
  await server.ok(Effect.flatMap(lb, (service) => service.checkName("Sandro")))
  // A player may change how their own name is written.
  assert.equal((await server.ok(Effect.flatMap(lb, (service) => service.rename(renamed, "LAP KING")))).name, "LAP KING")
  const forged = { ...me, secret: other.secret }
  assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.rename(forged, "Thief"))), { _tag: "Unauthorised" })
  assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.submit(forged, kept.replay))), { _tag: "Unauthorised" })
  // A bad identity on a read is the same as none.
  const board = await server.ok(Effect.flatMap(lb, (service) => service.board(track, forged)))
  assert.equal(board.me, null)
})

test("over the limit, requests are refused with how long to wait", async () => {
  let allowed = 2
  const server = serve({ limiter: () => Effect.succeed(allowed-- > 0) })
  await server.ok(Effect.flatMap(lb, (service) => service.checkName("Giulia")))
  await server.ok(Effect.flatMap(lb, (service) => service.checkName("Giulia")))
  assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.checkName("Giulia"))), { _tag: "RateLimited", retryAfterSeconds: 10 })
  assert.deepEqual(await server.fail(register("Giulia")), { _tag: "RateLimited", retryAfterSeconds: 60 })
})

test("every failure the contract does not name reaches the game as Unavailable", async () => {
  const down = () => Effect.die(new Error("database down"))
  const broken: Sql = { all: down, run: down, batch: down }
  const server = serve({ sql: broken })
  assert.deepEqual(await server.fail(register("Sandro")), { _tag: "Unavailable" })
  assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.board(track, null))), { _tag: "Unavailable" })
  const offline = layerHttp("http://leaderboard.test", { fetch: () => Promise.reject(new TypeError("Failed to fetch")) })
  const failureOf = async (layer: typeof offline) => {
    const exit = await Effect.runPromise(Effect.exit(Effect.provide(register("Sandro"), layer)))
    return Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : null
  }
  assert.deepEqual(await failureOf(offline), { _tag: "Unavailable" })
  const garbage = layerHttp("http://leaderboard.test", { fetch: () => Promise.resolve(new Response("<html>oops</html>", { status: 502 })) })
  assert.deepEqual(await failureOf(garbage), { _tag: "Unavailable" })
})

test("the browser may call from the site and from local dev", async () => {
  const server = serve()
  const preflight = await server.fetch("http://leaderboard.test/runs", {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:5380", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" }
  })
  assert.ok(preflight.status < 300)
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:5380")
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/i)
  const stranger = await server.fetch("http://leaderboard.test/boards/spindle-leap", { headers: { Origin: "https://elsewhere.example" } })
  assert.notEqual(stranger.headers.get("access-control-allow-origin"), "https://elsewhere.example")
  const site = await server.fetch("http://leaderboard.test/boards/spindle-leap", { headers: { Origin: "https://site.example" } })
  assert.equal(site.headers.get("access-control-allow-origin"), "https://site.example")
})

test("the admin lists, renames, removes a run and bans, and nobody else can", async () => {
  const server = serve()
  const me = await server.ok(register("Sandro"))
  const other = await server.ok(register("Giulia"))
  const filed = await server.ok(Effect.flatMap(lb, (service) => service.submit(me, kept.replay)))
  const otherRun = await server.ok(Effect.flatMap(lb, (service) => service.submit(other, kept.replay)))
  const admin = await Effect.runPromise(makeAdminClient("http://leaderboard.test", server.fetch))
  const asAdmin = { authorization: `Bearer ${adminSecret}` }
  const runAdmin = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect))

  for (const headers of [{ authorization: "Bearer wrong" }, { authorization: authorization(me) }]) {
    const refused = await runAdmin(admin.admin.players({ headers, query: {} }))
    assert.ok(Exit.isFailure(refused) && refused.cause.reasons[0]?._tag === "Fail" && refused.cause.reasons[0].error._tag === "Unauthorised")
  }

  const players = await Effect.runPromise(admin.admin.players({ headers: asAdmin, query: { search: "and" } }))
  assert.deepEqual(
    players.map((player) => [player.id, player.name, player.runs, player.banned]),
    [[me.id, "Sandro", 1, false]]
  )
  const runs = await Effect.runPromise(admin.admin.runs({ headers: asAdmin, params: { track, rules: rulesVersion }, query: {} }))
  assert.deepEqual(
    runs.map((row) => row.runId),
    [filed.runId, otherRun.runId]
  )

  // An admin may hand out a placeholder name the game keeps back, never a refused one.
  assert.deepEqual(await Effect.runPromise(admin.admin.rename({ headers: asAdmin, params: { playerId: other.id }, payload: { name: "Player 7" } })), { name: "Player 7" })
  const blocked = await runAdmin(admin.admin.rename({ headers: asAdmin, params: { playerId: other.id }, payload: { name: "stronzo" } }))
  assert.ok(Exit.isFailure(blocked))

  await Effect.runPromise(admin.admin.removeRun({ headers: asAdmin, params: { runId: otherRun.runId } }))
  assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.replay(otherRun.runId))), { _tag: "NotFound" })

  assert.deepEqual(await Effect.runPromise(admin.admin.ban({ headers: asAdmin, params: { playerId: me.id } })), { runsRemoved: 1 })
  assert.deepEqual(await server.fail(Effect.flatMap(lb, (service) => service.submit(me, kept.replay))), { _tag: "Unauthorised" })
  assert.deepEqual(await server.fail(register("Sandro")), { _tag: "NameTaken" }, "a banned name stays taken")
  assert.equal((await server.ok(Effect.flatMap(lb, (service) => service.board(track, null)))).total, 0)
})
