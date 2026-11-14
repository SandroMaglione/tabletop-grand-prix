/**
 * Puts a deployed API under the one expensive request it has: submitting a lap, which drives
 * the replay again. Registers `--players` players, has each submit the real replay
 * `--each` times, `--parallel` at a time, prints every status, and counts the requests the
 * platform killed (Cloudflare answers 503 with error 1102 when a Worker runs out of CPU).
 * With the stage's admin secret it bans the players afterwards so the board stays clean.
 *
 * Read the CPU time of each request alongside, from a live tail (nothing is stored):
 *
 *   pnpm exec alchemy logs --tail --stage staging --profile admin -r Api
 *   node scripts/cpu.ts https://tabletop-grand-prix-api-staging.<account>.workers.dev --env .env.staging
 *
 * Stays within the server's own rate limits by default (5 players x 6 submits in a minute).
 */
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: "string" },
    players: { type: "string", default: "5" },
    each: { type: "string", default: "6" },
    parallel: { type: "string", default: "3" }
  }
})
const baseUrl = positionals[0]?.replace(/\/$/, "")
if (baseUrl === undefined) {
  console.error("usage: node scripts/cpu.ts <api url> [--env .env.staging] [--players 5] [--each 6] [--parallel 3]")
  process.exit(2)
}
if (values.env !== undefined) process.loadEnvFile(values.env)
const kept = JSON.parse(readFileSync(new URL("../test/replays/spindle-leap.json", import.meta.url), "utf8")) as { replay: string }

const post = (path: string, body: unknown, authorization?: string) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) },
    body: JSON.stringify(body)
  })

const players: Array<{ id: string; token: string }> = []
for (let at = 0; at < Number(values.players); at++) {
  const response = await post("/players", { name: `Cpu-${Math.random().toString(16).slice(2, 8)}` })
  if (!response.ok) {
    console.log(`register: ${response.status} ${await response.text()}`)
    continue
  }
  const identity = (await response.json()) as { id: string; secret: string }
  players.push({ id: identity.id, token: `Bearer ${identity.id}.${identity.secret}` })
}

const jobs = players.flatMap((player) => Array.from({ length: Number(values.each) }, () => player))
const statuses = new Map<string, number>()
let killed = 0
const walls: Array<number> = []
const worker = async (): Promise<void> => {
  for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
    const started = performance.now()
    const response = await post("/runs", { replay: kept.replay }, job.token)
    const wall = Math.round(performance.now() - started)
    const text = await response.text()
    const killedHere = response.status === 503 || /1102|exceeded/i.test(text.slice(0, 2000))
    if (killedHere) killed++
    walls.push(wall)
    const key = `${response.status}${killedHere ? " (killed)" : ""}`
    statuses.set(key, (statuses.get(key) ?? 0) + 1)
    console.log(`${response.status} ${wall} ms ${killedHere ? "KILLED" : text.slice(0, 80)}`)
  }
}
await Promise.all(Array.from({ length: Number(values.parallel) }, worker))

walls.sort((a, b) => a - b)
console.log(`\n${walls.length} submits: ${[...statuses].map(([status, count]) => `${count} x ${status}`).join(", ")}; killed ${killed}`)
console.log(`wall ms: median ${walls[Math.floor(walls.length / 2)] ?? "-"}, max ${walls.at(-1) ?? "-"}`)

const secret = process.env.ADMIN_SECRET
if (secret !== undefined && secret !== "") {
  for (const player of players) await post(`/admin/players/${player.id}/ban`, {}, `Bearer ${secret}`)
  console.log(`banned the ${players.length} players made here`)
}
