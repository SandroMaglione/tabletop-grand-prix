/**
 * Where this device keeps what the game saves, as Effect's `KeyValueStore`, so nothing else
 * knows. In a browser that is IndexedDB; where a browser refuses it (some private modes) the
 * game keeps things in memory for the visit and plays the same.
 *
 * Every key starts with `storagePrefix`. What belongs to one board (a track under one
 * version of the rules) is filed under `boardKey`, so a new track or new rules start clean
 * and never read a lap driven under something else.
 */
import { BrowserKeyValueStore, IndexedDb } from "@effect/platform-browser"
import { Effect, Layer } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"

/** Every key this game stores starts with this, so a shared origin cannot mix games. */
export const storagePrefix = "tabletop-grand-prix/"

/** The key of what one board keeps: `<kind>/<track id>/<rules version>`. */
export const boardKey = (kind: string, track: string, rules: number): string => `${kind}/${track}/${rules}`

const database = "tabletop-grand-prix-saves"

/** Whether the browser lets the page open a database at all; tried on a database of its own, so the saves' one is created by the store with its tables. */
const canOpen = Effect.tryPromise(
  () =>
    new Promise<void>((resolve, reject) => {
      const opening = window.indexedDB.open("tabletop-grand-prix-probe")
      opening.onerror = () => reject(opening.error)
      opening.onsuccess = () => {
        opening.result.close()
        resolve()
      }
    })
)

const indexedDbStore = BrowserKeyValueStore.layerIndexedDb({ database }).pipe(Layer.provide(IndexedDb.layerWindow))

/** The store in IndexedDB once one read from it worked; in memory otherwise. */
export const storageLayer: Layer.Layer<KeyValueStore.KeyValueStore> = Layer.unwrap(
  canOpen.pipe(
    Effect.andThen(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        yield* store.get("probe")
      }).pipe(Effect.provide(indexedDbStore))
    ),
    Effect.timeout("2 seconds"),
    Effect.as(indexedDbStore),
    Effect.catchCause((cause) => {
      console.warn("saves are kept in memory for this visit", cause)
      return Effect.succeed(KeyValueStore.layerMemory)
    })
  )
)

/** The page's store, under the game's prefix. */
export const gameStore: Effect.Effect<KeyValueStore.KeyValueStore, never, KeyValueStore.KeyValueStore> = Effect.gen(function*() {
  return KeyValueStore.prefix(yield* KeyValueStore.KeyValueStore, storagePrefix)
})

/**
 * The saves of the build before this one sat in localStorage: the best laps as positions,
 * which are dropped (a best lap is now a replay), and the two settings, which are handed
 * back once so the player keeps them. Every old key is removed.
 */
export const takeLegacySettings = (): { readonly steering: string | null; readonly muted: boolean | null } => {
  try {
    const storage = window.localStorage
    const old = "tabletop-grand-prix:"
    const steering = storage.getItem(`${old}variant`)
    const muted = storage.getItem(`${old}muted`)
    const keys: Array<string> = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key !== null && key.startsWith(old)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
    return { steering, muted: muted === null ? null : muted === "1" }
  } catch {
    return { steering: null, muted: null }
  }
}
