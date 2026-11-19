/** What the page keeps between visits, and that a bad save never costs the player what they have. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { Bests, boardsLayer, Outbox, Rivals } from "../src/host/boards.ts"
import { Profile, layer as profileLayer } from "../src/host/profile.ts"
import { Settings, layer as settingsLayer } from "../src/host/settings.ts"
import { boardKey, storagePrefix } from "../src/host/storage.ts"

type Services = Settings | Profile | Bests | Rivals | Outbox | KeyValueStore.KeyValueStore

/** One store shared by several visits. */
const makeStore = (seeded: Readonly<Record<string, string>> = {}): Promise<KeyValueStore.KeyValueStore> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      for (const [key, value] of Object.entries(seeded)) yield* store.set(key, value).pipe(Effect.orDie)
      return store
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  )

/** A visit: the page's save services over `store`. */
const visit = <A>(store: KeyValueStore.KeyValueStore, use: Effect.Effect<A, never, Services>): Promise<A> => {
  const base = Layer.succeed(KeyValueStore.KeyValueStore, store)
  return Effect.runPromise(use.pipe(Effect.provide(Layer.mergeAll(settingsLayer, profileLayer, boardsLayer).pipe(Layer.provideMerge(base)))))
}

const best = { version: 1, replay: "VEdQ", timeMs: 25123.4, splitsMs: [8000, 16000, 25123.4], steering: "car" } as const

test("a first visit has the default settings, no name and nothing per board", async () => {
  const store = await makeStore()
  const seen = await visit(
    store,
    Effect.gen(function*() {
      const settings = yield* Settings
      return {
        settings: yield* settings.saved,
        fresh: settings.fresh,
        profile: yield* (yield* Profile).saved,
        best: yield* Bests.use((bests) => bests.get("spindle-leap", 1)),
        rival: yield* Rivals.use((rivals) => rivals.get("spindle-leap", 1)),
        waiting: yield* Outbox.use((outbox) => outbox.get("spindle-leap", 1))
      }
    })
  )
  assert.deepEqual(seen.settings, { version: 6, muted: false, track: "", board: true, signup: true })
  assert.equal(seen.fresh, true)
  assert.deepEqual(seen.profile, { version: 1, identity: null, asked: false })
  assert.equal(seen.best, null)
  assert.deepEqual(seen.rival.choice, { kind: "next" })
  assert.equal(seen.waiting, null)
})

test("settings, the name, the best lap and the rival come back on the next visit, filed by track and rules", async () => {
  const store = await makeStore()
  const identity = { id: "p-1", name: "Lap Hound", secret: "s-1" }
  const rival = { version: 2, choice: { kind: "sectors", runs: [null, "r-9", null] }, order: 1, picked: ["r-3", "r-9"], run: { runId: "r-9", name: "Wren", timeMs: 29572, steering: "car", replay: "VEdQ" } } as const
  await visit(
    store,
    Effect.gen(function*() {
      yield* (yield* Settings).change({ muted: true, track: "elsewhere" })
      yield* (yield* Profile).setIdentity(identity)
      yield* Bests.use((bests) => bests.set("spindle-leap", 1, best))
      yield* Rivals.use((rivals) => rivals.set("spindle-leap", 1, rival))
    })
  )
  const again = await visit(
    store,
    Effect.gen(function*() {
      return {
        settings: yield* (yield* Settings).saved,
        profile: yield* (yield* Profile).saved,
        best: yield* Bests.use((bests) => bests.get("spindle-leap", 1)),
        otherRules: yield* Bests.use((bests) => bests.get("spindle-leap", 2)),
        otherTrack: yield* Bests.use((bests) => bests.get("elsewhere", 1)),
        rival: yield* Rivals.use((rivals) => rivals.get("spindle-leap", 1))
      }
    })
  )
  assert.equal(again.settings.track, "elsewhere")
  assert.equal(again.settings.muted, true)
  assert.deepEqual(again.profile, { version: 1, identity, asked: true })
  assert.deepEqual(again.best, best)
  assert.equal(again.otherRules, null, "a best lap under other rules is not this board's")
  assert.equal(again.otherTrack, null)
  assert.deepEqual(again.rival, rival)
  const raw = await Effect.runPromise(store.get(`${storagePrefix}${boardKey("best", "spindle-leap", 1)}`))
  assert.ok(raw !== undefined && JSON.parse(raw).timeMs === best.timeMs)
})

