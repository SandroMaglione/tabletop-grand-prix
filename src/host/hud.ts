/**
 * The HUD: a few small dark panels drawn with Pixi 2D over the corners of the 3D view. The
 * map is the picture; the HUD stays out of its way.
 *
 * - top left: the timing panel. The track's name and the medals earned, the lap clock, the
 *   best lap, one row per sector (the one being driven is lit; a finished one shows its gap
 *   to the best lap's split), and the next medal's time.
 * - bottom right: the speed, with a bar.
 * - bottom left: the controls as key caps, only while the car is not racing.
 * - bottom centre: short messages ("press up to start", "off the road", a changed setting)
 *   and the result when a lap is done.
 *
 * Laid out in CSS pixels from `app.screen` on every resize, and scaled down a little on
 * small windows. Text is drawn at the renderer's resolution.
 */
import { Container, Graphics, Text, type TextStyleOptions } from "pixi.js"
import type { RaceEvent, RaceView, TrackData } from "../sim/index.ts"
import type { Stage } from "./contract.ts"
import type { Ghost } from "./ghost.ts"
import { palette } from "./palette.ts"

export interface HudState {
  readonly variant: string
  readonly muted: boolean
  /** Which buttons to name: the gamepad's when it was the last device used. */
  readonly pad: "none" | "keyboard" | "gamepad" | "buttons-only"
}

export interface Hud {
  handle(event: RaceEvent, view: RaceView): void
  /** A short message at the bottom, for a moment (a changed setting). */
  toast(text: string): void
  update(view: RaceView, state: HudState, seconds: number): void
}

/** Numbers: monospaced, so a running clock does not shake. Then the system's own if the web font did not load. */
export const hudFont = ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"]
/** Labels: a condensed sans, always in capitals. */
export const hudLabelFont = ["Barlow Condensed", "Arial Narrow", "Helvetica Neue", "Arial", "sans-serif"]

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

/** A handling variant in the player's words. */
export const steeringName = (variant: string): string =>
  variant === "car" ? "like a car" : variant === "car-loose" ? "like a car, loose grip" : variant === "screen" ? "point where to go" : variant

/** The same in a word or two, for the key caps. */
const steeringShort = (variant: string): string => (variant === "car" ? "car" : variant === "car-loose" ? "car, loose" : variant === "screen" ? "point" : variant)

const margin = 12
const radius = 5

const number = (size: number, fill: number, weight: "400" | "500" = "500"): TextStyleOptions => ({ fontFamily: hudFont, fontSize: size, fontWeight: weight, fill })
const label = (size: number, fill: number): TextStyleOptions => ({ fontFamily: hudLabelFont, fontSize: size, fontWeight: "600", fill, letterSpacing: 1 })

const text = (parent: Container, value: string, options: TextStyleOptions): Text => {
  const t = new Text({ text: value, style: options })
  parent.addChild(t)
  return t
}

/** A dark panel the map shows through a little. */
const drawPanel = (g: Graphics, width: number, height: number): void => {
  g.clear()
  g.roundRect(0, 0, width, height, radius).fill({ color: palette.hudBack, alpha: 0.88 })
  g.roundRect(0.5, 0.5, width - 1, height - 1, radius).stroke({ color: palette.hudText, alpha: 0.1, width: 1 })
}

const medalNames = ["bronze", "silver", "gold"] as const
const medalColour = { bronze: palette.bronze, silver: palette.silver, gold: palette.gold } as const

/** A key cap and what the key does. */
type Hint = readonly [cap: string, does: string]

