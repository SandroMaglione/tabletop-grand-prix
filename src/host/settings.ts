/**
 * The player's settings: whether the sound is on, the track they last drove, whether they keep the leaderboard up, how many ghosts they race, and whether the email sign-up may still be offered. One value, kept for the whole device. Loading never fails: an unreadable value is
 * kept aside and the defaults stand in.
 */
import { Context, Effect, Layer, Ref, Schema } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { read, write } from "./persisted.ts"
import { gameStore } from "./storage.ts"

export const settingsKey = "settings"

/** Until the game had one way to steer, the settings also held which. */
const SettingsV1 = Schema.Struct({
  version: Schema.Literal(1),
  steering: Schema.String,
  muted: Schema.Boolean,
  track: Schema.String
})
/** Until the leaderboard was up by default, the settings did not say whether the player keeps it up. */
const SettingsV2 = Schema.Struct({
  version: Schema.Literal(2),
  muted: Schema.Boolean,
  track: Schema.String
})
/** Until the player could race more than one ghost. */
export const SettingsV3 = Schema.Struct({
  version: Schema.Literal(3),
  muted: Schema.Boolean,
  /** The id of the track last driven, or "" for the first. */
  track: Schema.String,
  /** The leaderboard is up whenever no lap runs; false once the player has closed it. */
  board: Schema.Boolean
})
/** Until the replay could offer the email sign-up. */
export const SettingsV4 = Schema.Struct({
  version: Schema.Literal(4),
  muted: Schema.Boolean,
  /** The id of the track last driven, or "" for the first. */
  track: Schema.String,
  /** The leaderboard is up whenever no lap runs; false once the player has closed it. */
  board: Schema.Boolean,
  /** How many ghosts to race, the raced one included: 1, 5 or 10. */
  ghosts: Schema.Union([Schema.Literal(1), Schema.Literal(5), Schema.Literal(10)])
})
export const SettingsV5 = Schema.Struct({
  version: Schema.Literal(5),
  muted: Schema.Boolean,
  /** The id of the track last driven, or "" for the first. */
  track: Schema.String,
  /** The leaderboard is up whenever no lap runs; false once the player has closed it. */
  board: Schema.Boolean,
  /** How many ghosts to race, the raced one included: 1, 5 or 10. */
  ghosts: Schema.Union([Schema.Literal(1), Schema.Literal(5), Schema.Literal(10)]),
  /** The replay may offer the email sign-up; false once the player has signed up or closed it. */
  signup: Schema.Boolean
})
const SettingsJson = Schema.fromJsonString(Schema.Union([SettingsV1, SettingsV2, SettingsV3, SettingsV4, SettingsV5]))
const LatestJson = Schema.fromJsonString(SettingsV5)
export type SavedSettings = typeof SettingsV5.Type

export const defaultSettings: SavedSettings = { version: 5, muted: false, track: "", board: true, ghosts: 1, signup: true }

/** A saved value of any version as the latest. */
const latest = (saved: typeof SettingsV1.Type | typeof SettingsV2.Type | typeof SettingsV3.Type | typeof SettingsV4.Type | SavedSettings): SavedSettings => {
  if (saved.version === 5) return saved
  if (saved.version === 4) return { ...saved, version: 5, signup: true }
  return { version: 5, muted: saved.muted, track: saved.track, board: saved.version === 3 ? saved.board : true, ghosts: 1, signup: true }
}

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
    const saved = yield* Ref.make<SavedSettings>(loaded._tag === "Read" ? latest(loaded.value) : defaultSettings)
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
