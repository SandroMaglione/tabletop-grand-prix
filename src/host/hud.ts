/**
 * The HUD: a few small dark panels drawn with Pixi 2D over the corners of the 3D view, in
 * the manner of a racing game's timing screens: a pale glassy rim, a hatched header, rows as
 * bars, a state shown as a hatched band of colour. The map is the picture; the HUD stays out
 * of its way.
 *
 * - top left: the timing panel. Its header is the Typeonce plate, a link to typeonce.games
 *   (`brand/plate.ts`; after a lap the brand wipes across the whole window, and behind it
 *   the page cuts to the replay of the lap). The panel is away while the lap is shown again:
 *   the lap is over, its time is on the result, and the board has the plate. Then
 *   the lap clock and the medals earned, the best lap (with the player's place on the
 *   board), the ghost being raced, the sectors as tabs (the one being driven is lit, a
 *   finished one is edged green or red), the gap to the ghost at the last line crossed, and
 *   the next medal's time.
 * - bottom right: the speed, with a bar, and under it the drift: its name, the key that makes
 *   it (Z, or the two triggers on a gamepad), and a bar that fills as a slide earns
 *   its push. It is always there, so the panel itself says the car can drift; nothing else
 *   on screen explains it.
 * - bottom centre: short messages ("off the road", a changed setting) and the result when a
 *   lap is done, with the board's answer when it was sent.
 * - top centre: `REPLAY`, while the lap just driven is shown again; `WATCHING` with the place,
 *   the driver, the time and the key that ends it while a run of the board is watched.
 *   Watching hides the result of the player's own lap and how to start.
 * - the middle of the map: how to start, only when the car has waited on the line for a
 *   few seconds with nothing pressed. The controls are not otherwise explained.
 *
 * The leaderboard's own panels (the board, the name) are DOM over the top right corner:
 * `panels.ts`.
 *
 * Laid out in CSS pixels from `app.screen` on every resize, and scaled down a little on
 * small windows. Text is drawn at the renderer's resolution.
 */
import { Container, Graphics, Text, type TextStyleOptions } from "pixi.js"
import type { CarView, RaceEvent, RaceView, TrackData } from "../sim/index.ts"
import type { Stage } from "./contract.ts"
import type { RaceGhost } from "./ghost.ts"
import type { FinishResult } from "./laps.ts"
import type { PostState } from "./online.ts"
import type { WatchedRun } from "./rerun.ts"
import { createBrandPlate } from "./brand/plate.ts"
import { palette } from "./palette.ts"

/** What the HUD shows about laps, ghosts and the board. */
export interface HudSource {
  /** The device's best lap. */
  best(): { readonly timeMs: number; readonly splitsMs: ReadonlyArray<number> } | null
  /** The ghost being raced. */
  ghost(): RaceGhost | null
  ghostLoading(): boolean
  lastFinish(): FinishResult | null
  /** The player's place on the board, when known. */
  rank(): { readonly rank: number; readonly total: number } | null
  /** What became of the last best lap sent, and the attempt it was driven in. */
  post(): { readonly attempt: number; readonly state: PostState } | null
  /** A leaderboard is configured. */
  online(): boolean
  /** The player's name on the board, when they have one. */
  name(): string | null
}

export interface HudState {
  /** Which buttons the start prompt names: the gamepad's when it was the last device used. */
  readonly pad: "none" | "keyboard" | "gamepad" | "buttons-only"
  /** The car on screen: the player's, or the replay's while the lap is shown again. */
  readonly car: CarView
  /** What is shown again instead of the race: the lap just driven, a run of the board, or nothing. */
  readonly replay: { readonly kind: "lap" } | { readonly kind: "run"; readonly run: WatchedRun } | null
}

export interface Hud {
  handle(event: RaceEvent, view: RaceView): void
  /** A short message at the bottom, for a moment (a changed setting). */
  toast(text: string): void
  update(view: RaceView, state: HudState, seconds: number): void
}

/** Numbers: monospaced, so a running clock does not shake. Then the system's own if the web font did not load. */
export const hudFont = ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"]
/** Labels: a wide, squared sans, always in capitals. */
export const hudLabelFont = ["Chakra Petch", "Eurostile", "Helvetica Neue", "Arial", "sans-serif"]

