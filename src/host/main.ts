/**
 * The page: builds the stage, the track scene, the actors and the race session, then runs
 * them.
 *
 * The simulation steps at `session.hz` on ritmo's `FixedLoop`, driven by the browser's
 * animation frames (`BrowserTickSource`). Each tick reads one `DriveInput`, steps the
 * session, and hands the ghost that tick's view and events. Each frame passes the events
 * gathered since the last frame to the actors, the HUD and the sound, then updates the
 * scene, the actors, the HUD and the engine sound, and renders.
 *
 * Until the first frames are drawn the loading screen of `index.html` is up (`loading.ts`).
 *
 * The scene is drawn on WebGPU where the browser's GPU can run PixiJS 3D on it, and on WebGL
 * elsewhere (`backend.ts`; `?renderer=webgl` asks for WebGL).
 *
 * Pixi's own ticker is stopped and run from the loop's `render`, so a frame draws the
 * state the simulation just reached, and anything else on Pixi's ticker still runs.
 *
 * Every input goes through `quantise` before the session, and to the lap recorder after it
 * (`laps.ts`), so a finished lap is a replay. After the finish the brand wipes across the
 * window and behind it the page cuts to that replay, driven again in a second session
 * (`rerun.ts`): the actors, the scene and the engine sound follow it, the board opens beside
 * it, and the live car waits out of sight until the player starts again. What the page keeps (settings, name, best lap,
 * rival, runs waiting to be sent) is on Effect services over one store (`storage.ts`); the
 * leaderboard is the `Leaderboard` service, chosen here:
 * - `?server=fake`: the stand-in in the page (`online/fake.ts`), `?server=down` one that never answers;
 * - else `VITE_API_URL`, when set: the real server (`src/api/http.ts`);
 * - else none: the game plays offline, with the device's own best as the ghost.
 */
import { Clock, FixedLoop, Result } from "@typeonce/ritmo"
import { BrowserTickSource, BrowserVisibility } from "@typeonce/ritmo-browser"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { Leaderboard } from "../api/contract.ts"
import { layerHttp } from "../api/http.ts"
import { createSession, idleInput, quantise, rulesVersion, track as firstTrack, trackById, tracks, type DriveInput, type RaceEvent, type RaceSession, type RaceView, type Steering, type TrackData } from "../sim/index.ts"
import { createActors } from "./actors/index.ts"
import { createAudio } from "./audio.ts"
import { chooseBackend } from "./backend.ts"
import { Bests, boardsLayer, Rivals } from "./boards.ts"
import type { Stage } from "./contract.ts"
import { createField, type Field } from "./field.ts"
import { createGhost, type Ghost } from "./ghost.ts"
import { palette } from "./palette.ts"
import { createPassTags } from "./tags.ts"
import { createMadeWith } from "./brand/made-with.ts"
import { createHud, hudFont, hudLabelFont, panelAlpha } from "./hud.ts"
import { createInput } from "./input.ts"
import { finishLoading } from "./loading.ts"
import { createLaps, type Laps } from "./laps.ts"
import { layerDown } from "./online/down.ts"
import { createOnline, type Online, type OnlineServices } from "./online.ts"
import { createPanels } from "./panels.ts"
import { Profile, layer as profileLayer } from "./profile.ts"
import { createReplayLook } from "./replay-look.ts"
import { createRerun, type Rerun } from "./rerun.ts"
import { Settings, layer as settingsLayer } from "./settings.ts"
import { createStage } from "./stage.ts"
import { storageLayer, takeLegacySettings } from "./storage.ts"
import { createTrackScene } from "./world/index.ts"

declare global {
  interface Window {
    /** For test scripts: the running session, the stage, the ghost, the laps and the leaderboard. */
    __race?: {
      readonly session: RaceSession
      readonly stage: Stage
      readonly ghost?: Ghost
      readonly laps?: Laps
      readonly online?: Online
      readonly rerun?: Rerun
      readonly field?: Field
      /** When set, drives the car instead of the keyboard and the gamepad (`scripts/drive.ts`). */
      drive?: (view: RaceView, track: TrackData) => DriveInput
    }
  }
}

/** Waits for the HUD's web fonts, at most a moment; the system's own stand in if they fail. */
const loadFont = async (): Promise<void> => {
  const loads = Promise.all([
    ...["400", "500"].map((weight) => document.fonts.load(`${weight} 16px "${hudFont[0] ?? "monospace"}"`)),
    document.fonts.load(`600 16px "${hudLabelFont[0] ?? "sans-serif"}"`)
  ])
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2500))
  try {
    await Promise.race([loads, timeout])
  } catch {
    // The fallback font is fine.
  }
}

