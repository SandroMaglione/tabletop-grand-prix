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
import { boardsLayer, noRival, Outbox } from "../src/host/boards.ts"
import { createGhost } from "../src/host/ghost.ts"
import { createLaps, type FinishResult, type Laps } from "../src/host/laps.ts"
import { answerStatus, shapeStatus } from "../src/host/name-messages.ts"
import { createOnline, type Online, type OnlineServices } from "../src/host/online.ts"
import { layerDown } from "../src/host/online/down.ts"
import { layerFake } from "../src/host/online/fake.ts"
import fixture from "../src/host/online/fake-runs.json" with { type: "json" }
import { layer as profileLayer } from "../src/host/profile.ts"
import { botInput, createSession, idleInput, quantise, replayFromText, rulesVersion, runReplay, tracks, type DriveInput, type RaceView, type TrackEntry } from "../src/sim/index.ts"

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
