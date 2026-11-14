/**
 * Drive laps with the bot, headless, and print what happened.
 *
 *   node scripts/bot.ts [fixture|track] [variant] [--trace]
 *
 * For each variant (or the one named): the lap time and splits, resets, wall hits, the
 * take-offs and landings, props, posts and doors hit. `--trace` prints the car twice a second.
 * Ends with suggested medal times from the bot's best lap. Exits 1 when the bot cannot
 * finish a lap within 90 simulated seconds.
 */
import { botInput } from "../src/sim/bot.ts"
import { createSession, fixtureTrack, track as mainTrack } from "../src/sim/index.ts"
import type { RaceEvent, TrackData } from "../src/sim/index.ts"
import { STEERINGS as variantNames, isSteering as isVariant } from "../src/sim/schema.ts"
import type { Steering as VariantName } from "../src/sim/schema.ts"

const args = process.argv.slice(2)
const trace = args.includes("--trace")
const [which = "track", only] = args.filter((arg) => !arg.startsWith("--"))
const track: TrackData = which === "fixture" ? fixtureTrack : mainTrack
if (only !== undefined && !isVariant(only)) {
  console.error(`No variant ${only}; the variants are ${variantNames.join(", ")}`)
  process.exit(2)
}
const chosen: ReadonlyArray<VariantName> = only === undefined ? variantNames : [only]

const seconds = (ms: number): string => (ms / 1000).toFixed(3)
const at = (s: number): string => `s=${s.toFixed(1)}`

interface Run {
  readonly variant: VariantName
  readonly timeMs: number | null
}

const drive = (variant: VariantName): Run => {
  const session = createSession(track)
  session.setVariant(variant)
  const limit = 90 * session.hz
  const counts = { wall: 0, reset: 0, prop: 0, post: 0, door: 0 }
  const notes: Array<string> = []
  let finish: Extract<RaceEvent, { kind: "finish" }> | null = null
  for (let tick = 0; tick < limit && finish === null; tick++) {
    const before = session.view()
    session.tick(botInput(before, track))
    const view = session.view()
    if (trace && tick % (session.hz / 2) === 0) {
      notes.push(`  t=${(tick / session.hz).toFixed(1)} ${at(view.car.s)} speed=${view.car.speed.toFixed(1)} y=${view.car.y.toFixed(2)} slip=${view.car.slip.toFixed(2)} ${view.car.grounded ? "" : "air"}`)
    }
    for (const event of session.drainEvents()) {
      switch (event.kind) {
        case "wall":
          counts.wall++
          if (event.impact > 2) notes.push(`  wall ${event.side} impact ${event.impact.toFixed(1)} at ${at(view.car.s)}`)
          break
        case "reset":
          counts.reset++
          notes.push(`  reset (${event.reason}) at x=${event.x.toFixed(1)} y=${event.y.toFixed(2)} z=${event.z.toFixed(1)}, ${at(before.car.s)}`)
          break
        case "takeoff":
          notes.push(`  takeoff at ${at(view.car.s)} speed ${event.speed.toFixed(1)} m/s, y=${event.y.toFixed(2)}`)
          break
        case "land":
          notes.push(`  land at ${at(view.car.s)} impact ${event.impact.toFixed(1)} m/s, y=${event.y.toFixed(2)}`)
          break
        case "prop":
          counts.prop++
          notes.push(`  hit a ${event.prop} at ${event.impact.toFixed(1)} m/s, ${at(view.car.s)}`)
          break
        case "bollard":
          counts.post++
          notes.push(`  hit a post at ${event.impact.toFixed(1)} m/s, ${at(view.car.s)}`)
          break
        case "door":
          counts.door++
          notes.push(`  door ${event.index} at ${event.impact.toFixed(1)} m/s, speed after ${view.car.speed.toFixed(1)}`)
          break
        case "knock":
          break
        case "checkpoint":
          notes.push(`  checkpoint ${event.index} at ${seconds(event.timeMs)} s`)
          break
        case "finish":
          finish = event
          break
        case "boost":
        case "start":
          break
      }
    }
  }
  const timeMs: number | null = finish === null ? null : (finish as Extract<RaceEvent, { kind: "finish" }>).timeMs
  console.log(`${variant}: ${timeMs === null ? "no lap in 90 s" : `${seconds(timeMs)} s`}  resets ${counts.reset}, wall hits ${counts.wall}, props hit ${counts.prop}, posts hit ${counts.post}, door leaves pushed ${counts.door}`)
  for (const note of notes) console.log(note)
  return { variant, timeMs }
}

console.log(`${track.name}: ${track.length.toFixed(1)} m, checkpoints at ${track.checkpoints.map((s) => s.toFixed(1)).join(", ")}`)
const runs = chosen.map(drive)
const times = runs.flatMap((run) => (run.timeMs === null ? [] : [run.timeMs]))
if (times.length > 0) {
  const best = Math.min(...times)
  const round = (ms: number): number => Math.ceil(ms / 100) * 100
  console.log(`suggested medals (from the bot's best, ${seconds(best)} s): gold ${seconds(round(best * 1.04))}, silver ${seconds(round(best * 1.15))}, bronze ${seconds(round(best * 1.3))}`)
  console.log(`the track's medals now: gold ${seconds(track.medals.gold)}, silver ${seconds(track.medals.silver)}, bronze ${seconds(track.medals.bronze)}`)
}
if (runs.some((run) => run.timeMs === null)) process.exit(1)
