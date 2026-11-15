/**
 * The leaderboard's panels, as DOM over the top right corner of the board (the HUD's own
 * panels are Pixi, `hud.ts`; a form and a list of rows to click are better as DOM). They are
 * drawn to match the HUD: small dark panels, white text, the yellow accent.
 *
 * - the board: the Typeonce plate as its first row (a link to typeonce.games), then the top
 *   runs, the player's own with its neighbours, the total, which ghost to race (next closest,
 *   their best, none, or any row clicked), the player's name with "change", and the tracks
 *   when there is more than one.
 * - closed: one small panel, `L BOARD #12/340`, that fades while a lap runs.
 * - the name: a field with an answer as the player types, `RANDOM` for a made-up one
 *   (`handles.ts`), save, and cancel. Nobody has to open it: a new player is given a made-up
 *   name with their first lap, and comes here from the board to change it.
 *
 * The board is up by default, so a player sees it without knowing a key: on arriving, on the
 * line, and beside the replay of a finished lap. It gets out of the way by itself only while
 * a lap runs, and from the finish until the brand's wipe has covered the window. The player
 * closes it for good with its cross, `L` or `Esc`, and opens it again with `L` or the small
 * panel; that choice is kept (`PanelsOptions.keep`).
 *
 * A lap that moves the player up the board is shown moving: the board that was there before
 * the lap is held until the wipe has left, then every row slides to its new place, the
 * player's own lit and marked with the places it gained.
 *
 * `L` and `Esc` do nothing while a text field has focus, and ritmo's keyboard already
 * ignores keys typed into one, so typing a name never drives the car.
 */
import type { Entry } from "../api/contract.ts"
import type { Board } from "../api/contract.ts"
import { nameMaxLength } from "../api/names.ts"
import { createPlateLink, wipeLeavesMs } from "./brand/plate.ts"
import type { GhostChoice } from "./boards.ts"
import { makeHandle } from "./handles.ts"
import { formatTime, panelAlpha } from "./hud.ts"
import { answerStatus, checking, type NameStatus, saving, shapeStatus } from "./name-messages.ts"
import { fieldSizes, type Online } from "./online.ts"
import { palette } from "./palette.ts"
import { fieldTintCss } from "./tints.ts"
import "./panels.css"

export interface Panels {
  /** A text field of the panels has focus. */
  typing(): boolean
  /** Once per drawn frame: whether a lap runs (the closed board fades). */
  update(running: boolean): void
  /** A lap started: the panels get out of the way. */
  lapStarted(): void
  /** A lap finished: the board stays out of the way, and as it stood, until the wipe has been and gone. */
  lapFinished(): void
  /** A finished lap is on screen again: the board comes back beside it. */
  lapShown(): void
  /** The attempt started again: the car is on the line, and the board is back. */
  lapReset(): void
}

export interface PanelsOptions {
  readonly online: Online
  readonly tracks: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly track: string
  /** The player picked another track. */
  readonly switchTrack: (id: string) => void
  /** Whether the player keeps the board up (they have not closed it). */
  readonly shown: boolean
  /** The player closed the board, or opened it again: keep that for the next visit. */
  readonly keep: (shown: boolean) => void
  /** The player picked how many ghosts to race: kept. */
  readonly keepField: (count: number) => void
}

const hex = (colour: number): string => `#${colour.toString(16).padStart(6, "0")}`
const rgba = (colour: number, alpha: number): string => `rgba(${(colour >> 16) & 255}, ${(colour >> 8) & 255}, ${colour & 255}, ${alpha})`

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== "") node.className = className
  if (text !== "") node.textContent = text
  return node
}

/** A button that does not take the keyboard's focus, so space and the arrows stay with the car. */
const button = (className: string, text: string, onClick: () => void): HTMLButtonElement => {
  const node = el("button", className, text)
  node.type = "button"
  node.tabIndex = -1
  node.addEventListener("pointerdown", (event) => event.preventDefault())
  node.addEventListener("click", (event) => {
    event.stopPropagation()
    onClick()
  })
  return node
}

const sameChoice = (a: GhostChoice, b: GhostChoice): boolean => a.kind === b.kind && (a.kind !== "run" || (b.kind === "run" && a.runId === b.runId))