/** `m:ss.mmm`. */
export const formatTime = (ms: number): string => {
  const whole = Math.max(0, Math.floor(ms))
  const minutes = Math.floor(whole / 60000)
  const seconds = Math.floor((whole % 60000) / 1000)
  const millis = whole % 1000
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`
}

/** A gap in seconds with a sign: `+0.123` behind, `−0.123` ahead. */
export const formatGap = (ms: number): string => `${ms <= 0 ? "−" : "+"}${(Math.abs(ms) / 1000).toFixed(3)}`

/** The board's answer to a lap, in a few words. `name` is what the player is called on the board, so a made-up name is seen at once. */
export const postLine = (state: PostState, name: string | null): { readonly text: string; readonly tone: "accent" | "dim" | "bad" } => {
  switch (state.kind) {
    case "sending":
      return { text: "SENDING TO THE BOARD…", tone: "dim" }
    case "sent":
      return { text: name === null ? `#${state.rank} OF ${state.total}` : `#${state.rank} OF ${state.total} · ${name.toUpperCase()}`, tone: "accent" }
    case "waiting":
      return { text: "SAVED · SENDS WHEN ONLINE", tone: "dim" }
    case "unlisted":
      return { text: "NOT ON THE BOARD · L TO PICK A NAME", tone: "dim" }
    case "refused":
      return { text: "THE BOARD COULD NOT FILE THIS LAP", tone: "bad" }
  }
}

const margin = 12
const radius = 9
/** The pale rim of every panel. */
const rim = 3

const number = (size: number, fill: number, weight: "400" | "500" | "700" = "500"): TextStyleOptions => ({ fontFamily: hudFont, fontSize: size, fontWeight: weight, fill })
const label = (size: number, fill: number): TextStyleOptions => ({ fontFamily: hudLabelFont, fontSize: size, fontWeight: "600", fill, letterSpacing: 0.6 })

const text = (parent: Container, value: string, options: TextStyleOptions): Text => {
  const t = new Text({ text: value, style: options })
  parent.addChild(t)
  return t
}

/** How much of the map shows through a panel. */
export const panelAlpha = 0.6

/** How long the car waits on the line with nothing pressed before the HUD says how to start, seconds. */
const promptAfter = 5

/** A dark panel the map shows through, inside a pale glassy rim. */
const drawPanel = (g: Graphics, width: number, height: number): void => {
  g.clear()
  g.roundRect(0, 0, width, height, radius).fill({ color: palette.hudBack, alpha: panelAlpha })
  g.roundRect(rim / 2, rim / 2, width - rim, height - rim, radius - rim / 2).stroke({ color: palette.hudText, alpha: 0.24, width: rim })
}

/** Diagonal stripes over a `width` by `height` box at the origin. The caller masks them to the box. */
const drawHatch = (g: Graphics, width: number, height: number, colour: number, alpha: number): void => {
  const stripe = 5
  const gap = 9
  for (let x = -height; x < width; x += stripe + gap) {
    g.poly([x, height, x + stripe, height, x + stripe + height, 0, x + height, 0]).fill({ color: colour, alpha })
  }
}

/** A band of colour with stripes, masked to its box: a state, the way a timing screen shows one. */
const makeBand = (parent: Container, x: number, y: number, width: number, height: number) => {
  const band = new Graphics()
  band.position.set(x, y)
  const mask = new Graphics()
  mask.rect(0, 0, width, height).fill(0xffffff)
  mask.position.set(x, y)
  parent.addChild(band, mask)
  band.mask = mask
  return {
    /** Paints the band, or clears it with a null colour. */
    paint(colour: number | null): void {
      band.clear()
      if (colour === null) return
      band.rect(0, 0, width, height).fill({ color: colour, alpha: 0.82 })
      drawHatch(band, width, height, 0xffffff, 0.13)
    }
  }
}

const medalNames = ["bronze", "silver", "gold"] as const
const medalColour = { bronze: palette.bronze, silver: palette.silver, gold: palette.gold } as const

/**
 * `covered` is called after a finished lap, at the moment the brand's wipe hides the whole
 * window: the page changes what is behind it then.
 */
