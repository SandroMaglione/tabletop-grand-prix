/**
 * The simulation, driven headless through the same `RaceSession` the page uses.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { botInput } from "../src/sim/bot.ts"
import { createSession, fixtureTrack, idleInput, indexAt, locateNear, pointAt, surfaceAt, track } from "../src/sim/index.ts"
import type { DriveInput, RaceEvent, RaceSession, RaceView, TrackData } from "../src/sim/index.ts"
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

test("grass holds the car back, water more, an oval only inside its ellipse, and the view says what is under the car", () => {
  const patch = { shape: "strip", sFrom: 4, sTo: 26, dFrom: -10, dTo: 10 } as const
  const reach = (surfaces: TrackData["surfaces"]): { s: number; seen: ReadonlySet<string> } => {
    const session = createSession({ ...fixtureTrack, surfaces })
    const seen = new Set<string>()
    run(session, 1.8, (view) => {
      seen.add(view.car.surface)
      return { ...idleInput, throttle: 1 }
    })
    return { s: session.view().car.s, seen }
  }
  const road = reach([])
  const grass = reach([{ ...patch, kind: "grass" }])
  const water = reach([{ ...patch, kind: "water" }])
  const stones = reach([{ ...patch, kind: "stones" }])
  assert.deepEqual([...road.seen], ["road"])
  assert.ok(grass.seen.has("grass") && grass.seen.has("road"))
  assert.ok(grass.s < road.s - 0.3, `grass ${grass.s} against road ${road.s}`)
  assert.ok(water.s < grass.s - 0.5, `water ${water.s} against grass ${grass.s}`)
  // Stones are a picture: the lap is the plain road's.
  assert.equal(stones.s, road.s)
  assert.ok(stones.seen.has("stones"))

  // The corner of an oval's box is outside the oval.
  const oval = [{ kind: "water", shape: "oval", sFrom: 10, sTo: 20, dFrom: -2, dTo: 2 }] as const
  const withOval = { ...fixtureTrack, surfaces: oval }
  assert.equal(surfaceAt(withOval, 15, 0), "water")
  assert.equal(surfaceAt(withOval, 10.5, 1.8), null)
  assert.equal(surfaceAt(withOval, 15, 2.5), null)
})

test("a rock in the road throws a fast car up and it lands a little slower; a slow car rolls over it", () => {
  const rock = pointAt(fixtureTrack, 16, 0)
  const bumpy: TrackData = { ...fixtureTrack, bumps: [{ x: rock.x, y: rock.y, z: rock.z, radius: 0.95, height: 0.3 }] }
  const fast = createSession(bumpy)
  const plain = createSession(fixtureTrack)
  let airborne = 0
  const events = run(fast, 2.5, (view) => {
    if (!view.car.grounded) airborne++
    return botInput(view, bumpy)
  })
  run(plain, 2.5, (view) => botInput(view, fixtureTrack))
  const bump = events.find((event) => event.kind === "bump")
  assert.ok(bump?.kind === "bump" && bump.speed > handling.bumpFrom, "the car was never thrown")
  assert.equal(events.filter((event) => event.kind === "bump").length, 1, "one rock throws once")
  assert.ok(events.some((event) => event.kind === "land") && !events.some((event) => event.kind === "reset"), "it comes down on the road, and the lap goes on")
  assert.ok(airborne > 10 && airborne < 60, `in the air for ${airborne} ticks`)
  assert.ok(fast.view().car.grounded && fast.view().car.s < plain.view().car.s, "the hop costs a little")

  // Crawling over it: no hop.
  const slow = createSession(bumpy)
  const crawl = run(slow, 20, (view) => ({ ...botInput(view, bumpy), throttle: view.car.speed < 4 ? 0.5 : 0, brake: 0 }), (_, view) => view.car.s > 20 && view.car.s < 30)
  assert.ok(slow.view().car.s > 20, "the slow car never got past the rock")
  assert.ok(!crawl.some((event) => event.kind === "bump"))
})

/**
 * A race on the real track, driven by the bot to just inside the spiral (a long right-hander)
 * and still gripping: the place to try a drift. The bot would start its own slide a little
 * earlier, so the last metres are driven on its wheel with the brake up.
 */
