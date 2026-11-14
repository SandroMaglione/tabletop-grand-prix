/**
 * Clumsy drivers, to measure how forgiving the handling is.
 *   node scripts/novice.ts [key=value ...]   (overrides on the base handling)
 * Each driver steers all-or-nothing (a keyboard) toward a point ahead, a little late.
 * - flat: never lifts.
 * - lifter: lets go of the throttle when the road ahead points well away from the nose.
 * - braker: also brakes when fast and the road ahead bends.
 */
import { botInput } from "../src/sim/bot.ts"
import { createSession, track } from "../src/sim/index.ts"
import { angleDelta, indexAt, locateNear, pointAt } from "../src/sim/track/query.ts"
import { variants } from "../src/sim/tuning.ts"
import type { DriveInput, RaceView } from "../src/sim/index.ts"

for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split("=")
  if (key === undefined || value === undefined) continue
  for (const name of ["car", "car-loose", "screen"] as const) (variants[name] as unknown as Record<string, number>)[key] = Number(value)
}

type Kind = "flat" | "lifter" | "braker" | "screen" | "stick" | "lead"
const delayTicks = 18 // 150 ms

const novice = (kind: Kind) => (view: RaceView): DriveInput => {
  const { car } = view
  const here = locateNear(track, car.x, car.z, indexAt(track, car.s), 32)
  const speed = Math.max(0, car.speed)
  const look = 5 + 0.35 * speed
  const point = pointAt(track, here.s + look, 0)
  const dx = point.x - car.x
  const dz = point.z - car.z
  const error = angleDelta(car.yaw, Math.atan2(dx, dz))
  const steer = Math.abs(error) < 0.07 ? 0 : Math.sign(error)
  if (kind === "stick") return { throttle: 1, brake: 0, steer: 0, aim: { x: dx, z: dz }, restart: false }
  if (kind === "lead") {
    // Holds the one of eight directions nearest to where the road goes further on.
    const far = pointAt(track, here.s + look * 1.5, 0)
    const angle = Math.round(Math.atan2(far.x - car.x, far.z - car.z) / (Math.PI / 4)) * (Math.PI / 4)
    return { throttle: 1, brake: 0, steer: 0, aim: { x: Math.sin(angle), z: Math.cos(angle) }, restart: false }
  }
  if (kind === "screen") {
    // Eight directions on the ground stand in for eight on screen.
    // Between two of them a player taps the second key: part of the time on each.
    const exact = Math.atan2(dx, dz) / (Math.PI / 4)
    const low = Math.floor(exact)
    const part = exact - low
    const angle = (part < 0.15 ? low : part > 0.85 ? low + 1 : (view.tick % 24) / 24 < part ? low + 1 : low) * (Math.PI / 4)
    return { throttle: 1, brake: 0, steer: 0, aim: { x: Math.sin(angle), z: Math.cos(angle) }, restart: false }
  }
  let throttle = 1
  let brake = 0
  if (kind !== "flat" && Math.abs(error) > 0.45) throttle = 0
  if (kind === "braker") {
    const far = pointAt(track, here.s + 14 + 0.5 * speed, 0)
    const bend = Math.abs(angleDelta(here.yaw, far.yaw))
    if (bend > 0.7 && speed > 20) { throttle = 0; brake = 1 }
  }
  return { throttle, brake, steer, aim: null, restart: false }
}

const run = (name: string, variant: string, driver: (view: RaceView) => DriveInput): void => {
  const session = createSession(track)
  session.setVariant(variant)
  const queue: Array<DriveInput> = []
  let walls = 0, hard = 0, resets = 0, impact = 0, things = "", time: number | null = null, maxSpeed = 0, jumpSpeed = 0
  const where: Array<string> = []
  for (let tick = 0; tick < 120 * session.hz && time === null; tick++) {
    const view = session.view()
    queue.push(driver(view))
    const input = name === "bot" ? queue.pop()! : queue.length > delayTicks ? queue.shift()! : { throttle: 1, brake: 0, steer: 0, aim: null, restart: false }
    session.tick(input)
    maxSpeed = Math.max(maxSpeed, view.car.speed)
    for (const event of session.drainEvents()) {
      if (event.kind === "wall") { walls++; impact += event.impact; if (event.impact > 6) { hard++; where.push(`${view.car.s.toFixed(0)}:${event.impact.toFixed(0)}`) } }
      if (event.kind === "reset") { resets++; where.push(`RESET@${view.car.s.toFixed(0)}`) }
      if (event.kind === "takeoff" && view.car.s > 345 && view.car.s < 366) jumpSpeed = event.speed
      if (event.kind === "finish") time = event.timeMs
      if (event.kind === "prop" && event.prop !== "cone") things += ` ${event.prop}:${event.impact.toFixed(0)}>${session.view().car.speed.toFixed(0)}`
      if (event.kind === "bollard") things += ` post:${event.impact.toFixed(0)}>${session.view().car.speed.toFixed(0)}`
      if (event.kind === "door") things += ` door:${event.impact.toFixed(0)}>${session.view().car.speed.toFixed(0)}`
    }
  }
  console.log(`${name.padEnd(8)} ${time === null ? "no lap " : (time / 1000).toFixed(2).padStart(6)}s  walls ${String(walls).padStart(3)} hard ${String(hard).padStart(2)} impact ${impact.toFixed(0).padStart(4)} resets ${resets} top ${maxSpeed.toFixed(0)} jump ${jumpSpeed.toFixed(1)}  ${where.slice(0, 14).join(" ")} |${things}`)
}

run("bot", "car", (view) => botInput(view, track))
run("flat", "car", novice("flat"))
run("lifter", "car", novice("lifter"))
run("braker", "car", novice("braker"))
run("screen", "screen", novice("screen"))
run("stick", "screen", novice("stick"))
run("lead", "screen", novice("lead"))
