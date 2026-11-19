/**
 * Exercises a running leaderboard end to end over HTTP, through the game's own client
 * (`layerHttp`): register, refuse a taken and a blocked name, submit the real replay, read the
 * board, fetch the rival and the replay, rename. With the stage's admin secret it also lists,
 * then bans the players it made, so the board is left as it was.
 *
 *   node scripts/e2e.ts http://localhost:1337 --env .env
 *   node scripts/e2e.ts https://tabletop-grand-prix-api-staging.<account>.workers.dev --env .env.staging --submits 8
 *
 * `--submits N` sends the replay N times (all after the first are `improved: false`) and
 * prints how long each took, to look for requests the platform killed. Exits 1 on any miss.
 */
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { Effect, Exit } from "effect"
import { Leaderboard } from "../src/api/contract.ts"
import { layerHttp } from "../src/api/http.ts"
import { makeAdminClient } from "../src/server/admin-client.ts"

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { env: { type: "string" }, submits: { type: "string", default: "3" } }
})
const baseUrl = positionals[0]?.replace(/\/$/, "")
if (baseUrl === undefined) {
  console.error("usage: node scripts/e2e.ts <api url> [--env <file with ADMIN_SECRET>] [--submits N]")
  process.exit(2)
}
if (values.env !== undefined) process.loadEnvFile(values.env)
const adminSecret = process.env.ADMIN_SECRET
const submits = Math.max(1, Number(values.submits))

const kept = JSON.parse(readFileSync(new URL("../test/replays/spindle-leap.json", import.meta.url), "utf8")) as { track: string; timeMs: number; replay: string }

let misses = 0
const check = (ok: boolean, what: string, detail: unknown = ""): void => {
  console.log(`${ok ? "ok  " : "MISS"} ${what}${detail === "" ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`)
  if (!ok) misses++
}

const layer = layerHttp(baseUrl)
const call = <A, E>(f: (service: Leaderboard["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.exit(Effect.provide(Effect.flatMap(Effect.service(Leaderboard), f), layer)))
const failureOf = <A, E>(exit: Exit.Exit<A, E>): unknown => (Exit.isFailure(exit) ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as { error?: unknown } | undefined)?.error ?? String(exit.cause) : null)

// Hex folds to letters too, so an unlucky suffix could spell something: try again then.
const suffix = (): string => Math.random().toString(16).slice(2, 8)
const name = `E2E-${suffix()}`
const rivalName = `E2E-${suffix()}`

const me = await call((service) => service.register(name))
check(Exit.isSuccess(me), `register ${name}`, failureOf(me))
if (Exit.isFailure(me)) process.exit(1)
const identity = me.value

const taken = await call((service) => service.register(name.toLowerCase().replace("e", "3")))
check(JSON.stringify(failureOf(taken)) === JSON.stringify({ _tag: "NameTaken" }), "a name that reads the same is taken", failureOf(taken))
const checked = await call((service) => service.checkName(name.toUpperCase()))
check(JSON.stringify(failureOf(checked)) === JSON.stringify({ _tag: "NameTaken" }), "checkName says the same", failureOf(checked))
const blocked = await call((service) => service.register("st0nz0 cazzo"))
check(JSON.stringify(failureOf(blocked)) === JSON.stringify({ _tag: "NameRefused", reason: "blocked" }), "a blocked name is refused", failureOf(blocked))

let firstRun = ""
for (let at = 0; at < submits; at++) {
  const started = performance.now()
  const submitted = await call((service) => service.submit(identity, kept.replay))
  const ms = Math.round(performance.now() - started)
  if (Exit.isFailure(submitted)) {
    check(false, `submit ${at + 1}/${submits} (${ms} ms)`, failureOf(submitted))
    continue
  }
  const result = submitted.value
  if (at === 0) firstRun = result.runId
  const expected = at === 0
  check(result.timeMs === Math.floor(kept.timeMs) && result.improved === expected, `submit ${at + 1}/${submits} (${ms} ms)`, result)
}

const board = await call((service) => service.board(kept.track, identity, null))
check(Exit.isSuccess(board) && board.value.me?.runId === firstRun && board.value.me.mine, "the board shows my run", Exit.isSuccess(board) ? { total: board.value.total, me: board.value.me } : failureOf(board))

// A second player with the same lap, posted later, ranks just behind and is my rival.
const other = await call((service) => service.register(rivalName))
check(Exit.isSuccess(other), `register ${rivalName}`, failureOf(other))
if (Exit.isSuccess(other)) {
  const otherRun = await call((service) => service.submit(other.value, kept.replay))
  check(Exit.isSuccess(otherRun), "the second player submits", failureOf(otherRun))
  const rival = await call((service) => service.rival(kept.track, null, identity))
  check(Exit.isSuccess(rival) && rival.value !== null && !rival.value.mine, "a rival to chase, never my own run", Exit.isSuccess(rival) ? rival.value : failureOf(rival))
  const theirs = await call((service) => service.rival(kept.track, kept.timeMs + 1, other.value))
  check(Exit.isSuccess(theirs) && theirs.value !== null && theirs.value.name === name, "the second player chases me", Exit.isSuccess(theirs) ? theirs.value : failureOf(theirs))
}

const replay = await call((service) => service.replay(firstRun))
check(Exit.isSuccess(replay) && replay.value.replay === kept.replay && replay.value.name === name, "my replay comes back as sent", Exit.isSuccess(replay) ? { ...replay.value, replay: `${replay.value.replay.length} chars` } : failureOf(replay))

const renamedTo = `E2E-${suffix()}`
const renamed = await call((service) => service.rename(identity, renamedTo))
check(Exit.isSuccess(renamed) && renamed.value.name === renamedTo, `rename to ${renamedTo}`, failureOf(renamed))
const after = await call((service) => service.replay(firstRun))
check(Exit.isSuccess(after) && after.value.name === renamedTo, "the run keeps its place under the new name", Exit.isSuccess(after) ? after.value.name : failureOf(after))

if (adminSecret === undefined || adminSecret === "") {
  console.log("(no ADMIN_SECRET: the players made here stay on the board)")
} else {
  const admin = await Effect.runPromise(makeAdminClient(baseUrl))
  const headers = { authorization: `Bearer ${adminSecret}` }
  const listed = await Effect.runPromise(Effect.exit(admin.admin.players({ headers, query: { search: "E2E-" } })))
  check(Exit.isSuccess(listed) && listed.value.some((player) => player.id === identity.id), "the admin lists the players", failureOf(listed))
  for (const id of [identity.id, Exit.isSuccess(other) ? other.value.id : null]) {
    if (id === null) continue
    const banned = await Effect.runPromise(Effect.exit(admin.admin.ban({ headers, params: { playerId: id } })))
    check(Exit.isSuccess(banned), `the admin bans ${id}`, Exit.isSuccess(banned) ? banned.value : failureOf(banned))
  }
  const gone = await call((service) => service.submit(identity, kept.replay))
  check(JSON.stringify(failureOf(gone)) === JSON.stringify({ _tag: "Unauthorised" }), "a banned identity no longer works", failureOf(gone))
}

console.log(misses === 0 ? "\nall good" : `\n${misses} missed`)
process.exit(misses === 0 ? 0 : 1)
