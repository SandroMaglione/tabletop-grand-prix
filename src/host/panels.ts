/**
 * The leaderboard's panels, as DOM over the top right corner of the board (the HUD's own
 * panels are Pixi, `hud.ts`; a form and a list of rows to click are better as DOM). They are
 * drawn to match the HUD: small dark panels, white text, the yellow accent.
 *
 * - closed: one small panel, `L BOARD #12/340`, that fades while a lap runs.
 * - the board: the top runs, the player's own with its neighbours, the total, which ghost
 *   to race (next closest, their best, none, or any row clicked), the player's name with
 *   "change", and the tracks when there is more than one.
 * - the name: a field with an answer as the player types, save, and skip (or cancel).
 *
 * `L` opens and closes the board, `Esc` closes what is open; both do nothing while a text
 * field has focus, and ritmo's keyboard already ignores keys typed into one, so typing a
 * name never drives the car. Everything closes when a lap starts.
 */
import type { Entry } from "../api/contract.ts"
import { nameMaxLength } from "../api/names.ts"
import type { GhostChoice } from "./boards.ts"
import { formatTime } from "./hud.ts"
import { answerStatus, checking, type NameStatus, saving, shapeStatus } from "./name-messages.ts"
import type { Online } from "./online.ts"
import { palette } from "./palette.ts"
import "./panels.css"

export interface Panels {
  /** A text field of the panels has focus. */
  typing(): boolean
  /** Once per drawn frame: whether a lap runs (the closed board fades). */
  update(running: boolean): void
  /** A lap started: close everything. */
  lapStarted(): void
}

export interface PanelsOptions {
  readonly online: Online
  readonly tracks: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly track: string
  /** The player picked another track. */
  readonly switchTrack: (id: string) => void
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
  root.style.setProperty("--hud-back-a", rgba(palette.hudBack, 0.88))
  root.style.setProperty("--hud-head-a", rgba(palette.hudHead, 0.9))
  root.style.setProperty("--hud-text", hex(palette.hudText))
  root.style.setProperty("--hud-dim", hex(palette.hudDim))
  root.style.setProperty("--hud-accent", hex(palette.hudAccent))
  root.style.setProperty("--hud-good", hex(palette.hudGood))
  root.style.setProperty("--hud-bad", hex(palette.hudBad))
  root.style.setProperty("--ghost", hex(palette.ghost))
  document.body.appendChild(root)

  type Open = "none" | "board" | "name"
  let open: Open = "none"
  /** Where the name panel goes back to. */
  let nameFrom: Open = "none"
  let running = false

  // ── closed ─────────────────────────────────────────────────────────────
  const opener = button("tgp-opener", "", () => show("board"))
  const openerRank = el("span", "tgp-mono")
  opener.append(el("span", "tgp-cap", "L"), el("span", "", "BOARD"), openerRank)
  root.appendChild(opener)

  // ── the board ──────────────────────────────────────────────────────────
  const boardPanel = el("div", "tgp-panel")
  const boardHead = el("div", "tgp-head")
  const boardTitle = el("span", "tgp-title", "LEADERBOARD")
  const boardCount = el("span", "tgp-count")
  boardHead.append(boardTitle, boardCount, button("tgp-x", "×", () => show("none")))
  const trackLine = el("div", "tgp-line")
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
  const meLine = el("div", "tgp-line")
  const meLabel = el("span", "tgp-label")
  const meName = el("span", "tgp-fill")
  const meAction = button("tgp-link", "", () => openName("board"))
  meLine.append(meLabel, meName, meAction)
  const statusLine = el("div", "tgp-line tgp-bad")
  boardPanel.append(boardHead, trackLine, rows, ghostLine, meLine, statusLine)
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

