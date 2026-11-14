/**
 * The player's settings: how they steer, whether the sound is on, and the track they last
 * drove. One value, kept for the whole device. Loading never fails: an unreadable value is
 * kept aside and the defaults stand in.
 */
import { Context, Effect, Layer, Ref, Schema } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { Steering } from "../api/contract.ts"
import { read, write } from "./persisted.ts"
import { gameStore } from "./storage.ts"

export const settingsKey = "settings"

export const SettingsV1 = Schema.Struct({
  version: Schema.Literal(1),
  steering: Steering,
  muted: Schema.Boolean,
  /** The id of the track last driven, or "" for the first. */
  track: Schema.String
})
const SettingsJson = Schema.fromJsonString(Schema.Union([SettingsV1]))
const LatestJson = Schema.fromJsonString(SettingsV1)
export type SavedSettings = typeof SettingsV1.Type

export const defaultSettings: SavedSettings = { version: 1, steering: "car", muted: false, track: "" }

export interface SettingsShape {
  readonly saved: Effect.Effect<SavedSettings>
  /** Whether nothing was saved before this visit (so older saves may seed it). */
  readonly fresh: boolean
  readonly change: (patch: Partial<Omit<SavedSettings, "version">>) => Effect.Effect<SavedSettings>
}

export class Settings extends Context.Service<Settings, SettingsShape>()("Tabletop/Settings") {}

export const layer: Layer.Layer<Settings, never, KeyValueStore.KeyValueStore> = Layer.effect(
  Settings,
  Effect.gen(function*() {
    const store = yield* gameStore
    const loaded = yield* read(store, settingsKey, SettingsJson)
    const writable = loaded._tag !== "Failed"
    const saved = yield* Ref.make<SavedSettings>(loaded._tag === "Read" ? loaded.value : defaultSettings)
    return Settings.of({
      saved: Ref.get(saved),
      fresh: loaded._tag === "Missing",
      change: (patch) =>
        Ref.updateAndGet(saved, (current) => ({ ...current, ...patch })).pipe(
          Effect.tap((current) => (writable ? write(store, settingsKey, LatestJson, current) : Effect.void))
        )
    })
  })
)
