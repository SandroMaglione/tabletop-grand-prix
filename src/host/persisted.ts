/**
 * Reading and writing one saved value (JSON under a key) through its schema, as Landkeep
 * does. Reading never fails and never loses a save: a value that cannot be decoded is first
 * kept aside (under `<key>.unreadable`, or the next free copy beside it) and reported as
 * unreadable; a read the storage itself failed (tried twice more first) is reported as
 * failed, so the caller writes nothing over a value it could not see.
 */
import { Effect, Schedule, Schema } from "effect"
import type * as KeyValueStore from "effect/persistence/KeyValueStore"

export type Read<A> =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unreadable" }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "Read"; readonly value: A }

/** How many unreadable values are kept aside under one key. */
const asideCopies = 3

/** Where unreadable values under `key` are kept aside, the first copy first. */
export const asideKeys = (key: string): ReadonlyArray<string> =>
  Array.from({ length: asideCopies }, (_, i) => (i === 0 ? `${key}.unreadable` : `${key}.unreadable.${i + 1}`))

/** A flaky storage call is tried twice more before it counts as failed. */
const retried = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> => effect.pipe(Effect.retry({ times: 2, schedule: Schedule.spaced("50 millis") }))

/** Keeps `raw` aside beside `key`, in the first free copy (or the one already holding it); fails when every copy is taken. */
const setAside = (store: KeyValueStore.KeyValueStore, key: string, raw: string) =>
  Effect.gen(function*() {
    for (const aside of asideKeys(key)) {
      const held = yield* retried(store.get(aside))
      if (held === raw) return
      if (held === undefined) return yield* store.set(aside, raw)
    }
    return yield* Effect.fail("every copy aside is taken" as const)
  })

/** The value under `key`, decoded with `json`. */
export const read = <A>(store: KeyValueStore.KeyValueStore, key: string, json: Schema.Codec<A, string>): Effect.Effect<Read<A>> =>
  readOrFail(store, key, json).pipe(
    // A storage that throws (a broken database) is a failed read, never a crash.
    Effect.catchCause(() => Effect.succeed({ _tag: "Failed" } as const))
  )

const readOrFail = <A>(store: KeyValueStore.KeyValueStore, key: string, json: Schema.Codec<A, string>): Effect.Effect<Read<A>> =>
  Effect.gen(function*() {
    const got = yield* retried(store.get(key)).pipe(Effect.result)
    if (got._tag === "Failure") return { _tag: "Failed" } as const
    const raw = got.success
    if (raw === undefined) return { _tag: "Missing" } as const
    const decoded = yield* Schema.decodeUnknownEffect(json)(raw).pipe(Effect.result)
    if (decoded._tag === "Success") return { _tag: "Read", value: decoded.success } as const
    // Only once the value is safe aside may anything be written over it.
    const kept = yield* setAside(store, key, raw).pipe(Effect.result)
    return kept._tag === "Success" ? ({ _tag: "Unreadable" } as const) : ({ _tag: "Failed" } as const)
  })

/** Writes `value` under `key`, encoded with `json`. Never fails: a write the storage refused is lost, and the game goes on. */
export const write = <A>(store: KeyValueStore.KeyValueStore, key: string, json: Schema.Codec<A, string>, value: A): Effect.Effect<void> =>
  Schema.encodeEffect(json)(value).pipe(
    Effect.flatMap((encoded) => store.set(key, encoded)),
    Effect.catchCause(() => Effect.void)
  )

/** Removes `key`. Never fails. */
export const remove = (store: KeyValueStore.KeyValueStore, key: string): Effect.Effect<void> => store.remove(key).pipe(Effect.catchCause(() => Effect.void))