test("an unreadable save is kept aside and reads as nothing", async () => {
  const key = `${storagePrefix}${boardKey("best", "spindle-leap", 1)}`
  const store = await makeStore({ [key]: "{ not json", [`${storagePrefix}settings`]: JSON.stringify({ version: 9 }) })
  const seen = await visit(
    store,
    Effect.gen(function*() {
      return { best: yield* Bests.use((bests) => bests.get("spindle-leap", 1)), settings: yield* (yield* Settings).saved }
    })
  )
  assert.equal(seen.best, null)
  assert.equal(seen.settings.version, 6)
  assert.equal(await Effect.runPromise(store.get(`${key}.unreadable`)), "{ not json")
  assert.equal(await Effect.runPromise(store.get(`${storagePrefix}settings.unreadable`)), JSON.stringify({ version: 9 }))
})

test("settings saved before the ghost count keep the board choice", async () => {
  const store = await makeStore({ [`${storagePrefix}settings`]: JSON.stringify({ version: 3, muted: true, track: "elsewhere", board: false }) })
  const seen = await visit(store, Settings.use((settings) => settings.saved))
  assert.deepEqual(seen, { version: 6, muted: true, track: "elsewhere", board: false, signup: true })
})

test("settings saved before the email sign-up keep everything and may still offer it; once declined it stays declined", async () => {
  const store = await makeStore({ [`${storagePrefix}settings`]: JSON.stringify({ version: 4, muted: true, track: "elsewhere", board: false, ghosts: 5 }) })
  const seen = await visit(
    store,
    Effect.gen(function*() {
      const settings = yield* Settings
      const before = yield* settings.saved
      yield* settings.change({ signup: false })
      return before
    })
  )
  assert.deepEqual(seen, { version: 6, muted: true, track: "elsewhere", board: false, signup: true })
  const again = await visit(store, Settings.use((settings) => settings.saved))
  assert.deepEqual(again, { version: 6, muted: true, track: "elsewhere", board: false, signup: false })
  const raw = await Effect.runPromise(store.get(`${storagePrefix}settings`))
  assert.ok(raw !== undefined && JSON.parse(raw).version === 6)
})

test("settings saved with a ghost count keep the rest: the ghosts are added from the board now", async () => {
  const store = await makeStore({ [`${storagePrefix}settings`]: JSON.stringify({ version: 5, muted: false, track: "", board: true, ghosts: 10, signup: false }) })
  assert.deepEqual(await visit(store, Settings.use((settings) => settings.saved)), { version: 6, muted: false, track: "", board: true, signup: false })
})

test("a rival saved before the board could be shown by sector: a run chosen to race races beside the next closest", async () => {
  const run = { runId: "r-9", name: "Wren", timeMs: 29572, steering: "car", replay: "VEdQ" } as const
  const key = `${storagePrefix}${boardKey("rival", "spindle-leap", 1)}`
  const chosen = await makeStore({ [key]: JSON.stringify({ version: 1, choice: { kind: "run", runId: "r-9" }, run }) })
  assert.deepEqual(await visit(chosen, Rivals.use((rivals) => rivals.get("spindle-leap", 1))), { version: 2, choice: { kind: "next" }, order: null, picked: ["r-9"], run })
  const own = await makeStore({ [key]: JSON.stringify({ version: 1, choice: { kind: "own" }, run: null }) })
  assert.deepEqual(await visit(own, Rivals.use((rivals) => rivals.get("spindle-leap", 1))), { version: 2, choice: { kind: "own" }, order: null, picked: [], run: null })
})

test("the outbox keeps only the fastest run waiting, and forgets it once sent", async () => {
  const store = await makeStore()
  const left = await visit(
    store,
    Effect.gen(function*() {
      const outbox = yield* Outbox
      yield* outbox.put("spindle-leap", 1, { version: 1, replay: "slow", timeMs: 30000 })
      yield* outbox.put("spindle-leap", 1, { version: 1, replay: "fast", timeMs: 26000 })
      yield* outbox.put("spindle-leap", 1, { version: 1, replay: "slower", timeMs: 28000 })
      const waiting = yield* outbox.get("spindle-leap", 1)
      // A send that finishes after a faster run arrived leaves the faster one.
      yield* outbox.clear("spindle-leap", 1, "slow")
      const still = yield* outbox.get("spindle-leap", 1)
      yield* outbox.clear("spindle-leap", 1, "fast")
      return { waiting, still, after: yield* outbox.get("spindle-leap", 1) }
    })
  )
  assert.equal(left.waiting?.replay, "fast")
  assert.equal(left.still?.replay, "fast")
  assert.equal(left.after, null)
})
