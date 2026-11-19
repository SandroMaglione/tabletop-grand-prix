/**
 * The page's side of the leaderboard: laps recorded as replays, the stand-in server, and the
 * flows (a name, a lap sent, the rival, a lap kept while the server is down) driven headless
 * against the stand-in.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { type Identity, Leaderboard } from "../src/api/contract.ts"
import { boardsLayer, noRival, Outbox, Rivals } from "../src/host/boards.ts"
import { createGhost, ghostAt, type LapGhost, sectorGhost } from "../src/host/ghost.ts"
import { createLaps, type FinishResult, type Laps } from "../src/host/laps.ts"
import { answerStatus, shapeStatus } from "../src/host/name-messages.ts"
import { createOnline, type Online, type OnlineServices } from "../src/host/online.ts"
import { layerDown } from "../src/host/online/down.ts"
import { layerFake } from "../src/host/online/fake.ts"
import fixture from "../src/host/online/fake-runs.json" with { type: "json" }
import { layer as profileLayer } from "../src/host/profile.ts"
import { createRerun } from "../src/host/rerun.ts"
import { sectorTimes, wholeSectors } from "../src/api/sectors.ts"
import { compareSectors, createSplits } from "../src/host/splits.ts"
import { standingOf } from "../src/host/standing.ts"
import { botInput, createSession, idleInput, quantise, replayFromText, rulesVersion, runReplay, tracks, type DriveInput, type LapView, type RaceView, type TrackEntry } from "../src/sim/index.ts"

const entry = tracks[0] as TrackEntry

/**
 * Drives one attempt the way the page does (every input through `quantise`, then to the
 * laps), with `shape` changing the bot's input. Returns the finish.
 */
const driveLap = (laps: Laps, shape: (input: DriveInput, view: RaceView, tick: number) => DriveInput = (input) => input, wait = 0): FinishResult => {
  const session = createSession(entry.data, "car")
  for (let tick = 0; tick < 120 * 90; tick++) {
    const asked = tick < wait ? idleInput : shape(botInput(session.view(), entry.data), session.view(), tick)
    const input = quantise(asked)
    session.tick(input)
    const finish = laps.afterTick(input, session.view(), session.drainEvents())
    if (finish !== null) return finish
  }
  throw new Error("no finish")
}

/** Lifts off the gas through half the lap: a slower lap that still clears the jump. */
const slowly = (input: DriveInput, view: RaceView): DriveInput => ({ ...input, throttle: input.throttle * (Math.sin(view.car.s * 0.05 + 5) > 0.2 ? 0.05 : 1) })

test("a lap driven in the page is a replay that drives the same lap, waiting on the line or not", () => {
  const laps = createLaps(entry.id, null, () => "car")
  const late = driveLap(laps, undefined, 300)
  assert.ok(late.improved && late.replay !== null && late.previous === null)
  const bytes = replayFromText(late.replay)
  assert.ok(bytes !== null)
  const again = runReplay(bytes)
  assert.ok(again.ok)
  assert.equal(again.timeMs, late.timeMs)
  assert.deepEqual(again.splitsMs, late.splitsMs)
  assert.equal(laps.best()?.replay, late.replay)
  // The same lap again (a new session, so new laps seeded with the best) does not beat itself.
  const same = driveLap(createLaps(entry.id, laps.best(), () => "car"))
  assert.equal(same.improved, false)
  assert.equal(same.replay, late.replay, "time spent waiting on the line is not part of the replay")
})

test("an attempt started again is recorded from its own start", () => {
  const laps = createLaps(entry.id, null, () => "car")
  const session = createSession(entry.data, "car")
  let finish: FinishResult | null = null
  for (let tick = 0; tick < 120 * 90 && finish === null; tick++) {
    // Drive two seconds, restart, then drive a whole lap.
    const input = quantise({ ...botInput(session.view(), entry.data), restart: tick === 240 })
    session.tick(input)
    finish = laps.afterTick(input, session.view(), session.drainEvents())
    if (tick === 100) assert.equal(laps.recording(), true)
  }
  assert.ok(finish !== null && finish.replay !== null)
  const bytes = replayFromText(finish.replay)
  assert.ok(bytes !== null)
  const again = runReplay(bytes)
  assert.ok(again.ok && again.timeMs === finish.timeMs)
  assert.equal(laps.recording(), false, "nothing is recorded after the finish")
})