export const createHud = (stage: Stage, track: TrackData, ghost: Ghost): Hud => {
  const root = new Container()
  stage.app.stage.addChild(root)
  const sectorCount = Math.max(1, track.checkpoints.length)

  // ── top left: the timing panel ─────────────────────────────────────────
  const towerW = 188
  const pad = 10
  const headH = 24
  const clockH = 42
  const rowH = 23
  const towerH = headH + clockH + rowH * (sectorCount + 2)
  const tower = new Container()
  const towerBg = new Graphics()
  tower.addChild(towerBg)
  drawPanel(towerBg, towerW, towerH)
  // The header: a darker band, the accent tick, the track's name, the medals earned.
  towerBg.roundRect(0, 0, towerW, headH + radius, radius).fill({ color: palette.hudHead, alpha: 0.9 })
  towerBg.rect(0, headH, towerW, radius).fill({ color: palette.hudBack })
  towerBg.rect(pad, 7, 3, headH - 14).fill({ color: palette.hudAccent })
  const title = text(tower, track.name.toUpperCase(), label(12, palette.hudText))
  title.anchor.set(0, 0.5)
  title.position.set(pad + 9, headH / 2)
  const medals = medalNames.map((name, i) => {
    const dot = new Graphics()
    dot.position.set(towerW - pad - 5 - (2 - i) * 13, headH / 2)
    tower.addChild(dot)
    return { name, dot, earned: null as boolean | null }
  })
  const clockText = text(tower, "0:00.000", number(27, palette.hudText))
  clockText.anchor.set(0, 0.5)
  clockText.position.set(pad, headH + clockH / 2)

  /** A line of the panel: a label on the left, a value on the right, and a band behind them that can light up. */
  const makeRow = (index: number, name: string) => {
    const y = headH + clockH + index * rowH
    const band = new Graphics()
    band.position.set(0, y)
    tower.addChild(band)
    towerBg.rect(pad, y, towerW - pad * 2, 1).fill({ color: palette.hudText, alpha: 0.09 })
    const nameText = text(tower, name, label(12, palette.hudDim))
    nameText.anchor.set(0, 0.5)
    nameText.position.set(pad, y + rowH / 2)
    const value = text(tower, "", number(13, palette.hudText))
    value.anchor.set(1, 0.5)
    value.position.set(towerW - pad, y + rowH / 2)
    return { band, name: nameText, value, key: "" }
  }
  const bestRow = makeRow(0, "BEST")
  const sectorRows = Array.from({ length: sectorCount }, (_, i) => makeRow(1 + i, `S${i + 1}`))
  const targetRow = makeRow(1 + sectorCount, "")
  const targetDot = new Graphics()
  targetDot.position.set(pad + 5, headH + clockH + (1 + sectorCount) * rowH + rowH / 2)
  tower.addChild(targetDot)
  targetRow.name.position.x = pad + 15
  root.addChild(tower)

  // ── bottom right: speed ───────────────────────────────────────────────
  const speedW = 128
  const speedH = 50
  const speedPanel = new Container()
  const speedBg = new Graphics()
  speedPanel.addChild(speedBg)
  drawPanel(speedBg, speedW, speedH)
  const speedText = text(speedPanel, "0", number(22, palette.hudText))
  speedText.anchor.set(1, 0.5)
  speedText.position.set(speedW - pad - 36, 20)
  const unitText = text(speedPanel, "KM/H", label(11, palette.hudDim))
  unitText.anchor.set(1, 0.5)
  unitText.position.set(speedW - pad, 22)
  const speedBar = new Graphics()
  speedBar.position.set(pad, speedH - 12)
  speedPanel.addChild(speedBar)
  root.addChild(speedPanel)
  let speedKey = ""

  // ── bottom left: the controls as key caps ──────────────────────────────
  const hintsH = 30
  const hintsPanel = new Container()
  const hintsBg = new Graphics()
  hintsPanel.addChild(hintsBg)
  const hintsRow = new Container()
  hintsPanel.addChild(hintsRow)
  root.addChild(hintsPanel)
  let hintsKey = ""

  const drawHints = (hints: ReadonlyArray<Hint>): void => {
    for (const child of hintsRow.removeChildren()) child.destroy()
    let x = pad
    for (const [cap, does] of hints) {
      const capText = new Text({ text: cap, style: number(11, palette.hudText) })
      const capW = Math.max(20, Math.ceil(capText.width) + 10)
      const box = new Graphics()
      box.roundRect(x + 0.5, 6.5, capW - 1, hintsH - 13, 4).fill({ color: palette.hudText, alpha: 0.1 }).stroke({ color: palette.hudText, alpha: 0.35, width: 1 })
      hintsRow.addChild(box)
      capText.anchor.set(0.5, 0.5)
      capText.position.set(x + capW / 2, hintsH / 2)
      hintsRow.addChild(capText)
      x += capW + 5
      const doesText = text(hintsRow, does.toUpperCase(), label(11, palette.hudDim))
      doesText.anchor.set(0, 0.5)
      doesText.position.set(x, hintsH / 2)
      x += Math.ceil(doesText.width) + 12
    }
    drawPanel(hintsBg, x - 12 + pad, hintsH)
  }

  // ── bottom centre: messages ────────────────────────────────────────────
  const messageH = 30
  const message = new Container()
  const messageBg = new Graphics()
  message.addChild(messageBg)
  const messageText = text(message, "", label(13, palette.hudText))
  messageText.anchor.set(0.5, 0.5)
  messageText.position.set(0, messageH / 2)
  root.addChild(message)
  let messageKey = ""

  // ── bottom centre: the result ──────────────────────────────────────────
  const resultW = 250
  const resultH = 62
  const result = new Container()
  const resultBg = new Graphics()
  result.addChild(resultBg)
  drawPanel(resultBg, resultW, resultH)
  resultBg.rect(0, 8, 3, resultH - 16).fill({ color: palette.hudAccent })
  resultBg.position.set(-resultW / 2, 0)
  const resultGap = text(result, "", number(14, palette.hudText))
  resultGap.anchor.set(0.5, 0.5)
  resultGap.position.set(0, 20)
  const resultMedalDot = new Graphics()
  result.addChild(resultMedalDot)
  const resultMedal = text(result, "", label(12, palette.hudText))
  resultMedal.anchor.set(0.5, 0.5)
  resultMedal.position.set(0, 43)
  result.visible = false
  root.addChild(result)
  let resultAttempt = -1

  // ── state the panels read ─────────────────────────────────────────────
  /** The best lap's splits at the start of this attempt: the rows compare against these, even after this lap beats it. */
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
    reference = ghost.best()?.splitsMs ?? null
  }

  const layout = (): void => {
    const { width, height } = stage.app.screen
    const scale = Math.max(0.72, Math.min(1, width / 1500, height / 840))
    for (const panel of [tower, speedPanel, hintsPanel, message, result]) panel.scale.set(scale)
    tower.position.set(margin, margin)
    speedPanel.position.set(width - margin - speedW * scale, height - margin - speedH * scale)
    hintsPanel.position.set(margin, height - margin - hintsH * scale)
    message.position.set(width / 2, height - margin - messageH * scale)
    result.position.set(width / 2, height - margin - resultH * scale)
  }
  layout()
  stage.app.renderer.on("resize", layout)

  const drawSector = (i: number, split: number | null, current: boolean): void => {
    const row = sectorRows[i]
    if (row === undefined) return
    const best = reference?.[i]
    const gap = split !== null && best !== undefined ? split - best : null
    const state = split === null ? (current ? "current" : "empty") : gap === null ? "plain" : gap <= 0 ? "ahead" : "behind"
    const key = `${state}:${split ?? ""}`
    if (key === row.key) return
    row.key = key
    row.band.clear()
    // The sector being driven is lit, like the leader's line on a timing screen.
    if (state === "current") row.band.rect(0, 0, towerW, rowH).fill({ color: palette.hudText, alpha: 0.94 })
    else if (state === "ahead" || state === "behind") row.band.rect(0, 0, 3, rowH).fill({ color: state === "ahead" ? palette.hudGood : palette.hudBad })
    row.name.style.fill = state === "current" ? palette.hudBack : palette.hudDim
    row.value.text = split === null ? (state === "current" ? "" : "–") : gap === null ? formatTime(split).replace(/^0:/, "") : formatGap(gap)
    row.value.style.fill = state === "ahead" ? palette.hudGood : state === "behind" ? palette.hudBad : state === "empty" ? palette.hudDim : palette.hudText
  }

  const drawMedals = (): void => {
    const best = ghost.best()?.timeMs ?? null
    for (const medal of medals) {
      const earned = best !== null && best <= track.medals[medal.name]
      if (earned === medal.earned) continue
      medal.earned = earned
      medal.dot.clear()
      if (earned) medal.dot.circle(0, 0, 4.5).fill(medalColour[medal.name])
      else medal.dot.circle(0, 0, 4).stroke({ color: medalColour[medal.name], alpha: 0.7, width: 1.2 })
    }
    // The next medal to earn, or the last one once all are earned.
    const next = medalNames.find((name) => best === null || best > track.medals[name]) ?? null
    const key = next ?? "all"
    if (key === targetRow.key) return
    targetRow.key = key
    targetDot.clear()
    targetDot.circle(0, 0, 4.5).fill(medalColour[next ?? "gold"])
    targetRow.name.text = next === null ? "ALL MEDALS" : next.toUpperCase()
    targetRow.value.text = next === null ? "" : formatTime(track.medals[next])
  }

  const setMessage = (value: string): void => {
    message.visible = value !== ""
    if (value === messageKey) return
    messageKey = value
    messageText.text = value.toUpperCase()
    const w = Math.ceil(messageText.width) + 30
    drawPanel(messageBg, w, messageH)
    messageBg.rect(0, 8, 3, messageH - 16).fill({ color: palette.hudAccent })
    messageBg.position.set(-w / 2, 0)
  }

  const showResult = (view: RaceView): void => {
    const finish = ghost.lastFinish()
    if (finish === null) return
    resultAttempt = view.lap.attempt
    if (finish.previous === null) {
      resultGap.text = "FIRST LAP"
      resultGap.style.fill = palette.hudGood
    } else {
      const gap = finish.timeMs - finish.previous.timeMs
      resultGap.text = finish.improved ? `${formatGap(gap)} NEW BEST` : `${formatGap(gap)} TO BEST`
      resultGap.style.fill = finish.improved ? palette.hudGood : palette.hudBad
    }
    const won = [...medalNames].reverse().find((name) => finish.timeMs <= track.medals[name])
    resultMedalDot.clear()
    if (won === undefined) {
      resultMedal.text = "NO MEDAL  ·  R TO GO AGAIN"
      resultMedal.style.fill = palette.hudDim
      resultMedal.position.x = 0
    } else {
      resultMedal.text = `${won.toUpperCase()}  ·  R TO GO AGAIN`
      resultMedal.style.fill = palette.hudText
      resultMedal.position.x = 8
      resultMedalDot.circle(0, 0, 5).fill(medalColour[won])
      resultMedalDot.position.set(-resultMedal.width / 2, 43)
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
          break
        case "finish":
          showResult(view)
          finishShownUntil = now + 5
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

      const best = ghost.best()
      const bestKey = best === null ? "none" : String(best.timeMs)
      if (bestKey !== bestRow.key) {
        bestRow.key = bestKey
        bestRow.value.text = best === null ? "–" : formatTime(best.timeMs)
        bestRow.value.style.fill = best === null ? palette.hudDim : palette.hudText
      }
      for (let i = 0; i < sectorCount; i++) {
        let split = lap.splitsMs[i] ?? null
        // A finished lap whose splits leave out the last line still fills the last sector.
        if (split === null && lap.phase === "finished" && i === sectorCount - 1) split = lap.timeMs
        drawSector(i, lap.phase === "ready" ? null : split, lap.phase === "running" && i === lap.splitsMs.length)
      }
      drawMedals()

      // The controls show while the car is not racing; a lap needs the whole map.
      const screen = state.variant.startsWith("screen")
      const steering: Hint = [state.pad === "gamepad" ? "SELECT" : "V", `steering: ${steeringShort(state.variant)}`]
      const hints: ReadonlyArray<Hint> =
        state.pad === "gamepad"
          ? screen
            ? [["L", "point"], ["LT", "brake"], ["Y", "restart"], steering]
            : [["RT", "gas"], ["LT", "brake"], ["L", "steer"], ["Y", "restart"], steering]
          : state.pad === "buttons-only"
            ? [["A", "gas"], ["B", "brake"], ["D-PAD", "steer"], ["Y", "restart"], steering]
            : screen
              ? [["↑ ↓ ← →", "point"], ["SPACE", "brake"], ["R", "restart"], steering]
              : [["↑", "gas"], ["← →", "steer"], ["SPACE", "brake"], ["R", "restart"], steering]
      const withSound: ReadonlyArray<Hint> = state.muted ? [...hints, [state.pad === "gamepad" ? "L3" : "M", "sound off"]] : hints
      const nextHints = withSound.map((hint) => hint.join(":")).join("|")
      if (nextHints !== hintsKey) {
        hintsKey = nextHints
        drawHints(withSound)
      }
      const hintsTarget = lap.phase === "running" ? 0 : 1
      hintsPanel.alpha += (hintsTarget - hintsPanel.alpha) * Math.min(1, seconds * 8)
      hintsPanel.visible = hintsPanel.alpha > 0.02

      // The speed, and a bar that fills to the boosted top speed.
      const kmh = Math.round(Math.abs(view.car.speed) * 3.6)
      const nextSpeed = `${kmh}:${view.car.boosting}`
      if (nextSpeed !== speedKey) {
        speedKey = nextSpeed
        speedText.text = String(kmh)
        const barW = speedW - pad * 2
        speedBar.clear()
        speedBar.roundRect(0, 0, barW, 4, 2).fill({ color: palette.hudText, alpha: 0.14 })
        const filled = barW * Math.min(1, kmh / 130)
        if (filled > 1) speedBar.roundRect(0, 0, filled, 4, 2).fill({ color: view.car.boosting ? palette.boost : palette.hudAccent })
      }

      // The result stays while the lap is finished, or a few seconds when the clock runs on.
      const showingResult = resultAttempt === lap.attempt && (lap.phase === "finished" || now < finishShownUntil)
      result.visible = showingResult
      const onPad = state.pad === "gamepad"
      if (showingResult) setMessage("")
      else if (now < toastUntil) setMessage(toastText)
      else if (now < offRoadUntil) setMessage("off the road")
      else if (lap.phase === "ready") setMessage(screen ? "point where to go to start" : onPad ? "pull RT to start" : "press ↑ to start")
      else setMessage("")
    }
  }
}
