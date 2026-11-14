/**
 * The simulation, driven headless through the same `RaceSession` the page uses.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { botInput } from "../src/sim/bot.ts"
import { createSession, fixtureTrack, idleInput, indexAt, locateNear, track } from "../src/sim/index.ts"
import type { DriveInput, RaceEvent, RaceSession, RaceView } from "../src/sim/index.ts"
import { STEERINGS as variantNames } from "../src/sim/schema.ts"
import { handling } from "../src/sim/tuning.ts"

/** Ticks the session with `drive` until `stop` says so or `seconds` pass; returns every event. */
const run = (session: RaceSession, seconds: number, drive: (view: RaceView, tick: number) => DriveInput, stop?: (events: ReadonlyArray<RaceEvent>, view: RaceView) => boolean): Array<RaceEvent> => {
  const events: Array<RaceEvent> = []
  for (let tick = 0; tick < seconds * session.hz; tick++) {
    session.tick(drive(session.view(), tick))
    events.push(...session.drainEvents())
    if (stop?.(events, session.view()) === true) break
  }
  return events
}

const finished = (events: ReadonlyArray<RaceEvent>): boolean => events.some((event) => event.kind === "finish")

test("the bot finishes a lap of the fixture in every variant, without a reset", () => {
  for (const variant of variantNames) {
    const session = createSession(fixtureTrack)
    session.setVariant(variant)
    const events = run(session, 90, (view) => botInput(view, fixtureTrack), finished)
    const finish = events.find((event) => event.kind === "finish")
    assert.ok(finish !== undefined, `${variant}: no lap in 90 s`)
    assert.equal(events.filter((event) => event.kind === "reset").length, 0, `${variant}: reset during the lap`)
    const view = session.view()
    assert.equal(view.lap.phase, "finished")
    assert.equal(view.lap.splitsMs.length, fixtureTrack.checkpoints.length)
    assert.equal(view.lap.timeMs, finish.timeMs)
  }
})

test("driving slowly off the fixture's ramp resets with off-track", () => {
  const session = createSession(fixtureTrack)
  const jump = fixtureTrack.features.find((feature) => feature.kind === "jump")
  assert.ok(jump !== undefined)
  const events = run(
    session,
    60,
    (view) => ({ ...botInput(view, fixtureTrack), throttle: view.car.speed < 8 ? 1 : 0, brake: 0 }),
    (seen) => seen.some((event) => event.kind === "reset" || event.kind === "finish")
  )
  const reset = events.find((event) => event.kind === "reset")
  assert.ok(reset !== undefined && reset.kind === "reset", "no reset")
  assert.equal(reset.reason, "off-track")
  assert.ok(events.some((event) => event.kind === "takeoff"), "the car never left the ramp")
  const view = session.view()
  assert.equal(view.lap.phase, "ready")
  assert.equal(view.lap.attempt, 2)
  assert.ok(Math.abs(view.car.x - fixtureTrack.start.x) < 1e-9 && Math.abs(view.car.z - fixtureTrack.start.z) < 1e-9, "the car is not back on the line")
})

test("full throttle and full steer for ten seconds never leaves the road", () => {
  for (const variant of variantNames) {
    for (const steer of [1, -1]) {
      const session = createSession(fixtureTrack)
      session.setVariant(variant)
      let worst = 0
      const events = run(session, 10, () => ({ ...idleInput, throttle: 1, steer }), (_, view) => {
        const hit = locateNear(fixtureTrack, view.car.x, view.car.z, indexAt(fixtureTrack, view.car.s))
        worst = Math.max(worst, Math.abs(hit.d) - (hit.halfWidth - handling.radius))
        return false
      })
      assert.equal(events.filter((event) => event.kind === "reset").length, 0, `${variant} steer ${steer}: reset`)
      assert.ok(worst < 1e-6, `${variant} steer ${steer}: the car went ${worst} m past the wall line`)
      assert.ok(Number.isFinite(session.view().car.x))
    }
  }
})

test("the same inputs give the same views twice", () => {
  const drive = (view: RaceView, tick: number): DriveInput => {
    const bot = botInput(view, fixtureTrack)
    // A wobble and a restart part way, so more than the bot's line is covered.
    return { ...bot, steer: Math.max(-1, Math.min(1, bot.steer + ((tick % 97) - 48) / 60)), restart: tick >= 1500 && tick < 1510 }
  }
  const record = (): Array<RaceView | ReadonlyArray<RaceEvent>> => {
    const session = createSession(fixtureTrack)
    session.setVariant("screen")
    const seen: Array<RaceView | ReadonlyArray<RaceEvent>> = []
    for (let tick = 0; tick < 2400; tick++) {
      session.tick(drive(session.view(), tick))
      if (tick % 30 === 0) seen.push(session.view(), session.drainEvents())
    }
    return seen
  }
  assert.deepEqual(record(), record())
})