const atTheSpiral = (): RaceSession => {
  const session = createSession(track)
  run(session, 40, (view) => botInput(view, track), (_, view) => view.car.s > 266 && view.car.s < 280)
  run(session, 2, (view) => ({ ...botInput(view, track), throttle: 1, brake: 0 }), (_, view) => view.car.s > 274.5)
  const { car } = session.view()
  assert.ok(car.s > 274.5 && car.s < 280 && car.drift === null && car.speed > handling.driftFrom, "the bot never reached the spiral")
  return session
}

/** How far to the side of the centreline the car is, metres. */
const offsetOf = (view: RaceView): number => locateNear(track, view.car.x, view.car.z, indexAt(track, view.car.s)).d

test("gas and brake together in a turn slide the car round it, in the road, and letting go pays a push", () => {
  const session = atTheSpiral()
  // Both pedals, the wheel into the turn to start, then let go: the slide's own arc is the spiral's.
  let widest = 0
  const sliding = run(session, 1.6, (view) => {
    widest = Math.max(widest, Math.abs(offsetOf(view)))
    return { ...idleInput, throttle: 1, brake: 1, steer: view.car.drift === null ? -1 : 0 }
  })
  const held = session.view()
  assert.ok(held.car.drift === 1, `after 1.6 s the slide has earned ${held.car.drift}`)
  assert.ok(widest < 2.4 && !sliding.some((event) => event.kind === "wall"), `the slide ran ${widest} m off the middle`)
  assert.ok(held.car.speed > 15 && held.car.brake === 0, "the brake that holds the slide does not slow the car")
  // The nose points inside the way the car goes.
  const travel = Math.atan2(held.car.vx, held.car.vz)
  let lead = held.car.yaw - travel
  while (lead > Math.PI) lead -= 2 * Math.PI
  while (lead < -Math.PI) lead += 2 * Math.PI
  assert.ok(lead < -0.2, `the nose leads the way the car goes by ${lead} rad`)

  const before = Math.hypot(held.car.vx, held.car.vz)
  const after = run(session, 0.05, () => ({ ...idleInput, throttle: 1 }))
  const push = after.find((event) => event.kind === "drift")
  assert.ok(push?.kind === "drift" && push.charge === 1, "letting go of a long slide pays the whole push")
  const now = session.view()
  assert.ok(now.car.drift === null && now.car.boosting && Math.hypot(now.car.vx, now.car.vz) > before + handling.driftKick * 0.8)
})

test("a slide let go at once pays nothing, and a wall ends one without the held brake stopping the car", () => {
  const brief = atTheSpiral()
  run(brief, 0.2, () => ({ ...idleInput, throttle: 1, brake: 1, steer: -1 }))
  assert.ok(brief.view().car.drift === 0)
  const released = run(brief, 0.1, () => ({ ...idleInput, throttle: 1 }))
  assert.ok(brief.view().car.drift === null && !released.some((event) => event.kind === "drift"))

  // The wheel held away from the turn: the arc runs wide into the outside wall.
  const wide = atTheSpiral()
  const events = run(wide, 2, (view) => ({ ...idleInput, throttle: 1, brake: 1, steer: view.car.drift === null ? -1 : 1 }), (seen) => seen.some((event) => event.kind === "wall"))
  assert.ok(events.some((event) => event.kind === "wall"), "the wide slide never reached the wall")
  const hit = wide.view().car.speed
  // On along the road with both pedals still down: the slide is over, and the brake does nothing until it is let go.
  const on = run(wide, 0.6, (view) => ({ ...botInput(view, track), throttle: 1, brake: 1 }))
  assert.ok(wide.view().car.drift === null && !on.some((event) => event.kind === "drift"), "a slide ended by a wall pays nothing")
  // Coming off the wall costs a few m/s; the brake itself would have stopped the car by now.
  assert.ok(wide.view().car.speed > hit - 6, `the brake still held slowed the car from ${hit} to ${wide.view().car.speed}`)
})

test("with the gas down the brake only drags; with the gas up it brakes hard", () => {
  const slowing = (throttle: number): number => {
    const session = createSession(fixtureTrack)
    run(session, 1.5, (view) => botInput(view, fixtureTrack))
    const from = session.view().car.speed
    run(session, 0.3, (view) => ({ ...botInput(view, fixtureTrack), throttle, brake: 1, steer: 0 }))
    return from - session.view().car.speed
  }
  const dragged = slowing(1)
  const braked = slowing(0)
  assert.ok(braked > 6, `the brake alone took ${braked} m/s off in 0.3 s`)
  assert.ok(dragged < braked * 0.5, `with the gas down it took ${dragged} against ${braked}`)
})