  const drawRow = (entry: Entry, raced: string | null, ownRaced: boolean): HTMLElement => {
    const row = el("div", "tgp-row")
    if (entry.mine) row.classList.add("tgp-mine")
    if (entry.runId === raced || (entry.mine && ownRaced)) row.classList.add("tgp-raced")
    row.append(el("span", "tgp-rank tgp-mono", String(entry.rank)), el("span", "tgp-name", entry.name.toUpperCase()), el("span", "tgp-time tgp-mono", formatTime(entry.timeMs)), el("span", "tgp-dot"))
    row.title = entry.mine ? "Race your best" : `Race ${entry.name}`
    row.addEventListener("click", () => online.choose(entry.mine ? { kind: "own" } : { kind: "run", runId: entry.runId }))
    return row
  }

  const drawBoard = (): void => {
    const state = online.state()
    const board = state.board
    boardCount.textContent = state.boardLoading && board === null ? "…" : board === null ? "" : `${board.total} ${board.total === 1 ? "DRIVER" : "DRIVERS"}`
    rows.replaceChildren()
    const raced = state.choice.kind === "run" ? state.choice.runId : null
    const ownRaced = state.choice.kind === "own"
    if (board === null) {
      rows.appendChild(el("div", "tgp-empty", state.boardLoading ? "LOADING…" : state.reachable === false ? "CAN'T REACH THE BOARD" : "NO BOARD YET"))
    } else if (board.top.length === 0) {
      rows.appendChild(el("div", "tgp-empty", "NO LAPS YET: SET THE FIRST"))
    } else {
      for (const entry of board.top) rows.appendChild(drawRow(entry, raced, ownRaced))
      const around = board.around.filter((entry) => !board.top.some((top) => top.runId === entry.runId))
      if (around.length > 0) {
        const last = board.top[board.top.length - 1]
        const first = around[0]
        if (last !== undefined && first !== undefined && first.rank > last.rank + 1) rows.appendChild(el("div", "tgp-gap", "···"))
        for (const entry of around) rows.appendChild(drawRow(entry, raced, ownRaced))
      }
    }
    for (const { chip, choice } of ghostChips) chip.setAttribute("aria-pressed", String(sameChoice(choice, state.choice)))
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
  const skip = button("tgp-button", "SKIP", () => closeName(false))
  const save = el("button", "tgp-button tgp-primary", "SAVE")
  save.type = "submit"
  save.tabIndex = -1
  actions.append(skip, save)
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

  const openName = (from: Open): void => {
    nameFrom = from
    const identity = online.state().identity
    nameTitle.textContent = identity === null ? "PICK A NAME" : "CHANGE NAME"
    skip.textContent = identity === null && from === "none" ? "SKIP" : "CANCEL"
    input.value = identity?.name ?? ""
    busy = false
    show("name")
    typed()
    input.focus()
    input.select()
  }

  const closeName = (saved: boolean): void => {
    nameRequest++
    if (checkTimer !== null) clearTimeout(checkTimer)
    // Closing without a name the first time is choosing to stay unlisted.
    if (!saved && online.state().identity === null) online.skipName()
    input.blur()
    show(nameFrom === "board" ? "board" : "none")
  }

  // ── opening and closing ───────────────────────────────────────────────
  const show = (next: Open): void => {
    if (open === "name" && next !== "name") input.blur()
    open = next
    boardPanel.hidden = open !== "board"
    namePanel.hidden = open !== "name"
    opener.hidden = open !== "none"
    if (open === "board") {
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
    if (event.key === "l" || event.key === "L") show(open === "none" ? "board" : "none")
    else if (event.key === "Escape" && open !== "none") show("none")
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
    if (open === "board") drawBoard()
    drawOpener()
  })

  show("none")
  drawOpener()
  if (!online.state().enabled) root.hidden = true

  return {
    typing: () => document.activeElement === input,
    update(isRunning) {
      running = isRunning
      opener.classList.toggle("tgp-faded", running)
      if (promptAt >= 0 && !running && performance.now() >= promptAt && open !== "name") {
        promptAt = -1
        if (online.state().identity === null) openName(open === "board" ? "board" : "none")
      }
    },
    lapStarted() {
      promptAt = -1
      if (open === "name") closeName(false)
      if (open !== "none") show("none")
    }
  }
}