test("a crate the car drives into is shoved away, the one on top comes down, and both stay where they stop until the restart", () => {
  const session = createSession(fixtureTrack)
  const placed = session.view().props
  let hitTick = -1
  // Straight down the middle into the stack, then off the throttle until everything rests.
  const events = run(
    session,
    30,
    (view) => (hitTick < 0 ? { ...idleInput, throttle: 1 } : { ...idleInput, brake: view.car.speed > 0.5 ? 1 : 0 }),
    (seen, view) => {
      if (hitTick < 0 && seen.some((event) => event.kind === "prop")) hitTick = view.tick
      return hitTick >= 0 && view.tick > hitTick + 6 * session.hz
    }
  )
  const hit = events.find((event) => event.kind === "prop")
  assert.ok(hit !== undefined && hit.prop === "crate", "the car never hit a crate")
  assert.equal(events.filter((event) => event.kind === "reset").length, 0)
  const rested = session.view().props
  assert.equal(rested.length, fixtureTrack.props.length, "a prop disappeared")
  const moved = rested[hit.index]
  const was = placed[hit.index]
  assert.ok(moved !== undefined && was !== undefined)
  assert.ok(Math.hypot(moved.x - was.x, moved.z - was.z) > 1, "the crate was not pushed")
  for (const prop of rested) assert.ok(prop.vx === 0 && prop.vy === 0 && prop.vz === 0, "a prop never came to rest")
  // The crate that stood on the one hit is on the road now.
  const above = placed.findIndex((prop) => prop.x === was.x && prop.z === was.z && prop.y > was.y)
  assert.ok(above >= 0 && Math.abs((rested[above]?.y ?? 9) - was.y) < 0.01, "the crate on top did not come down to the road")
  // Two seconds later nothing has moved.
  run(session, 2, () => idleInput)
  assert.deepEqual(session.view().props, rested)
  // The restart stands everything up again.
  run(session, 0.1, () => ({ ...idleInput, restart: true }))
  assert.deepEqual(session.view().props, placed)
})

test("the swing doors open when the car pushes through, stay open, and close again on restart", () => {
  const session = createSession(fixtureTrack)
  let hitTick = -1
  const events = run(
    session,
    60,
    (view) => botInput(view, fixtureTrack),
    (seen, view) => {
      if (hitTick < 0 && seen.some((event) => event.kind === "door")) hitTick = view.tick
      return hitTick >= 0 && view.tick > hitTick + 5 * session.hz
    }
  )
  assert.ok(hitTick >= 0, "the car never met the doors")
  assert.equal(events.filter((event) => event.kind === "reset").length, 0)
  const doors = fixtureTrack.doors
  const open = session.view().doors
  assert.equal(open.length, doors.length)
  open.forEach((angle, index) => {
    assert.ok(Math.abs(angle) > 0.3, `leaf ${index} barely moved (${angle})`)
    assert.ok(Math.abs(angle) <= (doors[index]?.maxAngle ?? 0) + 1e-9, `leaf ${index} swung past its stop`)
  })
  run(session, 2, (view) => botInput(view, fixtureTrack))
  assert.deepEqual(session.view().doors, open, "a leaf moved after it had stopped")
  run(session, 0.1, () => ({ ...idleInput, restart: true }))
  assert.deepEqual(session.view().doors, doors.map(() => 0))
})

test("restart resets once on the tick it turns true, however long it is held", () => {
  const session = createSession(fixtureTrack)
  const events = run(session, 3, (_, tick) => ({ ...idleInput, throttle: 1, restart: tick >= 120 && tick < 180 }))
  const resets = events.filter((event) => event.kind === "reset")
  assert.equal(resets.length, 1)
  assert.ok(resets[0]?.kind === "reset" && resets[0].reason === "manual")
  assert.equal(session.view().lap.attempt, 2)
  // Throttle is still held after the restart, so a new attempt has started.
  assert.equal(session.view().lap.phase, "running")
})

test("a glancing wall hit keeps most of the speed and sends one wall event", () => {
  // The fixture's start faces a little into the right wall: full throttle, no steering.
  const session = createSession(fixtureTrack)
  let before = 0
  let after = 0
  const events = run(session, 3, () => ({ ...idleInput, throttle: 1 }), (seen, view) => {
    const hits = seen.filter((event) => event.kind === "wall").length
    if (hits === 0) before = view.car.speed
    else if (after === 0) after = view.car.speed
    return false
  })
  const walls = events.filter((event) => event.kind === "wall")
  assert.equal(walls.length, 1, `${walls.length} wall events for one scrape`)
  assert.ok(walls[0]?.kind === "wall" && walls[0].side === "right")
  assert.ok(after > before * 0.8, `speed fell from ${before} to ${after}`)
})

test("leaning on a wall all the way round the real track never takes off or resets, banked turns included", () => {
  const jump = track.features.find((feature) => feature.kind === "jump")
  assert.ok(jump !== undefined, "the track has a jump")
  for (const side of [-1, 1]) {
    for (const throttle of [0.5, 0.7, 1]) {
      const session = createSession(track)
      let hint = 0
      const events = run(session, 70, (view) => {
        const bot = botInput(view, track)
        const hit = locateNear(track, view.car.x, view.car.z, hint)
        hint = hit.index
        // The bot drives the jump itself; everywhere else the car is pushed into one wall.
        if (view.car.s > jump.sFrom - 25 && view.car.s < jump.sTo + 10) return bot
        const steer = Math.max(-1, Math.min(1, (side * hit.halfWidth - hit.d) * 0.8 + bot.steer * 0.6))
        return { ...bot, steer, throttle, brake: 0 }
      }, (seen, view) => finished(seen) || seen.some((event) => event.kind === "reset") || (view.car.s > jump.sTo + 20 && view.lap.nextCheckpoint === 0))
      assert.equal(events.filter((event) => event.kind === "reset").length, 0, `side ${side}, throttle ${throttle}: the lap was reset`)
      // The jump, and a bounce off its landing, are the only times the car leaves the road.
      const from = indexAt(track, jump.sFrom)
      const strays: Array<RaceEvent> = events.filter((event): boolean => {
        if (event.kind !== "takeoff") return false
        const at = locateNear(track, event.x, event.z, from, 400).s
        return at < jump.sFrom || at > jump.sTo
      })
      assert.equal(strays.length, 0, `side ${side}, throttle ${throttle}: ${strays.length} take-offs away from the jump`)
    }
  }
})