export const createHud = (stage: Stage, track: TrackData, source: HudSource, covered: () => void): Hud => {
  const root = new Container()
  stage.app.stage.addChild(root)
  const sectorCount = Math.max(1, track.checkpoints.length)

  // ── top left: the timing panel ─────────────────────────────────────────
  /** Wide enough for the longest name (16 letters) beside the ghost's time. */
  const towerW = 268
  const pad = 14
  /** The header is the Typeonce plate, a DOM link laid over this space. */
  const headH = 40
  const clockH = 54
  const rowH = 31
  const tabsH = 24
  const deltaH = 38
  const clockY = headH
  const bestY = clockY + clockH
  const ghostY = bestY + rowH
  const tabsY = ghostY + rowH
  const deltaY = tabsY + tabsH
  const targetY = deltaY + deltaH
  const towerH = targetY + rowH + rim
  const inner = towerW - rim * 2
  const tower = new Container()
  const towerBg = new Graphics()
  tower.addChild(towerBg)
  drawPanel(towerBg, towerW, towerH)
  const clockText = text(tower, "0:00.000", number(28, palette.hudText))
  clockText.anchor.set(0, 0.5)
  clockText.position.set(pad, clockY + clockH / 2)
  // The medals earned, beside the clock.
  const medals = medalNames.map((name, i) => {
    const dot = new Graphics()
    dot.position.set(towerW - pad - 5 - (2 - i) * 14, clockY + clockH / 2)
    tower.addChild(dot)
    return { name, dot, earned: null as boolean | null }
  })

  /** A line of the panel: a darker bar with a label on the left and a value on the right. */
  const makeRow = (y: number, name: string) => {
    towerBg.rect(rim, y + 1, inner, rowH - 2).fill({ color: palette.hudHead, alpha: 0.42 })
    const nameText = text(tower, name, label(12, palette.hudDim))
    nameText.anchor.set(0, 0.5)
    nameText.position.set(pad, y + rowH / 2)
    const value = text(tower, "", number(13, palette.hudText))
    value.anchor.set(1, 0.5)
    value.position.set(towerW - pad, y + rowH / 2)
    return { name: nameText, value, key: "" }
  }
  const bestRow = makeRow(bestY, "BEST")
  const rankText = text(tower, "", number(11, palette.hudDim, "400"))
  rankText.anchor.set(1, 0.5)
  rankText.position.set(towerW - pad - 74, bestY + rowH / 2)
  // The ghost being raced: its driver and time, with a dot in the ghost's colour.
  const ghostRow = makeRow(ghostY, "")
  const ghostDot = new Graphics()
  ghostDot.position.set(pad + 5, ghostY + rowH / 2)
  tower.addChild(ghostDot)
  ghostRow.name.position.x = pad + 16

  // The sectors as tabs, and under them the gap to the ghost at the last line crossed.
  const tabW = inner / sectorCount
  const tabs = Array.from({ length: sectorCount }, (_, i) => {
    const cell = new Graphics()
    cell.position.set(rim + i * tabW, tabsY)
    tower.addChild(cell)
    const name = text(tower, `S${i + 1}`, label(11, palette.hudDim))
    name.anchor.set(0.5, 0.5)
    name.position.set(rim + (i + 0.5) * tabW, tabsY + tabsH / 2)
    return { cell, name, key: "" }
  })
  const deltaBand = makeBand(tower, rim, deltaY, inner, deltaH)
  const deltaName = text(tower, "DELTA", label(12, palette.hudDim))
  deltaName.anchor.set(0, 0.5)
  deltaName.position.set(pad, deltaY + deltaH / 2)
  const deltaValue = text(tower, "", number(16, palette.hudText, "700"))
  deltaValue.anchor.set(1, 0.5)
  deltaValue.position.set(towerW - pad, deltaY + deltaH / 2)
  let deltaKey = ""

  const targetRow = makeRow(targetY, "")
  const targetDot = new Graphics()
  targetDot.position.set(pad + 5, targetY + rowH / 2)
  tower.addChild(targetDot)
  targetRow.name.position.x = pad + 16
  root.addChild(tower)

  // ── bottom right: speed ───────────────────────────────────────────────
  const speedW = 150
  const driftRowH = 38
  const speedH = 66 + driftRowH
  const speedPanel = new Container()
  const speedBg = new Graphics()
  speedPanel.addChild(speedBg)
  drawPanel(speedBg, speedW, speedH)
  const speedText = text(speedPanel, "0", number(24, palette.hudText))
  speedText.anchor.set(1, 0.5)
  speedText.position.set(speedW - pad - 44, 27)
  const unitText = text(speedPanel, "KM/H", label(11, palette.hudDim))
  unitText.anchor.set(1, 0.5)
  unitText.position.set(speedW - pad, 29)
  const speedBar = new Graphics()
  speedBar.position.set(pad, 66 - 17)
  speedPanel.addChild(speedBar)
  // The drift: a darker row under the speed, like the timing panel's rows.
  speedBg.rect(rim, 62, speedW - rim * 2, driftRowH - rim - 1).fill({ color: palette.hudHead, alpha: 0.42 })
  const driftName = text(speedPanel, "DRIFT", label(11, palette.hudDim))
  driftName.anchor.set(0, 0.5)
  driftName.position.set(pad, 74)
  const driftKeys = text(speedPanel, "", number(11, palette.hudDim))
  driftKeys.anchor.set(1, 0.5)
  driftKeys.position.set(speedW - pad, 74)
  const driftBar = new Graphics()
  driftBar.position.set(pad, 86)
  speedPanel.addChild(driftBar)
  root.addChild(speedPanel)
  let speedKey = ""
  let driftKey = ""
  /** Until when (`now`) the drift bar flashes for a push just paid. */
  let driftPaidUntil = -1

  // ── bottom centre: messages ────────────────────────────────────────────
  const messageH = 40
  const message = new Container()
  const messageBg = new Graphics()
  message.addChild(messageBg)
  const messageText = text(message, "", label(13, palette.hudText))
  messageText.anchor.set(0.5, 0.5)
  messageText.position.set(0, messageH / 2)
  root.addChild(message)
  let messageKey = ""

  // ── bottom centre: the result ──────────────────────────────────────────
  // The gap to the best lap on a band of its colour, the medal under it, the board's answer last.
  const resultW = 340
  const resultGapH = 40
  const resultH = resultGapH + 38
  const resultBoardH = 28
  const result = new Container()
  const resultBg = new Graphics()
  result.addChild(resultBg)
  resultBg.position.set(-resultW / 2, 0)
  const resultBand = makeBand(result, -resultW / 2 + rim, rim, resultW - rim * 2, resultGapH - rim)
  const resultGap = text(result, "", number(16, palette.hudText, "700"))
  resultGap.anchor.set(0.5, 0.5)
  resultGap.position.set(0, resultGapH / 2 + 1)
  const resultMedalDot = new Graphics()
  result.addChild(resultMedalDot)
  const resultMedal = text(result, "", label(12, palette.hudText))
  resultMedal.anchor.set(0.5, 0.5)
  resultMedal.position.set(0, resultGapH + 18)
  const resultBoard = text(result, "", label(12, palette.hudAccent))
  resultBoard.anchor.set(0.5, 0.5)
  resultBoard.position.set(0, resultH + 9)
  let resultBoardKey = "unset"
  result.visible = false
  root.addChild(result)
  let resultAttempt = -1
  let resultWon: (typeof medalNames)[number] | null = null
  let resultMedalKey = ""

  // ── top centre: a lap is being shown again ─────────────────────────────
  // The panel is as wide as its dot and its words, with the same space at both ends.
  const replayH = 34
  const replayPad = 15
  const replayGap = 10
  const replayTag = new Container()
  const replayBg = new Graphics()
  replayTag.addChild(replayBg)
  const replayDot = new Graphics()
  replayDot.circle(0, 0, 5).fill(palette.hudBad)
  replayTag.addChild(replayDot)
  const replayText = text(replayTag, "REPLAY", label(13, palette.hudText))
  replayText.anchor.set(0, 0.5)
  // A watched run's place, driver and time, after the word.
  const replayRank = text(replayTag, "", number(13, palette.hudAccent))
  const replayName = text(replayTag, "", label(13, palette.hudText))
  const replayTime = text(replayTag, "", number(13, palette.hudDim))
  const replayHint = text(replayTag, "", label(11, palette.hudDim))
  const watchParts = [replayRank, replayName, replayTime, replayHint]
  for (const part of watchParts) part.anchor.set(0, 0.5)
  let replayKey = ""
  const drawReplayTag = (watched: WatchedRun | null, onPad: boolean): void => {
    const key = watched === null ? "lap" : `${watched.runId}:${watched.rank}:${watched.sector}:${onPad}`
    if (key === replayKey) return
    replayKey = key
    replayText.text = watched === null ? "REPLAY" : watched.sector === null ? "WATCHING" : `WATCHING S${watched.sector + 1}`
    replayRank.text = watched === null ? "" : `P${watched.rank}`
    replayName.text = watched === null ? "" : watched.mine ? "YOUR BEST" : watched.name.toUpperCase()
    replayTime.text = watched === null ? "" : formatTime(watched.timeMs)
    replayHint.text = watched === null ? "" : `${onPad ? "Y" : "R"} TO DRIVE`
    const parts = [replayText, ...(watched === null ? [] : watchParts)]
    const width = Math.ceil(replayPad + 10 + 9 + parts.reduce((sum, part) => sum + part.width, 0) + replayGap * (parts.length - 1) + replayPad)
    drawPanel(replayBg, width, replayH)
    replayBg.position.set(-width / 2, 0)
    replayDot.position.set(-width / 2 + replayPad + 5, replayH / 2)
    let x = -width / 2 + replayPad + 10 + 9
    for (const part of parts) {
      part.position.set(x, replayH / 2)
      x += part.width + replayGap
    }
    for (const part of watchParts) part.visible = watched !== null
  }
  drawReplayTag(null, false)
  replayTag.visible = false
  root.addChild(replayTag)

  // ── the middle of the map: how to start ────────────────────────────────
  // The arrow keys as they sit on a keyboard, raised like real keys, and the one that goes
  // being pressed over and over; three words under them.
  const prompt = new Container()
  const promptBg = new Graphics()
  prompt.addChild(promptBg)
  const keySize = 52
  const keyDepth = 9
  const keyGap = 8
  const promptW = keySize * 3 + keyGap * 2 + 72
  const promptH = (keySize + keyDepth) * 2 + keyGap + 96
  drawPanel(promptBg, promptW, promptH)
  promptBg.position.set(-promptW / 2, -promptH / 2)
  const keysTop = -promptH / 2 + 30
  const keys = (["up", "left", "down", "right"] as const).map((name) => {
    const column = name === "left" ? -1 : name === "right" ? 1 : 0
    const row = name === "up" ? 0 : 1
    const x = column * (keySize + keyGap) - keySize / 2
    const y = keysTop + row * (keySize + keyDepth + keyGap)
    const cap = new Graphics()
    cap.position.set(x, y)
    prompt.addChild(cap)
    const arrow = text(prompt, name === "up" ? "↑" : name === "left" ? "←" : name === "down" ? "↓" : "→", number(22, palette.hudText, "700"))
    arrow.anchor.set(0.5, 0.5)
    arrow.position.set(x + keySize / 2, y + keySize / 2)
    return { name, cap, arrow, y }
  })
  // On a gamepad the one thing to press is the right trigger.
  const triggerW = 84
  const trigger = new Graphics()
  trigger.position.set(-triggerW / 2, keysTop + 26)
  prompt.addChild(trigger)
  const triggerText = text(prompt, "RT", number(22, palette.hudBack, "700"))
  triggerText.anchor.set(0.5, 0.5)
  const promptText = text(prompt, "", label(15, palette.hudText))
  promptText.anchor.set(0.5, 0.5)
  promptText.position.set(0, promptH / 2 - 30)
  prompt.alpha = 0
  prompt.visible = false
  root.addChild(prompt)
  let promptKey = ""
  /** Seconds the car has waited on the line with nothing pressed. */
  let waited = 0

  /**
   * One key seen a little from above: its skirt, its face `down` pixels into it, a soft
   * shine on the face's upper half. `lit` is the key that goes.
   */
  const drawKey = (g: Graphics, width: number, down: number, lit: boolean): void => {
    const face = lit ? palette.hudAccent : 0x3a4160
    const skirt = lit ? 0x9c8410 : 0x161a2c
    g.clear()
    // The shadow the key throws on the panel shrinks as it goes down.
    g.roundRect(2, keyDepth + 3, width - 4, keySize, 10).fill({ color: 0x000000, alpha: 0.28 - 0.02 * down })
    g.roundRect(0, keyDepth, width, keySize, 10).fill({ color: skirt })
    g.roundRect(0, down, width, keySize, 10).fill({ color: face })
    g.roundRect(0.75, down + 0.75, width - 1.5, keySize - 1.5, 9.5).stroke({ color: 0xffffff, alpha: lit ? 0.5 : 0.22, width: 1.5 })
    g.roundRect(5, down + 5, width - 10, keySize * 0.42, 6).fill({ color: 0xffffff, alpha: lit ? 0.22 : 0.07 })
  }

  /** Draws the prompt for the device in use; `press` (0 to 1) is how far down the key that goes is. */
  const drawPrompt = (onPad: boolean, press: number): void => {
    const key = `${onPad}`
    if (key !== promptKey) {
      promptKey = key
      for (const one of keys) {
        one.cap.visible = !onPad
        one.arrow.visible = !onPad
      }
      trigger.visible = onPad
      triggerText.visible = onPad
      promptText.text = onPad ? "PULL RT TO GO" : "PRESS ↑ TO GO"
    }
    const down = Math.round(press * (keyDepth - 2) * 2) / 2
    if (onPad) {
      drawKey(trigger, triggerW, down, true)
      triggerText.position.set(0, keysTop + 26 + down + keySize / 2)
      return
    }
    for (const one of keys) {
      const lit = one.name === "up"
      drawKey(one.cap, keySize, lit ? down : 0, lit)
      one.arrow.style.fill = lit ? palette.hudBack : palette.hudText
      one.arrow.position.y = one.y + (lit ? down : 0) + keySize / 2
    }
  }

  /** How far down the key is at `seconds` into its cycle: a quick press, held a moment, let go, a wait. */
  const pressAt = (seconds: number): number => {
    const t = seconds % 1.5
    if (t < 0.12) return t / 0.12
    if (t < 0.42) return 1
    if (t < 0.56) return 1 - (t - 0.42) / 0.14
    return 0
  }

  // ── state the panels read ─────────────────────────────────────────────
  /** The ghost's splits (or the best lap's, with no ghost) at the start of this attempt: the gaps are against these, even after this lap beats it. */
  let reference: ReadonlyArray<number> | null = null
  let attempt = -1
  /** Seconds since the page began, for timed messages. */
  let now = 0
  let offRoadUntil = -1
  let toastText = ""
  let toastUntil = -1
  /** The last finish, kept until the next attempt, for the stub that never reports `finished`. */
  let finishShownUntil = -1

  const captureReference = (): void => {
    reference = source.ghost()?.splitsMs ?? source.best()?.splitsMs ?? null
  }

  // The maker's plate is the timing panel's header, like the series' mark on a timing screen.
  const plate = createBrandPlate(document)

  const layout = (): void => {
    const { width, height } = stage.app.screen
    const scale = Math.max(0.72, Math.min(1, width / 1500, height / 840))
    for (const panel of [tower, speedPanel, message, result, prompt, replayTag]) panel.scale.set(scale)
    tower.position.set(margin, margin)
    plate.place(margin + rim * scale, margin + rim * scale, inner, headH - rim, scale)
    speedPanel.position.set(width - margin - speedW * scale, height - margin - speedH * scale)
    prompt.position.set(width / 2, height / 2)
    replayTag.position.set(width / 2, margin)
    message.position.set(width / 2, height - margin - messageH * scale)
    result.position.set(width / 2, height - margin - (resultH + (resultBoardKey === "" || resultBoardKey === "unset" ? 0 : resultBoardH)) * scale)
  }
  layout()
  stage.app.renderer.on("resize", layout)

  /** The gap at line `i` against the reference, or null when either is missing. */
  const gapAt = (i: number, split: number | null): number | null => {
    const best = reference?.[i]
    return split !== null && best !== undefined ? split - best : null
  }

  const drawTab = (i: number, split: number | null, current: boolean): void => {
    const tab = tabs[i]
    if (tab === undefined) return
    const gap = gapAt(i, split)
    const state = split === null ? (current ? "current" : "empty") : gap === null ? "plain" : gap <= 0 ? "ahead" : "behind"
    if (state === tab.key) return
    tab.key = state
    tab.cell.clear()
    // The sector being driven is lit, like the leader's line on a timing screen.
    tab.cell.rect(1, 0, tabW - 2, tabsH).fill(state === "current" ? { color: palette.hudText, alpha: 0.94 } : { color: palette.hudText, alpha: 0.09 })
    if (state === "ahead" || state === "behind" || state === "plain") {
      tab.cell.rect(1, tabsH - 3, tabW - 2, 3).fill({ color: state === "ahead" ? palette.hudGood : state === "behind" ? palette.hudBad : palette.hudText, alpha: state === "plain" ? 0.5 : 1 })
    }
    tab.name.style.fill = state === "current" ? palette.hudBack : state === "empty" ? palette.hudDim : palette.hudText
  }

  /** The gap at the last line crossed, on a band of its colour; with nothing to compare against, the time at that line. */
  const drawDelta = (splits: ReadonlyArray<number>): void => {
    const last = splits.length - 1
    const split = splits[last] ?? null
    const gap = gapAt(last, split)
    const key = `${last}:${split ?? ""}:${gap ?? ""}`
    if (key === deltaKey) return
    deltaKey = key
    deltaBand.paint(gap === null ? null : gap <= 0 ? palette.hudGoodDeep : palette.hudBadDeep)
    deltaName.text = gap === null && split !== null ? `S${last + 1}` : "DELTA"
    deltaName.style.fill = gap === null ? palette.hudDim : palette.hudText
    deltaValue.text = split === null ? "–" : gap === null ? formatTime(split).replace(/^0:/, "") : formatGap(gap)
    deltaValue.style.fill = split === null ? palette.hudDim : palette.hudText
  }

  const drawMedals = (): void => {
    const best = source.best()?.timeMs ?? null
    for (const medal of medals) {
      const earned = best !== null && best <= track.medals[medal.name]
      if (earned === medal.earned) continue
      medal.earned = earned
      medal.dot.clear()
      if (earned) medal.dot.circle(0, 0, 5).fill(medalColour[medal.name])
      else medal.dot.circle(0, 0, 4.5).stroke({ color: medalColour[medal.name], alpha: 0.8, width: 1.4 })
    }
    // The next medal to earn, or the last one once all are earned.
    const next = medalNames.find((name) => best === null || best > track.medals[name]) ?? null
    const key = next ?? "all"
    if (key === targetRow.key) return
    targetRow.key = key
    targetDot.clear()
    targetDot.circle(0, 0, 5).fill(medalColour[next ?? "gold"])
    targetRow.name.text = next === null ? "ALL MEDALS" : next.toUpperCase()
    targetRow.value.text = next === null ? "" : formatTime(track.medals[next])
  }

  const setMessage = (value: string): void => {
    message.visible = value !== ""
    if (value === messageKey) return
    messageKey = value
    messageText.text = value.toUpperCase()
    const w = Math.ceil(messageText.width) + 40
    drawPanel(messageBg, w, messageH)
    messageBg.position.set(-w / 2, 0)
  }

  /** The board's answer under the result, when there is one for this lap. */
  const drawResultBoard = (attempt: number): void => {
    const post = source.post()
    const line = post !== null && post.attempt === attempt ? postLine(post.state, source.name()) : null
    const key = line === null ? "" : `${line.tone}:${line.text}`
    if (key === resultBoardKey) return
    resultBoardKey = key
    const h = resultH + (line === null ? 0 : resultBoardH)
    drawPanel(resultBg, resultW, h)
    if (line !== null) resultBg.rect(rim, resultH, resultW - rim * 2, resultBoardH - rim).fill({ color: palette.hudHead, alpha: 0.42 })
    resultBoard.text = line?.text ?? ""
    resultBoard.style.fill = line === null ? palette.hudDim : line.tone === "accent" ? palette.hudAccent : line.tone === "bad" ? palette.hudBad : palette.hudDim
    resultBoard.position.y = resultH + (resultBoardH - rim) / 2
    layout()
  }

  const showResult = (view: RaceView): void => {
    const finish = source.lastFinish()
    if (finish === null) return
    resultAttempt = view.lap.attempt
    // The lap's time first: the timing panel is away while the lap is shown again.
    const time = formatTime(finish.timeMs)
    if (finish.previous === null) {
      resultGap.text = `${time}  FIRST LAP`
      resultBand.paint(palette.hudGoodDeep)
    } else {
      const gap = finish.timeMs - finish.previous.timeMs
      resultGap.text = finish.improved ? `${time}  ${formatGap(gap)} NEW BEST` : `${time}  ${formatGap(gap)} TO BEST`
      resultBand.paint(finish.improved ? palette.hudGoodDeep : palette.hudBadDeep)
    }
    resultWon = [...medalNames].reverse().find((name) => finish.timeMs <= track.medals[name]) ?? null
    resultMedalKey = ""
  }

  /** The medal the lap earned and how to go again, named for the device in use: `R` on the keyboard, `Y` on a gamepad. */
  const drawResultMedal = (onPad: boolean): void => {
    const key = `${resultWon ?? "none"}:${onPad}`
    if (key === resultMedalKey) return
    resultMedalKey = key
    const again = `${onPad ? "Y" : "R"} TO GO AGAIN`
    resultMedalDot.clear()
    if (resultWon === null) {
      resultMedal.text = `NO MEDAL  ·  ${again}`
      resultMedal.style.fill = palette.hudDim
      resultMedal.position.x = 0
    } else {
      resultMedal.text = `${resultWon.toUpperCase()}  ·  ${again}`
      resultMedal.style.fill = palette.hudText
      resultMedal.position.x = 8
      resultMedalDot.circle(0, 0, 5).fill(medalColour[resultWon])
      resultMedalDot.position.set(-resultMedal.width / 2, resultGapH + 18)
    }
  }

  captureReference()

  return {
    handle(event, view) {
      switch (event.kind) {
        case "start":
          captureReference()
          break
        case "reset":
          if (event.reason === "off-track") offRoadUntil = now + 1.4
          plate.cancel()
          break
        case "drift":
          driftPaidUntil = now + 0.45
          break
        case "finish":
          showResult(view)
          finishShownUntil = now + 5
          plate.wipe(covered)
          break
        default:
          break
      }
    },
    toast(value) {
      toastText = value
      toastUntil = now + 1.4
    },
    update(view, state, seconds) {
      now += seconds
      const lap = view.lap
      if (lap.attempt !== attempt) {
        attempt = lap.attempt
        captureReference()
      }

      // The clock holds the final time once finished.
      clockText.text = formatTime(lap.phase === "ready" ? 0 : lap.timeMs)

      const best = source.best()
      const rank = source.rank()
      const bestKey = `${best === null ? "none" : String(best.timeMs)}:${rank === null ? "" : rank.rank}`
      if (bestKey !== bestRow.key) {
        bestRow.key = bestKey
        bestRow.value.text = best === null ? "–" : formatTime(best.timeMs)
        bestRow.value.style.fill = best === null ? palette.hudDim : palette.hudText
        rankText.text = best !== null && rank !== null ? `#${rank.rank}` : ""
      }
      const lapGhost = source.ghost()
      const loading = source.ghostLoading()
      const ghostKey = `${lapGhost?.kind ?? "none"}:${lapGhost?.name ?? ""}:${lapGhost?.timeMs ?? ""}:${loading}`
      if (ghostKey !== ghostRow.key) {
        ghostRow.key = ghostKey
        ghostDot.clear()
        if (lapGhost !== null) ghostDot.circle(0, 0, 5).fill(palette.ghost)
        else ghostDot.circle(0, 0, 4.5).stroke({ color: palette.ghost, alpha: 0.8, width: 1.4 })
        const name = lapGhost === null ? "NO GHOST" : lapGhost.kind === "own" ? "YOUR BEST" : lapGhost.name.toUpperCase()
        ghostRow.name.text = name
        // A ghost by sector shows its ideal lap: each driver's own sector, added up.
        ghostRow.name.style.fill = lapGhost !== null && lapGhost.kind !== "own" ? palette.hudText : palette.hudDim
        ghostRow.value.text = loading ? "…" : lapGhost !== null && lapGhost.kind !== "own" ? formatTime(lapGhost.timeMs) : ""
        ghostRow.value.style.fill = palette.hudText
      }
      // A finished lap whose splits leave out the last line still fills the last sector.
      const splits = lap.phase === "ready" ? [] : lap.phase === "finished" && lap.splitsMs.length < sectorCount ? [...lap.splitsMs, lap.timeMs] : lap.splitsMs
      for (let i = 0; i < sectorCount; i++) drawTab(i, splits[i] ?? null, lap.phase === "running" && i === lap.splitsMs.length)
      drawDelta(splits)
      drawMedals()

      // How to start, once the car has waited on the line long enough to show the player is lost.
      // Not over a run being watched: the player is looking, not lost.
      waited = lap.phase === "ready" && state.replay?.kind !== "run" ? waited + seconds : 0
      const prompting = waited >= promptAfter
      prompt.alpha += ((prompting ? 1 : 0) - prompt.alpha) * Math.min(1, seconds * (prompting ? 6 : 14))
      prompt.visible = prompt.alpha > 0.02
      if (prompt.visible) drawPrompt(state.pad === "gamepad", pressAt(Math.max(0, waited - promptAfter)))

      // The speed, and a bar that fills to the boosted top speed.
      const kmh = Math.round(Math.abs(state.car.speed) * 3.6)
      const nextSpeed = `${kmh}:${state.car.boosting}`
      if (nextSpeed !== speedKey) {
        speedKey = nextSpeed
        speedText.text = String(kmh)
        const barW = speedW - pad * 2
        speedBar.clear()
        speedBar.roundRect(0, 0, barW, 5, 2.5).fill({ color: palette.hudText, alpha: 0.16 })
        const filled = barW * Math.min(1, kmh / 130)
        if (filled > 1) speedBar.roundRect(0, 0, filled, 5, 2.5).fill({ color: state.car.boosting ? palette.boost : palette.hudAccent })
      }

      // The drift: the pedals that make it, and the push a slide has earned so far.
      const charge = state.car.drift
      const paid = now < driftPaidUntil
      const onPad = state.pad === "gamepad"
      const nextDrift = `${charge === null ? "off" : Math.round(charge * 50)}:${paid}:${onPad}`
      if (nextDrift !== driftKey) {
        driftKey = nextDrift
        const sliding = charge !== null
        driftName.style.fill = sliding || paid ? palette.hudText : palette.hudDim
        driftKeys.text = onPad ? "RT+LT" : "Z"
        driftKeys.style.fill = sliding ? palette.hudText : palette.hudDim
        const barW = speedW - pad * 2
        driftBar.clear()
        driftBar.roundRect(0, 0, barW, 5, 2.5).fill({ color: palette.hudText, alpha: 0.16 })
        if (paid) driftBar.roundRect(0, 0, barW, 5, 2.5).fill({ color: palette.hudText })
        else if (sliding) driftBar.roundRect(0, 0, Math.max(5, barW * (charge ?? 0)), 5, 2.5).fill({ color: (charge ?? 0) >= 1 ? palette.driftFull : palette.driftCharge })
      }

      // While a lap is shown again the timing panel is away, its plate with it.
      const replaying = state.replay !== null
      tower.visible = !replaying
      plate.show(!replaying)

      // The replay's mark, its dot blinking like a recorder's.
      replayTag.visible = replaying
      if (state.replay !== null) {
        drawReplayTag(state.replay.kind === "run" ? state.replay.run : null, state.pad === "gamepad")
        replayDot.alpha = now % 1.2 < 0.75 ? 1 : 0.25
      }

      // The result stays while the lap is finished, or a few seconds when the clock runs on;
      // not over someone else's lap being watched.
      const showingResult = state.replay?.kind !== "run" && resultAttempt === lap.attempt && (lap.phase === "finished" || now < finishShownUntil)
      result.visible = showingResult
      if (showingResult) {
        drawResultMedal(state.pad === "gamepad")
        drawResultBoard(lap.attempt)
      }
      if (showingResult) setMessage("")
      else if (now < toastUntil) setMessage(toastText)
      else if (now < offRoadUntil) setMessage("off the road")
      else setMessage("")
    }
  }
}