export const createPanels = (options: PanelsOptions): Panels => {
  const { online } = options
  const root = el("div", "tgp-panels")
  root.style.setProperty("--hud-back", hex(palette.hudBack))
  root.style.setProperty("--hud-back-a", rgba(palette.hudBack, panelAlpha))
  root.style.setProperty("--hud-head-a", rgba(palette.hudHead, 0.55))
  root.style.setProperty("--hud-text", hex(palette.hudText))
  root.style.setProperty("--hud-dim", hex(palette.hudDim))
  root.style.setProperty("--hud-accent", hex(palette.hudAccent))
  root.style.setProperty("--hud-good", hex(palette.hudGood))
  root.style.setProperty("--hud-bad", hex(palette.hudBad))
  root.style.setProperty("--ghost", hex(palette.ghost))
  document.body.appendChild(root)

  /** The player keeps the board up. */
  let wanted = options.shown
  /** The board is out of the way for now: a lap runs, or one just ended and the wipe has not covered the window. */
  let away = false
  /** The name panel is open in the board's place. */
  let naming = false
  let running = false
  /** The board as it stood before the lap, and when (`performance.now`) to let the new one in; -1 when nothing is held. */
  let held: Board | null = null
  let heldUntil = -1
  /** The player's place in the rows as last drawn, for the places a lap gained. */
  let drawnRank: number | null = null

  const boardUp = (): boolean => online.state().enabled && wanted && !away && !naming

  /** The player opens or closes the board, and the choice is kept. */
  const want = (next: boolean): void => {
    wanted = next
    // Asking for it while a lap runs shows it there and then.
    if (next) away = false
    options.keep(next)
    apply()
  }

  // ── closed ─────────────────────────────────────────────────────────────
  const opener = button("tgp-opener", "", () => want(true))
  const openerRank = el("span", "tgp-mono")
  opener.append(el("span", "tgp-cap", "L"), el("span", "", "BOARD"), openerRank)
  root.appendChild(opener)

  // ── the board ──────────────────────────────────────────────────────────
  const boardPanel = el("div", "tgp-panel")
  const boardHead = el("div", "tgp-head")
  const boardTitle = el("span", "tgp-title", "LEADERBOARD")
  const boardCount = el("span", "tgp-count")
  boardHead.classList.add("tgp-head-plain")
  boardHead.append(boardTitle, boardCount, button("tgp-x", "×", () => want(false)))
  const trackLine = el("div", "tgp-line")
  const cols = el("div", "tgp-cols")
  cols.append(el("span", "", "POS"), el("span", "", "DRIVER"), el("span", "", "BEST"), el("span", "", "GAP"), el("span"))
  const rows = el("div", "tgp-rows")
  const ghostLine = el("div", "tgp-line")
  ghostLine.appendChild(el("span", "tgp-label", "GHOST"))
  const ghostChips = ([
    ["NEXT CLOSEST", { kind: "next" }],
    ["MY BEST", { kind: "own" }],
    ["OFF", { kind: "none" }]
  ] as const).map(([text, choice]) => {
    const chip = button("tgp-chip", text, () => online.choose(choice))
    ghostLine.appendChild(chip)
    return { chip, choice: choice as GhostChoice }
  })
  // How many ghosts: the raced one, and the board's runs just ahead beside it.
  const fieldLine = el("div", "tgp-line")
  fieldLine.appendChild(el("span", "tgp-label", "GHOSTS"))
  const fieldChips = fieldSizes.map((count) => {
    const chip = button("tgp-chip", String(count), () => {
      online.setField(count)
      options.keepField(count)
    })
    fieldLine.appendChild(chip)
    return { chip, count }
  })
  const meLine = el("div", "tgp-line")
  const meLabel = el("span", "tgp-label")
  const meName = el("span", "tgp-fill")
  const meAction = button("tgp-link", "", () => openName())
  meLine.append(meLabel, meName, meAction)
  const statusLine = el("div", "tgp-line tgp-bad")
  // The maker's plate first, as on the timing panel: it is the one on screen while a lap is shown again.
  boardPanel.append(createPlateLink(document, 24), boardHead, trackLine, cols, rows, ghostLine, fieldLine, meLine, statusLine)
  root.appendChild(boardPanel)

  if (options.tracks.length > 1) {
    trackLine.appendChild(el("span", "tgp-label", "TRACK"))
    for (const one of options.tracks) {
      const chip = button("tgp-chip", one.name.toUpperCase(), () => {
        if (one.id !== options.track) options.switchTrack(one.id)
      })
      chip.setAttribute("aria-pressed", String(one.id === options.track))
      trackLine.appendChild(chip)
    }
  } else {
    trackLine.hidden = true
  }

  /** One run as a bar: its place, its driver, its time, and how far it is behind the fastest (`leaderMs`). */
  const drawRow = (entry: Entry, raced: string | null, ownRaced: boolean, leaderMs: number, fieldRuns: ReadonlyArray<string>): HTMLElement => {
    const row = el("div", "tgp-row")
    const dot = el("span", "tgp-dot")
    // A run raced beside the ghost wears its ghost's tint.
    const inField = fieldRuns.indexOf(entry.runId)
    if (inField >= 0) dot.style.background = fieldTintCss(inField)
    if (entry.mine) row.classList.add("tgp-mine")
    if (entry.runId === raced || (entry.mine && ownRaced)) row.classList.add("tgp-raced")
    row.append(el("span", "tgp-rank tgp-mono", String(entry.rank)), el("span", "tgp-name", entry.name.toUpperCase()), el("span", "tgp-time tgp-mono", formatTime(entry.timeMs)), el("span", "tgp-behind tgp-mono", entry.timeMs > leaderMs ? `+${((entry.timeMs - leaderMs) / 1000).toFixed(3)}` : ""), dot)
    row.dataset["key"] = entry.mine ? "me" : `player:${entry.name}`
    row.title = entry.mine ? "Race your best" : `Race ${entry.name}`
    row.addEventListener("click", () => online.choose(entry.mine ? { kind: "own" } : { kind: "run", runId: entry.runId }))
    return row
  }

  /** The rows on screen now, by player, and how far down the window each is. */
  const rowTops = (): Map<string, number> => {
    const tops = new Map<string, number>()
    for (const row of rows.children) {
      const key = row instanceof HTMLElement ? row.dataset["key"] : undefined
      if (key !== undefined) tops.set(key, row.getBoundingClientRect().top)
    }
    return tops
  }

  /**
   * After the rows were drawn again: each one slides from where it was to where it is. The
   * player's own, when it went up (or is new on the board), slides slower, lit, with the
   * places it gained beside it.
   */
  const slideRows = (before: Map<string, number>, rankBefore: number | null, rankNow: number | null): void => {
    if (before.size === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    // The panels are scaled as a whole; a row's own shift is measured before that.
    const scale = root.getBoundingClientRect().width / root.offsetWidth || 1
    const below = rows.getBoundingClientRect().bottom
    for (const row of rows.children) {
      if (!(row instanceof HTMLElement)) continue
      const key = row.dataset["key"]
      if (key === undefined) continue
      const mine = key === "me"
      const was = before.get(key) ?? (mine ? below : undefined)
      if (was === undefined) continue
      const shift = (was - row.getBoundingClientRect().top) / scale
      if (Math.abs(shift) < 1) continue
      const climbed = mine && shift > 0
      row.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], { duration: climbed ? 1300 : 800, easing: "cubic-bezier(0.25, 0.8, 0.25, 1)" })
      if (!climbed) continue
      row.classList.add("tgp-climbed")
      const gained = rankBefore !== null && rankNow !== null ? rankBefore - rankNow : 0
      const mark = el("span", "tgp-gained", gained > 0 ? `▲ ${gained}` : "NEW")
      row.appendChild(mark)
      setTimeout(() => {
        row.classList.remove("tgp-climbed")
        mark.remove()
      }, 3200)
    }
  }

  const drawBoard = (slide: boolean = false): void => {
    const state = online.state()
    // While a board is held the rows stay as they stood before the lap.
    const board = held ?? state.board
    const before = slide ? rowTops() : new Map<string, number>()
    const rankBefore = drawnRank
    boardCount.textContent = state.boardLoading && board === null ? "…" : board === null ? "" : `${board.total} ${board.total === 1 ? "DRIVER" : "DRIVERS"}`
    rows.replaceChildren()
    cols.hidden = board === null || board.top.length === 0
    const raced = state.choice.kind === "run" ? state.choice.runId : null
    const ownRaced = state.choice.kind === "own"
    if (board === null) {
      rows.appendChild(el("div", "tgp-empty", state.boardLoading ? "LOADING…" : state.reachable === false ? "CAN'T REACH THE BOARD" : "NO BOARD YET"))
    } else if (board.top.length === 0) {
      rows.appendChild(el("div", "tgp-empty", "NO LAPS YET: SET THE FIRST"))
    } else {
      const leaderMs = board.top[0]?.timeMs ?? 0
      for (const entry of board.top) rows.appendChild(drawRow(entry, raced, ownRaced, leaderMs, state.fieldRuns))
      const around = board.around.filter((entry) => !board.top.some((top) => top.runId === entry.runId))
      if (around.length > 0) {
        const last = board.top[board.top.length - 1]
        const first = around[0]
        if (last !== undefined && first !== undefined && first.rank > last.rank + 1) rows.appendChild(el("div", "tgp-gap", "···"))
        for (const entry of around) rows.appendChild(drawRow(entry, raced, ownRaced, leaderMs, state.fieldRuns))
      }
    }
    for (const { chip, choice } of ghostChips) chip.setAttribute("aria-pressed", String(sameChoice(choice, state.choice)))
    for (const { chip, count } of fieldChips) {
      chip.setAttribute("aria-pressed", String(count === state.field))
      chip.disabled = state.choice.kind === "none"
    }
    if (state.identity === null) {
      meLabel.textContent = "NOT ON THE BOARD"
      meName.textContent = ""
      meAction.textContent = "PICK A NAME"
    } else {
      meLabel.textContent = "YOU"
      meName.textContent = state.identity.name.toUpperCase()
      meAction.textContent = "CHANGE"
    }
    // With a board seen earlier this visit, say it may be out of date.
    statusLine.hidden = state.reachable !== false || board === null
    statusLine.textContent = "OFFLINE · THE LAST BOARD SEEN"
    drawnRank = board?.me?.rank ?? null
    if (slide) slideRows(before, rankBefore, drawnRank)
  }

  const drawOpener = (): void => {
    const rank = online.state().rank
    openerRank.textContent = rank === null ? "" : `#${rank.rank}/${rank.total}`
  }

  // ── the name ───────────────────────────────────────────────────────────
  const namePanel = el("div", "tgp-panel")
  const nameHead = el("div", "tgp-head")
  const nameTitle = el("span", "tgp-title")
  nameHead.append(nameTitle, button("tgp-x", "×", () => closeName(false)))
  const form = el("form", "tgp-form")
  const nameHint = el("div", "tgp-hint", "SHOWN ON THE LEADERBOARD WITH YOUR BEST LAP")
  const input = el("input", "tgp-input")
  input.type = "text"
  input.maxLength = nameMaxLength + 8
  input.autocomplete = "off"
  input.spellcheck = false
  input.setAttribute("aria-label", "Name")
  const status = el("div", "tgp-status")
  const actions = el("div", "tgp-actions")
  const skip = button("tgp-button", "CANCEL", () => closeName(false))
  const save = el("button", "tgp-button tgp-primary", "SAVE")
  save.type = "submit"
  save.tabIndex = -1
  // Another made-up name, to keep or to start from.
  const random = button("tgp-button tgp-random", "RANDOM", () => {
    input.value = makeHandle()
    typed()
    input.focus()
  })
  actions.append(random, skip, save)
  form.append(nameHint, input, status, actions)
  namePanel.append(nameHead, form)
  root.appendChild(namePanel)

  /** Drops answers to what the player has typed since. */
  let nameRequest = 0
  let checkTimer: ReturnType<typeof setTimeout> | null = null
  let busy = false

  const setStatus = (value: NameStatus): void => {
    status.textContent = value.text
    status.className = `tgp-status ${value.tone === "good" ? "tgp-good" : value.tone === "bad" ? "tgp-bad" : ""}`
    save.disabled = !value.canSave || busy
  }

  const typed = (): void => {
    const request = ++nameRequest
    if (checkTimer !== null) clearTimeout(checkTimer)
    const local = shapeStatus(input.value, online.state().identity?.name ?? null)
    if (local !== null) return setStatus(local)
    setStatus(checking)
    // Ask the board once the player pauses, not on every key.
    checkTimer = setTimeout(() => {
      void online.checkName(input.value).then((answer) => {
        if (request === nameRequest && !busy) setStatus(answerStatus(answer))
      })
    }, 450)
  }
  input.addEventListener("input", typed)
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    closeName(false)
  })
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    if (busy || save.disabled) return
    busy = true
    const request = ++nameRequest
    setStatus(saving)
    void online.saveName(input.value).then((answer) => {
      busy = false
      if (request !== nameRequest) return
      if (answer.kind === "ok") closeName(true)
      else setStatus(answerStatus(answer))
    })
  })

  const openName = (): void => {
    const identity = online.state().identity
    nameTitle.textContent = identity === null ? "PICK A NAME" : "CHANGE NAME"
    input.value = identity?.name ?? ""
    busy = false
    naming = true
    apply()
    typed()
    input.focus()
    input.select()
  }

  const closeName = (saved: boolean): void => {
    nameRequest++
    if (checkTimer !== null) clearTimeout(checkTimer)
    // Closing without a name is choosing to stay unlisted.
    if (!saved && online.state().identity === null) online.skipName()
    input.blur()
    naming = false
    apply()
  }

  // ── what is up ─────────────────────────────────────────────────────────
  /** Shows what the state says: the board, the name panel in its place, or the small panel. */
  const apply = (): void => {
    const board = boardUp()
    const opening = board && boardPanel.hidden
    boardPanel.hidden = !board
    namePanel.hidden = !naming
    opener.hidden = board || naming || !online.state().enabled
    if (opening) {
      drawBoard()
      online.refreshBoard()
    }
  }

  const layout = (): void => {
    const scale = Math.max(0.72, Math.min(1, window.innerWidth / 1500, window.innerHeight / 840))
    root.style.transform = `scale(${scale})`
  }
  layout()
  window.addEventListener("resize", layout)

  const editable = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))

  window.addEventListener("keydown", (event) => {
    if (!online.state().enabled || editable(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return
    if (event.key === "l" || event.key === "L") {
      if (naming) closeName(false)
      else want(!boardUp())
    } else if (event.key === "Escape") {
      if (naming) closeName(false)
      else if (boardUp()) want(false)
    }
  })

  /** The name offers already made, so a new one opens the panel once. */
  let prompts = online.state().namePrompts
  let promptAt = -1
  online.subscribe(() => {
    const state = online.state()
    if (state.namePrompts !== prompts) {
      prompts = state.namePrompts
      // A moment after the finish, so the player sees their time first.
      promptAt = performance.now() + 1200
    }
    // A board that came in while one is held waits its turn (`update`).
    if (boardUp()) drawBoard(held === null)
    drawOpener()
  })

  apply()
  drawOpener()
  if (!online.state().enabled) root.hidden = true

  return {
    typing: () => document.activeElement === input,
    update(isRunning) {
      running = isRunning
      opener.classList.toggle("tgp-faded", running)
      if (held !== null && performance.now() >= heldUntil) {
        // The wipe has left: the lap's new standings come in, moving.
        held = null
        if (boardUp()) drawBoard(true)
      }
      if (promptAt >= 0 && !running && performance.now() >= promptAt && !naming) {
        promptAt = -1
        if (online.state().identity === null) openName()
      }
    },
    lapStarted() {
      promptAt = -1
      if (naming) closeName(false)
      away = true
      apply()
    },
    lapFinished() {
      held = online.state().board
      heldUntil = held === null ? -1 : performance.now() + wipeLeavesMs + 350
    },
    lapShown() {
      away = false
      apply()
    },
    lapReset() {
      away = false
      held = null
      apply()
      if (boardUp()) drawBoard()
    }
  }
}