// ── the leaderboard and the saves ───────────────────────────────────────

const params = new URLSearchParams(window.location.search)
const apiUrl: unknown = import.meta.env.VITE_API_URL
const server = params.get("server")
const leaderboard: Layer.Layer<Leaderboard> | null =
  server === "fake"
    ? (await import("./online/fake.ts")).layerFake({ fresh: params.has("fresh"), drivers: Number(params.get("drivers") ?? 0) || 0 })
    : server === "down"
      ? layerDown
      : typeof apiUrl === "string" && apiUrl !== ""
        ? layerHttp(apiUrl)
        : null

type AppServices = OnlineServices | Settings
const app = ManagedRuntime.make(Layer.mergeAll(settingsLayer, profileLayer, boardsLayer, leaderboard ?? layerDown).pipe(Layer.provide(storageLayer)))

/** Runs an effect of the page's services off the game loop; a defect is logged, never thrown. */
const run = <A>(effect: Effect.Effect<A, never, AppServices>): Promise<A | undefined> =>
  app.runPromise(effect).catch((error: unknown) => {
    console.warn("a save or a request failed", error)
    return undefined
  })

const loaded = await run(
  Effect.gen(function*() {
    const settings = yield* Settings
    // The build before this one kept two settings in localStorage: carried over once, then dropped.
    const legacy = takeLegacySettings()
    let saved = yield* settings.saved
    if (settings.fresh && legacy.muted !== null) saved = yield* settings.change({ muted: legacy.muted })
    const profile = yield* (yield* Profile).saved
    const entry = trackById(params.get("track") ?? saved.track) ?? tracks[0] ?? { id: "spindle-leap", name: firstTrack.name, data: firstTrack }
    const best = yield* Bests.use((bests) => bests.get(entry.id, rulesVersion))
    const rival = yield* Rivals.use((rivals) => rivals.get(entry.id, rulesVersion))
    return { settings: saved, profile, entry, best, rival }
  })
)
const entry = loaded?.entry ?? tracks[0] ?? { id: "spindle-leap", name: firstTrack.name, data: firstTrack }
const track = entry.data

const switchTrack = (id: string): void => {
  void run(Settings.use((settings) => settings.change({ track: id }))).then(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete("track")
    window.location.href = url.toString()
  })
}

// ── the race ────────────────────────────────────────────────────────────

const backend = await chooseBackend()
const [stage] = await Promise.all([createStage(track, document.body, { preference: backend }), loadFont()])
const scene = createTrackScene(stage, track)
const actors = createActors(stage, track)
// One way to steer: the wheel. The simulation and a replay still know a second (pointing
// where to go), which the game no longer offers.
const session = createSession(track, "car")
const steering = (): Steering => "car"

const laps = createLaps(entry.id, loaded?.best ?? null, steering)
const ghost = createGhost()
// More ghosts beside the raced one: the board's runs just ahead, up to the player's pick (1, 5
// or 10). Dev builds only: `?ghosts=100` races a crowd of bot laps instead, to see how many the
// page can draw.
// Dev builds only: `?rank=3` shows the car as if the player held that place on the board.
const rankPreview = import.meta.env.DEV && params.has("rank") ? Number(params.get("rank")) || null : null
const crowdCount = import.meta.env.DEV && params.has("ghosts") ? Math.max(0, Math.min(1000, Number(params.get("ghosts") || 100) || 0)) : 0
const field = createField(stage.world, crowdCount > 0 ? { crowd: { track: entry.id, count: crowdCount } } : {})
const passTags = createPassTags(stage, track)
const online = createOnline({
  enabled: leaderboard !== null,
  run,
  track: entry.id,
  rules: rulesVersion,
  laps,
  ghost,
  identity: loaded?.profile.identity ?? null,
  asked: loaded?.profile.asked ?? false,
  rival: loaded?.rival ?? { version: 1, choice: { kind: "next" }, run: null },
  field: loaded?.settings.ghosts ?? 1,
  raceField: (runs) => {
    if (crowdCount === 0) field.set(runs)
  },
  tracks: tracks.map((one) => one.id)
})
const rerun = createRerun(track)
window.__race = { session, stage, ghost, laps, online, rerun, field }

