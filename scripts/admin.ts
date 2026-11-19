/**
 * The leaderboard's admin, from this machine. Reads the stage's env file (`.env` for local
 * dev, `.env.staging`, `.env.prod`) for `ADMIN_SECRET` (the same value the deploy bound to the
 * Worker) and `API_URL` (the `api` the deploy printed; local dev defaults to
 * http://localhost:1337).
 *
 *   pnpm admin <stage> players [search]          players whose name contains `search`, or with that id
 *   pnpm admin <stage> board [track] [limit]     a board's runs, with run and player ids
 *   pnpm admin <stage> rename <playerId> <name>  gives a player another name (a kept-back one is allowed)
 *   pnpm admin <stage> remove-run <runId>        takes one run off its board
 *   pnpm admin <stage> ban <playerId>            the identity stops working, its runs go, the name stays taken
 *   pnpm admin <stage> fill-sectors              files the sectors of runs sent before the server kept them (once, after deploying them)
 *
 * `<stage>` is `dev`, `staging` or `prod`. See docs/server.md.
 */
import { existsSync } from "node:fs"
import { Effect, Exit } from "effect"
import { makeAdminClient } from "../src/server/admin-client.ts"
import { rulesVersion, tracks } from "../src/sim/index.ts"

const [stage, command, ...rest] = process.argv.slice(2)
const usage = (): never => {
  console.error("usage: pnpm admin <dev|staging|prod> <players [search] | board [track] [limit] | rename <playerId> <name> | remove-run <runId> | ban <playerId> | fill-sectors>")
  process.exit(2)
}
if (stage === undefined || command === undefined || !["dev", "staging", "prod"].includes(stage)) usage()

const envFile = stage === "dev" ? ".env" : `.env.${stage}`
if (existsSync(envFile)) process.loadEnvFile(envFile)
const secret = process.env.ADMIN_SECRET ?? ""
const baseUrl = process.env.API_URL ?? (stage === "dev" ? "http://localhost:1337" : "")
if (secret === "") {
  console.error(`No ADMIN_SECRET in ${envFile}.`)
  process.exit(2)
}
if (baseUrl === "") {
  console.error(`No API_URL in ${envFile}: add the \`api\` URL the deploy printed.`)
  process.exit(2)
}

const headers = { authorization: `Bearer ${secret}` }
const admin = await Effect.runPromise(makeAdminClient(baseUrl))

const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isSuccess(exit)) return exit.value
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  console.error("Failed:", failure?._tag === "Fail" ? JSON.stringify(failure.error) : String(exit.cause))
  process.exit(1)
}

const date = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 16)
const seconds = (ms: number): string => (ms / 1000).toFixed(3)

switch (command) {
  case "players": {
    const players = await run(admin.admin.players({ headers, query: { search: rest[0] ?? "" } }))
    for (const player of players) console.log(`${player.id}  ${player.name.padEnd(16)}  ${player.runs} run(s)  since ${date(player.createdAt)}${player.banned ? "  BANNED" : ""}`)
    console.log(`${players.length} player(s)`)
    break
  }
  case "board": {
    const track = rest[0] ?? tracks[0]?.id ?? ""
    const runs = await run(admin.admin.runs({ headers, params: { track, rules: rulesVersion }, query: { limit: Number(rest[1] ?? 50) } }))
    console.log(`${track}, rules ${rulesVersion}`)
    for (const row of runs) console.log(`${String(row.rank).padStart(4)}  ${seconds(row.timeMs).padStart(8)} s  ${row.name.padEnd(16)}  run ${row.runId}  player ${row.playerId}  ${date(row.postedAt)}`)
    break
  }
  case "rename": {
    const [playerId, ...name] = rest
    if (playerId === undefined || name.length === 0) usage()
    console.log(await run(admin.admin.rename({ headers, params: { playerId: playerId ?? "" }, payload: { name: name.join(" ") } })))
    break
  }
  case "remove-run": {
    if (rest[0] === undefined) usage()
    await run(admin.admin.removeRun({ headers, params: { runId: rest[0] ?? "" } }))
    console.log("removed")
    break
  }
  case "ban": {
    if (rest[0] === undefined) usage()
    console.log(await run(admin.admin.ban({ headers, params: { playerId: rest[0] ?? "" } })))
    break
  }
  case "fill-sectors": {
    // A few runs a request, until none waits (or a pass files nothing new).
    let filled = 0
    let failed = 0
    for (;;) {
      const pass = await run(admin.admin.fillSectors({ headers, query: { limit: 20 } }))
      filled += pass.filled
      failed += pass.failed
      console.log(`filled ${filled}, could not drive ${failed}, ${pass.left} left`)
      if (pass.left === 0 || pass.filled + pass.failed === 0) break
    }
    break
  }
  default:
    usage()
}
