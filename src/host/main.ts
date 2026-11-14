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
 * Pixi's own ticker is stopped and run from the loop's `render`, so a frame draws the
 * state the simulation just reached, and anything else on Pixi's ticker still runs.
 */
import { Clock, FixedLoop, Result } from "@typeonce/ritmo"
import { BrowserTickSource, BrowserVisibility } from "@typeonce/ritmo-browser"
import { createSession, track, type RaceEvent, type RaceSession } from "../sim/index.ts"
import { createActors } from "./actors/index.ts"
import { createAudio } from "./audio.ts"
import type { Stage } from "./contract.ts"
import { createGhost, type Ghost } from "./ghost.ts"
import { createHud, hudFont, hudLabelFont, steeringName } from "./hud.ts"
import { createInput } from "./input.ts"
import { createStage } from "./stage.ts"
import { loadMuted, loadVariant, saveMuted, saveVariant } from "./storage.ts"
import { createTrackScene } from "./world/index.ts"

declare global {
  interface Window {
    /** For test scripts: the running session and the stage, and the ghost of the best lap. */
    __race?: { readonly session: RaceSession; readonly stage: Stage; readonly ghost?: Ghost }
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

const [stage] = await Promise.all([createStage(track, document.body), loadFont()])
const scene = createTrackScene(stage, track)
const actors = createActors(stage, track)
const session = createSession(track)
window.__race = { session, stage }

const stored = loadVariant()
if (stored !== null && session.variants.includes(stored)) session.setVariant(stored)

const ghost = createGhost(track, session.hz)
window.__race = { session, stage, ghost }
const hud = createHud(stage, track, ghost)
const audio = createAudio(loadMuted())
const input = createInput(window)

// Audio may only start after the player does something.
const unlockAudio = (): void => audio.unlock()
window.addEventListener("keydown", unlockAudio)
window.addEventListener("pointerdown", unlockAudio)

/** The gap to the best lap's split at a checkpoint event, or null with no best lap. */
const checkpointGap = (event: RaceEvent): number | null => {
  if (event.kind !== "checkpoint") return null
  // The split this checkpoint made; if the view has moved on, line `index` ends split `index - 1`
  // (line 0 is the start line).
  const found = session.view().lap.splitsMs.indexOf(event.timeMs)
  const best = ghost.best()?.splitsMs[found >= 0 ? found : event.index - 1]
  return best === undefined ? null : event.timeMs - best
}

/** Events from the ticks since the last frame, for the frame's actors, HUD and sound. */
let pending: Array<RaceEvent> = []

/** What the HUD should call the controls, from the last tick's input. */
let padLabel: "none" | "keyboard" | "gamepad" | "buttons-only" = "none"

/** The gamepad's answer to what the car just went through. */
const rumbleFor = (event: RaceEvent): void => {
  if (event.kind === "wall") input.rumble(Math.min(1, 0.25 + event.impact / 14), 110, true)
  else if (event.kind === "land") input.rumble(Math.min(1, 0.3 + event.impact / 14), 180, false)
  else if (event.kind === "prop") input.rumble(Math.min(1, (event.prop === "cone" ? 0.1 : event.prop === "ball" ? 0.4 : 0.25) + event.impact / 20), event.prop === "ball" ? 180 : 110, event.prop !== "ball")
  else if (event.kind === "bollard") input.rumble(Math.min(1, 0.4 + event.impact / 12), 160, true)
  else if (event.kind === "door") input.rumble(Math.min(1, 0.3 + event.impact / 14), 200, false)
  else if (event.kind === "boost") input.rumble(0.45, 320, false)
  else if (event.kind === "reset" && event.reason === "off-track") input.rumble(0.8, 260, false)
}

const step = (): void => {
  const variant = session.variant()
  const read = input.read(variant.startsWith("screen"), stage.groundDirection)
  if (read.cycleVariant && session.variants.length > 1) {
    const next = session.variants[(session.variants.indexOf(variant) + 1) % session.variants.length] ?? variant
    session.setVariant(next)
    saveVariant(next)
    hud.toast(`steering: ${steeringName(next)}`)
  }
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
    saveMuted(audio.muted())
    hud.toast(audio.muted() ? "sound off" : "sound on")
  }
  session.tick(read.drive)
  const events = session.drainEvents()
  ghost.afterTick(session.view(), events)
  for (const event of events) pending.push(event)
}

/** The time between drawn frames, measured here since the loop's own is clamped. */
let lastFrame = performance.now()

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
    const events = pending
    pending = []
    for (const event of events) {
      actors.handle(event, view)
      hud.handle(event, view)
      audio.handle(event, view, checkpointGap(event))
      rumbleFor(event)
    }
    scene.update(view, seconds)
    actors.update(view, ghost.pose(view), seconds)
    hud.update(view, { variant: session.variant(), muted: audio.muted(), pad: padLabel }, seconds)
    audio.update(view)
    stage.app.ticker.update(nowMs)
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