const panels = createPanels({
  online,
  tracks,
  track: entry.id,
  switchTrack,
  shown: loaded?.settings.board ?? true,
  keep: (board) => void run(Settings.use((settings) => settings.change({ board }))),
  keepField: (count) => void run(Settings.use((settings) => settings.change({ ghosts: count === 10 ? 10 : count === 5 ? 5 : 1 })))
})
/** The wipe covers the window: cut to the lap just driven, and open the board beside it. */
const showLapAgain = (): void => {
  const finish = laps.lastFinish()
  if (session.view().lap.phase !== "finished" || finish === null) return
  if (finish.replay !== null) rerun.start(finish.replay)
  panels.lapShown()
}
const hud = createHud(
  stage,
  track,
  {
    best: () => laps.best(),
    ghost: () => ghost.current(),
    ghostLoading: () => online.state().ghostLoading,
    lastFinish: () => laps.lastFinish(),
    rank: () => online.state().rank,
    post: () => online.state().post,
    online: () => online.state().enabled,
    name: () => online.state().identity?.name ?? null
  },
  showLapAgain
)
createMadeWith(document, panelAlpha, backend)
const replayLook = createReplayLook(document, stage.app.canvas)
const audio = createAudio(loaded?.settings.muted ?? false)
const input = createInput(window)
online.start()

// Audio may only start after the player does something.
const unlockAudio = (): void => audio.unlock()
window.addEventListener("keydown", unlockAudio)
window.addEventListener("pointerdown", unlockAudio)

/** The gap to the raced ghost's split (or the best lap's) at a checkpoint event, or null with neither. */
const checkpointGap = (event: RaceEvent): number | null => {
  if (event.kind !== "checkpoint") return null
  // The split this checkpoint made; if the view has moved on, line `index` ends split `index - 1`
  // (line 0 is the start line).
  const found = session.view().lap.splitsMs.indexOf(event.timeMs)
  const splits = ghost.current()?.splitsMs ?? laps.best()?.splitsMs
  const reference = splits?.[found >= 0 ? found : event.index - 1]
  return reference === undefined ? null : event.timeMs - reference
}

/** Events of the player's race from the ticks since the last frame, for the frame's actors, HUD and sound. */
let pending: Array<RaceEvent> = []
/** The same from the lap being shown again: for the actors and the sound of what the car hits. */
let replayed: Array<RaceEvent> = []

/** The events of a lap shown again that are heard: what the car hit, never the lap's own chimes. */
const heardAgain = (event: RaceEvent): boolean => event.kind !== "start" && event.kind !== "checkpoint" && event.kind !== "finish" && event.kind !== "reset"

/** What the HUD should call the controls, from the last tick's input. */
let padLabel: "none" | "keyboard" | "gamepad" | "buttons-only" = "none"

/** The gamepad's answer to what the car just went through. */
const rumbleFor = (event: RaceEvent): void => {
  if (event.kind === "wall") input.rumble(Math.min(1, 0.25 + event.impact / 14), 110, true)
  else if (event.kind === "land") input.rumble(Math.min(1, 0.3 + event.impact / 14), 180, false)
  else if (event.kind === "prop") input.rumble(Math.min(1, (event.prop === "cone" ? 0.1 : event.prop === "ball" ? 0.4 : 0.25) + event.impact / 20), event.prop === "ball" ? 180 : 110, event.prop !== "ball")
  else if (event.kind === "bump") input.rumble(Math.min(1, 0.3 + event.speed / 60), 140, true)
  else if (event.kind === "bollard") input.rumble(Math.min(1, 0.4 + event.impact / 12), 160, true)
  else if (event.kind === "door") input.rumble(Math.min(1, 0.3 + event.impact / 14), 200, false)
  else if (event.kind === "boost") input.rumble(0.45, 320, false)
  else if (event.kind === "drift") input.rumble(0.25 + 0.3 * event.charge, 220, false)
  else if (event.kind === "reset" && event.reason === "off-track") input.rumble(0.8, 260, false)
}

