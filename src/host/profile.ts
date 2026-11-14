/**
 * Who this device is on the leaderboard: the `Identity` the server gave it (null until the
 * player picks a name), and whether the player has been asked for a name yet, so a player
 * who chose to stay unlisted is not asked after every lap. One value for the whole device:
 * a name is the same on every track.
 */
import { Context, Effect, Layer, Ref, Schema } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { Identity } from "../api/contract.ts"
import { read, write } from "./persisted.ts"
import { gameStore } from "./storage.ts"

export const profileKey = "profile"

export const ProfileV1 = Schema.Struct({
  version: Schema.Literal(1),
  identity: Schema.NullOr(Identity),
  /** The player has been offered a name once (and picked one, or skipped). */
  asked: Schema.Boolean
})
const ProfileJson = Schema.fromJsonString(Schema.Union([ProfileV1]))
const LatestJson = Schema.fromJsonString(ProfileV1)
export type SavedProfile = typeof ProfileV1.Type

const nobody: SavedProfile = { version: 1, identity: null, asked: false }

export interface ProfileShape {
  readonly saved: Effect.Effect<SavedProfile>
  readonly setIdentity: (identity: Identity | null) => Effect.Effect<SavedProfile>
  readonly markAsked: Effect.Effect<SavedProfile>
}

export class Profile extends Context.Service<Profile, ProfileShape>()("Tabletop/Profile") {}

export const layer: Layer.Layer<Profile, never, KeyValueStore.KeyValueStore> = Layer.effect(
  Profile,
  Effect.gen(function*() {
    const store = yield* gameStore
    const loaded = yield* read(store, profileKey, ProfileJson)
    const writable = loaded._tag !== "Failed"
    const saved = yield* Ref.make<SavedProfile>(loaded._tag === "Read" ? loaded.value : nobody)
    const change = (next: (current: SavedProfile) => SavedProfile): Effect.Effect<SavedProfile> =>
      Ref.updateAndGet(saved, next).pipe(Effect.tap((current) => (writable ? write(store, profileKey, LatestJson, current) : Effect.void)))
    return Profile.of({
      saved: Ref.get(saved),
      setIdentity: (identity) => change((current) => ({ ...current, identity, asked: true })),
      markAsked: change((current) => ({ ...current, asked: true }))
    })
  })
)