test("the stand-in board's laps are from these rules and drive to the times it files", () => {
  assert.equal(fixture.rules, rulesVersion, "the stand-in's laps are from other rules: run node scripts/fake-board.ts")
  for (const runs of Object.values(fixture.runs)) {
    assert.ok(runs.length >= 12)
    for (const run of runs) {
      const bytes = replayFromText(run.replay)
      assert.ok(bytes !== null)
      const again = runReplay(bytes, { ghost: false })
      assert.ok(again.ok && again.timeMs === run.timeMs, `${run.name}: ${again.ok ? again.timeMs : again.fault}`)
    }
  }
})

test("the stand-in pads its board to the drivers asked for, and reads it a page at a time", async () => {
  const board = await Effect.runPromise(Effect.gen(function*() {
    return yield* Leaderboard
  }).pipe(Effect.provide(layerFake({ storage: null, latencyMs: 0, drivers: 2000 }))))
  const end = await Effect.runPromise(board.page(entry.id, 1990, 50, null, null))
  assert.deepEqual([end.total, end.from, end.entries.length], [2000, 1990, 11])
  const all = await Effect.runPromise(board.page(entry.id, 1, 10_000, null, null))
  assert.equal(all.entries.length, 200)
  assert.ok(all.entries.every((one, i) => one.rank === i + 1 && (i === 0 || (all.entries[i - 1]?.timeMs ?? 0) <= one.timeMs)), "fastest first, ranked in order")
  const top = await Effect.runPromise(board.board(entry.id, null, null))
  assert.deepEqual(top.top.map((one) => one.runId), all.entries.slice(0, 10).map((one) => one.runId))
})

test("the stand-in answers names like the server: shape, kept back, refused, taken", async () => {
  const board = await Effect.runPromise(Effect.gen(function*() {
    return yield* Leaderboard
  }).pipe(Effect.provide(layerFake({ storage: null, latencyMs: 0 }))))
  const tag = (effect: Effect.Effect<unknown, { readonly _tag: string; readonly reason?: string }>) =>
    Effect.runPromise(effect.pipe(Effect.match({ onSuccess: () => "ok", onFailure: (failure) => (failure.reason === undefined ? failure._tag : `${failure._tag}:${failure.reason}`) })))
  assert.equal(await tag(board.checkName("ab")), "NameRefused:length")
  assert.equal(await tag(board.checkName("a  b!")), "NameRefused:characters")
  assert.equal(await tag(board.checkName("Admin")), "NameRefused:reserved")
  assert.equal(await tag(board.checkName("so rude")), "NameRefused:blocked")
  assert.equal(await tag(board.checkName("pebble")), "NameTaken")
  assert.equal(await tag(board.checkName("Kaz-Drift")), "NameTaken", "joiners and case read the same")
  assert.equal(await tag(board.checkName("Lap Hound")), "ok")
  const me = await Effect.runPromise(board.register("Lap Hound"))
  assert.equal(await tag(board.checkName("lap_hound")), "NameTaken")
  assert.equal(await tag(board.rename(me, "Lap Hound 2")), "ok")
  assert.equal(await tag(board.submit(me, "AAAA")), "RunRefused")
  assert.equal(await tag(board.submit({ ...me, secret: "wrong" }, "AAAA")), "Unauthorised")
})