const step = (): void => {
  const read = input.read()
  const label = read.pad.kind === "none" ? "none" : read.pad.kind === "buttons-only" ? "buttons-only" : read.pad.active ? "gamepad" : "keyboard"
  if (label !== padLabel) {
    if (padLabel === "none") hud.toast(label === "buttons-only" ? "gamepad connected: buttons only" : "gamepad connected")
    else if (label === "none") hud.toast("gamepad disconnected")
    // Sound may start on a key or a click; a pad's buttons are worth a try as well.
    if (label === "gamepad") audio.unlock()
    padLabel = label
  }
  if (read.toggleMute) {
    audio.setMuted(!audio.muted())
    const muted = audio.muted()
    void run(Settings.use((settings) => settings.change({ muted })))
    hud.toast(muted ? "sound off" : "sound on")
  }
  const wanted = window.__race?.drive?.(session.view(), track) ?? read.drive
  // While the lap is shown again the player's car is out of sight: only starting again reaches it.
  // While the whole board is open over the race the car is left alone.
  const asked = panels.modal() ? idleInput : rerun.active() ? { ...idleInput, restart: wanted.restart } : wanted
  // The simulation is given what a replay can hold, so the replay drives the same lap.
  const drive = quantise(asked)
  session.tick(drive)
  const events = session.drainEvents()
  const finish = laps.afterTick(drive, session.view(), events)
  if (finish !== null) online.finished(finish)
  for (const event of events) {
    if (event.kind === "reset") {
      // Starting again is immediate: the replay, its board and what it left for this frame go.
      rerun.stop()
      replayed = []
      panels.lapReset()
    } else if (rerun.active()) {
      // What the unseen car rolls into is neither drawn nor heard.
      continue
    }
    pending.push(event)
  }
  if (rerun.active()) for (const event of rerun.tick()) replayed.push(event)
}

/** The time between drawn frames, measured here since the loop's own is clamped. */
let lastFrame = performance.now()
/** Frames drawn so far, up to the few after which the loading screen goes: the first ones compile the scene's shaders. */
let framesDrawn = 0

const loop = FixedLoop.start({
  source: BrowserTickSource.make(window),
  // The session states its rate at run time; the cast only crosses Clock.hz's compile-time
  // check for a literal, and Clock.hz still checks the value when it runs.
  step: Clock.hz(session.hz as 120),
  // A hidden tab stops sending frames; on return at most a quarter second is caught up.
  maxFrameSeconds: 0.25,
  maxStepsPerFrame: 30,
  update: () => {
    try {
      step()
      return Result.success(undefined)
    } catch (error) {
      return Result.failure(error)
    }
  },
  render: () => {
    const nowMs = performance.now()
    const seconds = Math.min(0.1, (nowMs - lastFrame) / 1000)
    lastFrame = nowMs
    const view = session.view()
    const replaying = rerun.active()
    // What is drawn: the lap shown again, or the player's race.
    const shown = replaying ? rerun.view() : view
    const events = pending
    pending = []
    for (const event of events) {
      if (event.kind === "start") panels.lapStarted()
      else if (event.kind === "finish") panels.lapFinished()
      actors.handle(event, view)
      hud.handle(event, view)
      audio.handle(event, view, checkpointGap(event))
      rumbleFor(event)
    }
    const again = replayed
    replayed = []
    for (const event of again) {
      actors.handle(event, shown)
      if (heardAgain(event)) audio.handle(event, shown, null)
    }
    scene.update(shown, seconds)
    const ghostPose = ghost.pose(shown, view.lap.phase === "running")
    actors.standing(rankPreview ?? online.state().rank?.rank ?? null)
    actors.update(shown, ghostPose, seconds)
    field.update(shown, view.lap.phase === "running")
    const raced = ghost.current()
    // Passing your own best gets no tag: it would only say your name, right over your car (the
    // ghost drives your line), and the delta already tells you are ahead.
    const racedTag = raced === null || raced.kind === "own" ? "" : raced.name
    passTags.update(shown, raced === null ? field.ghosts() : [{ key: "raced", name: racedTag, color: palette.ghost, pose: ghostPose }, ...field.ghosts()], seconds)
    hud.update(view, { pad: padLabel, car: shown.car, replay: replaying }, seconds)
    panels.update(view.lap.phase === "running")
    replayLook.show(replaying)
    audio.update(shown)
    stage.app.ticker.update(nowMs)
    if (framesDrawn < 3 && ++framesDrawn === 3) finishLoading(document)
  },
  onFailure: (failure) => console.error("the race loop stopped", failure)
})

if (loop.ok) {
  stage.app.ticker.stop()
  // Coming back to the tab starts from now instead of catching up the time away.
  BrowserVisibility.make(document).subscribe((hidden) => {
    if (!hidden) loop.value.reset()
  })
} else {
  console.error("the race loop could not start", loop.error)
}