test("name messages: each refusal in a few words, and only a good name can be saved", () => {
  assert.equal(shapeStatus("", null)?.canSave, false)
  assert.match(shapeStatus("ab", null)?.text ?? "", /TOO SHORT/)
  assert.match(shapeStatus("x".repeat(17), null)?.text ?? "", /TOO LONG/)
  assert.match(shapeStatus("big wheels!", null)?.text ?? "", /ONLY LETTERS/)
  assert.match(shapeStatus("  Lap   Hound ", "Lap Hound")?.text ?? "", /YOUR NAME/)
  assert.equal(shapeStatus("Lap Hound", null), null, "a good shape is the board's to answer")
  assert.equal(answerStatus({ kind: "ok" }).canSave, true)
  assert.equal(answerStatus({ kind: "taken" }).canSave, false)
  assert.match(answerStatus({ kind: "refused", reason: "reserved" }).text, /KEPT BACK/)
  assert.match(answerStatus({ kind: "refused", reason: "blocked" }).text, /NOT ALLOWED/)
  assert.match(answerStatus({ kind: "limited", seconds: 30 }).text, /30/)
  assert.match(answerStatus({ kind: "unavailable" }).text, /CAN'T REACH/)
})

// ── the flows ──────────────────────────────────────────────────────────

const until = async (what: string, ok: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const memoryStore = (): Promise<KeyValueStore.KeyValueStore> =>
  Effect.runPromise(Effect.gen(function*() {
    return yield* KeyValueStore.KeyValueStore
  }).pipe(Effect.provide(KeyValueStore.layerMemory)))

/** A page's services over one shared store, with this leaderboard. */
const page = (store: KeyValueStore.KeyValueStore, leaderboard: Layer.Layer<Leaderboard>) => {
  const app = ManagedRuntime.make(Layer.mergeAll(profileLayer, boardsLayer, leaderboard).pipe(Layer.provide(Layer.succeed(KeyValueStore.KeyValueStore, store))))
  const run = <A>(effect: Effect.Effect<A, never, OnlineServices>): Promise<A | undefined> => app.runPromise(effect)
  return { app, run }
}

/** The made-up names the pages draw, in order: the first belongs to one of the stand-in's players. */
const handles = ["Pebble", "Shy Otter Skids"]

const start = (run: ReturnType<typeof page>["run"], laps: Laps, identity: Identity | null = null): Online => {
  const online = createOnline({
    enabled: true,
    run,
    track: entry.id,
    rules: rulesVersion,
    laps,
    ghost: createGhost(),
    identity,
    asked: identity !== null,
    rival: noRival,
    tracks: tracks.map((one) => one.id),
    defer: (work) => work(),
    timeoutMs: 2000,
    handle: () => handles.shift() ?? "Lazy Sloth Naps"
  })
  online.start()
  return online
}

test("first lap, a name, the lap sent, the next closest rival; the server down keeps the lap for the next visit", async () => {
  const store = await memoryStore()
  const fake = layerFake({ storage: null, latencyMs: 0 })
  const one = page(store, fake)
  const laps = createLaps(entry.id, null, () => "car")
  const online = start(one.run, laps)
  await until("the board", () => online.state().board !== null && !online.state().ghostLoading)
  const slowest = fixture.runs["spindle-leap"].reduce((a, b) => (a.timeMs > b.timeMs ? a : b))
  assert.equal(online.state().board?.total, fixture.runs["spindle-leap"].length)

  // The first lap: the player is given a made-up name (the first one drawn is taken, so
  // another is drawn) and the lap goes to the board under it, with nothing asked.
  const first = driveLap(laps, slowly)
  online.finished(first)
  assert.equal(online.state().post?.state.kind, "sending", "the lap is on its way while the name is made up")
  await until("the lap sent", () => online.state().post?.state.kind === "sent")
  assert.equal(online.state().identity?.name, "Shy Otter Skids")
  assert.equal(online.state().namePrompts, 0)
  const sent = online.state().post?.state
  // The name is the player's to change.
  assert.deepEqual(await online.checkName("Pebble"), { kind: "taken" })
  assert.deepEqual(await online.checkName("Lap Hound"), { kind: "ok" })
  assert.deepEqual(await online.saveName("Lap Hound"), { kind: "ok" })
  assert.ok(sent?.kind === "sent" && sent.total === fixture.runs["spindle-leap"].length + 1)
  const ahead = fixture.runs["spindle-leap"].filter((run) => Math.round(run.timeMs) < Math.round(first.timeMs)).length
  assert.equal(sent.rank, ahead + 1)
  assert.equal(await one.run(Outbox.use((outbox) => outbox.get(entry.id, rulesVersion))), null, "sent runs leave the outbox")
  await until("the board with me", () => online.state().board?.me?.name === "Lap Hound" && !online.state().ghostLoading)
  assert.ok(slowest.timeMs > first.timeMs, "the slow lap is still faster than the slowest made-up player")

  // A faster lap with the server down: kept, and sent on the next visit.
  const identity = online.state().identity
  assert.ok(identity !== null)
  const two = page(store, layerDown)
  const lapsDown = createLaps(entry.id, laps.best(), () => "car")
  const offline = start(two.run, lapsDown, identity)
  const fast = driveLap(lapsDown)
  assert.ok(fast.improved)
  offline.finished(fast)
  await until("the lap kept", () => offline.state().post?.state.kind === "waiting")
  assert.equal(offline.state().reachable, false)
  assert.equal((await two.run(Outbox.use((outbox) => outbox.get(entry.id, rulesVersion))))?.replay, fast.replay)

  const three = page(store, fake)
  const back = start(three.run, createLaps(entry.id, lapsDown.best(), () => "car"), identity)
  await until("the waiting lap sent on the next visit", () => back.state().rank !== null && back.state().rank?.rank !== sent.rank)
  assert.equal(await three.run(Outbox.use((outbox) => outbox.get(entry.id, rulesVersion))), null)
  await until("the rival", () => !back.state().ghostLoading)
  await Promise.all([one.app.dispose(), two.app.dispose(), three.app.dispose()])
})

test("the next closest rival is the slowest run still faster than the player's best", async () => {
  const store = await memoryStore()
  const { app, run } = page(store, layerFake({ storage: null, latencyMs: 0 }))
  const laps = createLaps(entry.id, null, () => "car")
  const ghost = createGhost()
  const online = createOnline({ enabled: true, run, track: entry.id, rules: rulesVersion, laps, ghost, identity: null, asked: true, rival: noRival, tracks: [entry.id], defer: (work) => work() })
  online.start()
  await until("a ghost", () => !online.state().ghostLoading && ghost.current() !== null)
  const runs = fixture.runs["spindle-leap"]
  const slowest = runs.reduce((a, b) => (a.timeMs > b.timeMs ? a : b))
  assert.equal(ghost.current()?.name, slowest.name, "with no lap yet, the slowest on the board")
  online.finished(driveLap(laps, slowly))
  const best = laps.best()?.timeMs ?? 0
  const expected = runs.filter((one) => Math.round(one.timeMs) < Math.round(best)).reduce((a, b) => (a.timeMs > b.timeMs ? a : b))
  await until("the next closest", () => ghost.current()?.name === expected.name, 6000)
  online.choose({ kind: "own" })
  await until("the own best", () => ghost.current()?.kind === "own")
  online.choose({ kind: "none" })
  await until("no ghost", () => ghost.current() === null)
  await app.dispose()
})

test("the board by one sector: the fastest raced in it, ghosts added from the board, and one driver per sector", async () => {
  const store = await memoryStore()
  const { app, run } = page(store, layerFake({ storage: null, latencyMs: 0 }))
  const laps = createLaps(entry.id, null, () => "car")
  const ghost = createGhost()
  let beside: ReadonlyArray<string> = []
  const online = createOnline({
    enabled: true,
    run,
    track: entry.id,
    rules: rulesVersion,
    laps,
    ghost,
    identity: null,
    asked: true,
    rival: noRival,
    sectors: 3,
    raceField: (runs) => {
      beside = runs.map((one) => one.name)
    },
    tracks: [entry.id],
    defer: (work) => work()
  })
  online.start()
  await until("the board", () => online.state().board !== null && !online.state().ghostLoading)
  // Each made-up player's sectors, from their replays, fastest first in each sector.
  const runs = fixture.runs["spindle-leap"].map((one) => {
    const lap = runReplay(replayFromText(one.replay) ?? new Uint8Array())
    assert.ok(lap.ok)
    return { name: one.name, timeMs: Math.floor(one.timeMs), sectors: wholeSectors(lap.splitsMs, lap.timeMs, 3) }
  })
  const fastestBy = (key: (one: (typeof runs)[number]) => number): Array<string> => [...runs].sort((a, b) => key(a) - key(b)).map((one) => one.name)
  const idOf = (name: string | undefined): string => online.state().shown?.top.find((one) => one.name === name)?.runId ?? assert.fail(`no ${name} on the board`)

  // The fastest by lap, then by the second sector: the board and the raced ghost follow the order.
  online.choose({ kind: "fastest" })
  const byLap = fastestBy((one) => one.timeMs)
  await until("the fastest by lap", () => ghost.current()?.name === byLap[0])
  assert.deepEqual(online.state().raced, [ghost.current()?.runId])
  online.setOrder(1)
  const bySecond = fastestBy((one) => one.sectors[1] ?? 0)
  assert.notDeepEqual(bySecond.slice(0, 3), byLap.slice(0, 3), "the fixture's sectors order the runs otherwise than their laps")
  await until("the board by S2", () => online.state().shown?.top[0]?.name === bySecond[0] && !online.state().boardLoading)
  assert.deepEqual(online.state().shown?.top.map((one) => one.name), bySecond.slice(0, 10))
  assert.equal(online.state().board?.top[0]?.name, byLap[0], "the board by lap is still read, for the player's place")
  await until("the fastest in S2", () => ghost.current()?.name === bySecond[0])
  assert.deepEqual(beside, [], "nothing beside it until the player adds a run")

  // Runs clicked on the board race beside it, in the order added; the raced one is not doubled; a click again takes one away.
  online.toggle(idOf(bySecond[3]))
  online.toggle(idOf(bySecond[1]))
  online.toggle(idOf(bySecond[0]))
  await until("two beside", () => beside.join() === [bySecond[3], bySecond[1]].join())
  assert.equal(online.state().picked.length, 3)
  online.toggle(idOf(bySecond[3]))
  await until("one beside", () => beside.join() === bySecond[1])
  online.clearPicked()
  await until("none beside", () => beside.length === 0)

  // One driver per sector: the fastest in each, an ideal lap; then another picked for the last sector.
  online.choose({ kind: "sectors", runs: [] })
  const fastestIn = [0, 1, 2].map((i) => fastestBy((one) => one.sectors[i] ?? 0)[0])
  await until("a ghost by sector", () => ghost.current()?.kind === "sectors" && !online.state().ghostLoading)
  assert.deepEqual(online.state().legs.map((leg) => leg?.name), fastestIn)
  const ideal = [0, 1, 2].reduce((sum, i) => sum + Math.min(...runs.map((one) => one.sectors[i] ?? 0)), 0)
  assert.ok(Math.abs((ghost.current()?.timeMs ?? 0) - ideal) < 3, "its time is the ideal lap: the best of each sector")
  const other = fastestBy((one) => one.sectors[2] ?? 0)[4]
  online.setOrder(2)
  await until("the board by S3", () => online.state().shown?.top[0]?.name === fastestIn[2] && !online.state().boardLoading)
  online.setLeg(2, idOf(other))
  await until("another for S3", () => online.state().legs[2]?.name === other && !online.state().ghostLoading)
  assert.deepEqual(online.state().legs.map((leg) => leg?.name), [fastestIn[0], fastestIn[1], other])

  // The choice, the order and the runs added are kept for the next visit; a sector the track has not is the lap.
  const added = runs.map((one) => one.name).find((name) => !online.state().legs.some((leg) => leg?.name === name))
  online.toggle(idOf(added))
  const kept = await run(Rivals.use((rivals) => rivals.get(entry.id, rulesVersion)))
  assert.deepEqual([kept?.choice, kept?.order, kept?.picked], [{ kind: "sectors", runs: [null, null, idOf(other)] }, 2, [idOf(added)]])
  online.setOrder(7)
  assert.equal(online.state().order, null)
  await until("the board by lap again", () => !online.state().boardLoading && !online.state().ghostLoading && beside.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  await app.dispose()
})

test("a ghost by sector is each sector's driver, from the line the player crossed, as long after it as the player is", () => {
  const leg = (name: string, splitsMs: ReadonlyArray<number>): LapGhost => ({ kind: "rival", name, runId: name, timeMs: splitsMs[splitsMs.length - 1] ?? 0, splitsMs, poses: [] })
  const a = leg("A", [8000, 16000, 24000])
  const b = leg("B", [9000, 15000, 23000])
  const c = leg("C", [8500, 16500, 23500])
  const ghost = sectorGhost([a, b, c])
  assert.deepEqual(ghost.splitsMs, [8000, 14000, 21000], "the ideal lap: A's first sector, B's second, C's third")
  assert.equal(ghost.timeMs, 21000)
  const lap = (phase: LapView["phase"], timeMs: number, splitsMs: ReadonlyArray<number>): LapView => ({ phase, attempt: 1, timeMs, splitsMs, nextCheckpoint: 0 })
  const at = (view: LapView) => {
    const got = ghostAt(ghost, view)
    return got === null ? null : { leg: got.leg.name, legMs: got.legMs, endMs: got.endMs }
  }
  assert.deepEqual(at(lap("ready", 0, [])), { leg: "A", legMs: 0, endMs: Number.POSITIVE_INFINITY })
  assert.deepEqual(at(lap("running", 5000, [])), { leg: "A", legMs: 5000, endMs: Number.POSITIVE_INFINITY })
  // The player crossed the first line at 8.5 s: B from its own first line, half a second on.
  assert.deepEqual(at(lap("running", 9000, [8500])), { leg: "B", legMs: 9500, endMs: Number.POSITIVE_INFINITY })
  // In the last sector C, whose lap ends as long after the player's second line as C's did after its own.
  assert.deepEqual(at(lap("running", 16000, [8500, 15500])), { leg: "C", legMs: 17000, endMs: 15500 + (23500 - 16500) })
  assert.deepEqual(at(lap("finished", 22000, [8500, 15500, 22000])), { leg: "C", legMs: 23000, endMs: 22500 })
  // A plain lap is where it was at the same time on the clock.
  assert.deepEqual(ghostAt(a, lap("running", 5000, [])), { leg: a, legMs: 5000, clockMs: 5000, endMs: 24000 })
})

test("a run of the board is watched without racing it: its own lap, its place, looping until stopped", async () => {
  const store = await memoryStore()
  const { app, run } = page(store, layerFake({ storage: null, latencyMs: 0 }))
  const laps = createLaps(entry.id, null, () => "car")
  const ghost = createGhost()
  const online = createOnline({ enabled: true, run, track: entry.id, rules: rulesVersion, laps, ghost, identity: null, asked: true, rival: noRival, tracks: [entry.id], defer: (work) => work() })
  online.start()
  await until("the board", () => online.state().board !== null && !online.state().ghostLoading)
  const picked = online.state().board?.top[2]
  assert.ok(picked !== undefined)
  const choice = online.state().choice
  const got = await online.replay(picked.runId)
  assert.ok(got !== null)
  assert.equal(got.name, picked.name)
  assert.deepEqual(online.state().choice, choice, "watching a run does not race it")
  assert.equal(await online.replay("no-such-run"), null)

  const rerun = createRerun(entry.data)
  const watched = { runId: picked.runId, name: picked.name, rank: picked.rank, timeMs: picked.timeMs, mine: picked.mine, sector: null }
  assert.ok(rerun.start(got.replay, watched))
  assert.deepEqual(rerun.watched(), watched)
  assert.equal(standingOf(rerun.watched()?.rank ?? null), "third", "the car wears the place of the run watched")
  let finishMs: number | null = null
  let starts = 0
  for (let tick = 0; tick < 120 * 120 && starts < 2; tick++) {
    for (const event of rerun.tick()) {
      if (event.kind === "finish") finishMs = event.timeMs
      if (event.kind === "reset") starts++
    }
  }
  assert.equal(Math.floor(finishMs ?? 0), picked.timeMs, "the watched lap is the one the board filed (in whole milliseconds)")
  assert.equal(starts, 2, "it starts again from the line")
  assert.deepEqual(rerun.watched(), watched, "and is still the watched run")
  rerun.stop()
  assert.equal(rerun.watched(), null)
  // The lap just driven, shown again, is no run of the board.
  assert.ok(rerun.start(got.replay))
  assert.equal(rerun.watched(), null)

  // Watched from a board by sector: only that sector, from its line to the next, again and again.
  const lap = runReplay(replayFromText(got.replay) ?? new Uint8Array())
  assert.ok(lap.ok)
  const second = (lap.splitsMs[1] ?? 0) - (lap.splitsMs[0] ?? 0)
  assert.ok(rerun.start(got.replay, { ...watched, sector: 1 }))
  const showings: Array<{ readonly startSplits: number; ticks: number; ended: boolean }> = []
  let finished = false
  for (let tick = 0; tick < 120 * 60 && showings.length < 4; tick++) {
    for (const event of rerun.tick()) {
      if (event.kind === "reset") showings.push({ startSplits: rerun.view().lap.splitsMs.length, ticks: 0, ended: false })
      if (event.kind === "checkpoint" && event.index === 2) {
        const now = showings[showings.length - 1]
        if (now !== undefined) now.ended = true
      }
      if (event.kind === "finish") finished = true
    }
    const now = showings[showings.length - 1]
    if (now !== undefined) now.ticks++
  }
  assert.equal(showings.length, 4, "it starts again and again")
  assert.ok(showings.every((one) => one.startSplits === 1), "each time on the sector's line, the first one crossed")
  assert.ok(showings.slice(0, 3).every((one) => one.ended), "each time to the line that ends it")
  assert.equal(finished, false, "never on to the finish")
  // As long as the sector, and a moment past its end.
  for (const one of showings.slice(0, 3)) assert.ok(Math.abs(one.ticks - (second * 120) / 1000 - 72) < 4, `a showing of ${one.ticks} ticks`)
  await app.dispose()
})

test("sectors: each line's time less the one before, the finish filled in, the worst loss picked", () => {
  assert.deepEqual(sectorTimes([8000, 15000, 23000], 23000, 3), [8000, 7000, 8000])
  assert.deepEqual(sectorTimes([8000, 15000], 23000, 3), [8000, 7000, 8000], "splits that leave out the finish end on the lap's time")
  const compared = compareSectors([8100, 6900, 8400], [8000, 7000, 8000])
  assert.deepEqual(compared.sectors.map((one) => one.deltaMs), [100, -100, 400])
  assert.equal(compared.worst, 2)
  assert.equal(compareSectors([7900, 6900], [8000, 7000]).worst, -1, "faster everywhere: no sector to work on")
  assert.deepEqual(compareSectors([8000, 7000], null), { sectors: [{ ms: 8000, deltaMs: null }, { ms: 7000, deltaMs: null }], worst: -1 }, "the fastest has nothing above")
})

test("a run's splits against the run above, from both replays, the run above asked for when not given", async () => {
  const store = await memoryStore()
  const { app, run } = page(store, layerFake({ storage: null, latencyMs: 0 }))
  const laps = createLaps(entry.id, null, () => "car")
  const online = start(run, laps)
  await until("the board", () => online.state().board !== null && !online.state().ghostLoading)
  const splits = createSplits(online, entry.data.checkpoints.length, (work) => work())
  const top = online.state().board?.top ?? []
  const [first, second, third] = top
  assert.ok(first !== undefined && second !== undefined && third !== undefined)
  const sum = (values: ReadonlyArray<number>): number => values.reduce((a, b) => a + b, 0)

  assert.equal(splits.known(third, second, null), null, "nothing driven yet")
  const given = await splits.load(third, second, null)
  assert.ok(given !== null)
  assert.equal(given.above?.runId, second.runId)
  assert.equal(given.sectors.length, entry.data.checkpoints.length)
  assert.ok(Math.abs(sum(given.sectors.map((one) => one.ms)) - third.timeMs) < 1, "its sectors add up to its board time")
  assert.ok(Math.abs(sum(given.sectors.map((one) => one.deltaMs ?? 0)) - (third.timeMs - second.timeMs)) < 1, "the gaps add up to the gap on the board")
  assert.ok(given.worst >= 0, "a slower run loses somewhere")
  assert.equal(given.sectors[given.worst]?.deltaMs, Math.max(...given.sectors.map((one) => one.deltaMs ?? 0)))
  assert.deepEqual(splits.known(third, second, null), given, "once driven, drawn at once")

  const asked = await splits.load(third, null, null)
  assert.equal(asked?.above?.runId, second.runId, "the run above, asked of the board")
  assert.deepEqual(splits.known(third, null, null), asked)

  const fastest = await splits.load(first, null, null)
  assert.equal(fastest?.above, null)
  assert.ok(fastest?.sectors.every((one) => one.deltaMs === null))
  await app.dispose()
})
