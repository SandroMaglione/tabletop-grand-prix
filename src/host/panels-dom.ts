/**
 * What the leaderboard's DOM panels share (`panels.ts`, `board-all.ts`): making elements,
 * buttons that leave the keyboard to the car, the HUD's colours as CSS variables, and one
 * run drawn as a row, with its splits dropping down under it.
 */
import type { BoardOrder, Entry } from "../api/contract.ts"
import { formatTime, panelAlpha } from "./hud.ts"
import type { OnlineState } from "./online.ts"
import { palette } from "./palette.ts"
import type { RunSplits, Splits } from "./splits.ts"
import { fieldTintCss } from "./tints.ts"

const hex = (colour: number): string => `#${colour.toString(16).padStart(6, "0")}`
const rgba = (colour: number, alpha: number): string => `rgba(${(colour >> 16) & 255}, ${(colour >> 8) & 255}, ${colour & 255}, ${alpha})`

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== "") node.className = className
  if (text !== "") node.textContent = text
  return node
}

/** A button that does not take the keyboard's focus, so space and the arrows stay with the car. */
export const button = (className: string, text: string, onClick: () => void): HTMLButtonElement => {
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

/** Sets the HUD's colours on `node` as the variables `panels.css` reads. */
export const setHudColours = (node: HTMLElement): void => {
  node.style.setProperty("--hud-back", hex(palette.hudBack))
  node.style.setProperty("--hud-back-a", rgba(palette.hudBack, panelAlpha))
  node.style.setProperty("--hud-head-a", rgba(palette.hudHead, 0.55))
  node.style.setProperty("--hud-text", hex(palette.hudText))
  node.style.setProperty("--hud-dim", hex(palette.hudDim))
  node.style.setProperty("--hud-accent", hex(palette.hudAccent))
  node.style.setProperty("--hud-good", hex(palette.hudGood))
  node.style.setProperty("--hud-bad", hex(palette.hudBad))
  node.style.setProperty("--ghost", hex(palette.ghost))
}

/** Which runs are raced now: as the ghost, the player's own, those added beside it, and those beside it now. */
export interface RaceMarks {
  readonly raced: ReadonlyArray<string>
  readonly ownRaced: boolean
  readonly picked: ReadonlyArray<string>
  readonly fieldRuns: ReadonlyArray<string>
}

/**
 * The marks of a board in `order`. Racing by sector, a board by one sector marks only that
 * sector's driver; by lap, every sector's.
 */
export const raceMarks = (state: Pick<OnlineState, "choice" | "raced" | "legs" | "picked" | "fieldRuns">, order: BoardOrder): RaceMarks => {
  const leg = state.choice.kind === "sectors" && order !== null ? state.legs[order] : undefined
  return {
    raced: leg === undefined ? state.raced : leg === null ? [] : [leg.runId],
    ownRaced: state.choice.kind === "own",
    picked: state.picked,
    fieldRuns: state.fieldRuns
  }
}

/** What a board in `order` ranks a run by: its lap, or its time in that sector. */
export const orderTime = (entry: Entry, order: BoardOrder): number => (order === null ? entry.timeMs : entry.sectorsMs?.[order] ?? entry.timeMs)

/** The heading of the time column of a board in `order`. */
export const orderHeading = (order: BoardOrder): string => (order === null ? "BEST" : `S${order + 1}`)

/** The board's orders as chips: the lap, then each sector. */
export const orderChoices = (sectors: number): ReadonlyArray<{ readonly text: string; readonly order: BoardOrder }> => [
  { text: "LAP", order: null },
  ...Array.from({ length: sectors }, (_, i) => ({ text: `S${i + 1}`, order: i }))
]

/** Marks `row` (drawn by `drawRow`) as raced, added beside the ghost, or neither, and says what a click on it does. */
export const markRow = (row: HTMLElement, marks: RaceMarks): void => {
  const runId = row.dataset["run"] ?? ""
  const mine = row.classList.contains("tgp-mine")
  const raced = marks.raced.includes(runId) || (mine && marks.ownRaced)
  const picked = marks.picked.includes(runId)
  row.classList.toggle("tgp-raced", raced)
  row.classList.toggle("tgp-picked", picked && !raced)
  const who = mine ? "your best" : `${row.dataset["name"] ?? ""}'s ghost`
  row.title = raced || picked ? `Click to stop racing ${who}` : `Click to race ${who}${row.dataset["lap"] ?? ""}`
  const inField = marks.fieldRuns.indexOf(runId)
  const dot = row.querySelector<HTMLElement>(".tgp-dot")
  // A run raced beside the ghost wears its ghost's tint.
  if (dot !== null) dot.style.background = inField >= 0 ? fieldTintCss(inField) : ""
}

/** What a board's rows do, and which of them have their splits open (kept across draws and both boards). */
export interface RowActions {
  /** A click on the row: races its ghost too, or stops racing it (or picks a sector's driver). */
  readonly click: (entry: Entry) => void
  /** Its ▶: watch the run, only the sector the board is ordered by when it is. */
  readonly watch: (entry: Entry, order: BoardOrder) => void
  readonly splits: Splits
  /** The runs whose splits are open, by id. */
  readonly open: Set<string>
}

const signed = (ms: number): string => `${ms > 0 ? "+" : ms < 0 ? "−" : "±"}${(Math.abs(ms) / 1000).toFixed(3)}`
const tone = (ms: number | null): string => (ms === null || ms === 0 ? "" : ms > 0 ? "tgp-bad" : "tgp-good")

/**
 * Fills `node` with a run's sectors, one row each on the board's own columns: the sector,
 * its time under BEST, and what it gains or loses on the run just above under GAP. The
 * row is tinted, faintly, red where it loses and green where it gains; the name of the sector
 * losing the most is in red.
 */
const fillSplits = (node: HTMLElement, splits: RunSplits): void => {
  node.replaceChildren(
    ...splits.sectors.map((sector, i) => {
      const gain = sector.deltaMs === null || sector.deltaMs === 0 ? "" : sector.deltaMs > 0 ? " tgp-sector-slower" : " tgp-sector-faster"
      const line = el("div", `tgp-sector${gain}${i === splits.worst ? " tgp-sector-worst" : ""}`)
      line.append(
        el("span", "tgp-rank tgp-mono", `S${i + 1}`),
        el("span", "tgp-name"),
        el("span", "tgp-time tgp-mono", formatTime(sector.ms)),
        el("span", `tgp-behind tgp-mono ${tone(sector.deltaMs)}`, sector.deltaMs === null ? "" : signed(sector.deltaMs))
      )
      return line
    })
  )
  node.title = splits.above === null ? "The fastest lap's sectors" : `Against P${splits.above.rank} ${splits.above.name}, the run just above`
}

const waiting = (text: string): HTMLElement => {
  const line = el("div", "tgp-sector tgp-sector-wait")
  line.append(el("span"), el("span", "tgp-name", text))
  return line
}

/** A run's splits, under its row: drawn at once when known, else filled in once both laps are driven. */
const drawSplits = (entry: Entry, above: Entry | null, order: BoardOrder, splits: Splits): HTMLElement => {
  const node = el("div", "tgp-row-splits")
  const known = splits.known(entry, above, order)
  if (known !== null) {
    fillSplits(node, known)
    return node
  }
  node.appendChild(waiting("DRIVING THE LAPS…"))
  void splits.load(entry, above, order).then((got) => {
    if (got === null) node.replaceChildren(waiting("CAN'T LOAD THE SPLITS"))
    else fillSplits(node, got)
  })
  return node
}

/** How a board's rows are drawn: which runs are raced, the board's order, and the leader's time in it. */
export interface RowLook {
  readonly marks: RaceMarks
  readonly order: BoardOrder
  readonly leaderMs: number
}

/**
 * A run as its row, and its splits under it when they are open. `above` is the run just above
 * it on the board in its order, when the caller has it (the board is asked otherwise).
 */
export const drawEntry = (entry: Entry, above: Entry | null, look: RowLook, actions: RowActions): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  const row = drawRow(entry, look, actions, () => {
    const next = row.nextElementSibling
    if (actions.open.delete(entry.runId)) {
      if (next instanceof HTMLElement && next.classList.contains("tgp-row-splits")) next.remove()
    } else {
      actions.open.add(entry.runId)
      row.after(drawSplits(entry, above, look.order, actions.splits))
    }
    row.classList.toggle("tgp-open", actions.open.has(entry.runId))
  })
  fragment.appendChild(row)
  if (actions.open.has(entry.runId)) {
    row.classList.add("tgp-open")
    fragment.appendChild(drawSplits(entry, above, look.order, actions.splits))
  }
  return fragment
}

/**
 * One run as a bar: its place, its driver, its time (the lap's, or the sector's the board is
 * ordered by), how far it is behind the fastest (`leaderMs`), a button to watch it, and one to
 * open its splits. A click on the bar adds its ghost or takes it away (`click`); on ▶, watches
 * it, or only its sector on a board by sector (`watch`); on ▾, opens or closes its splits.
 */
const drawRow = (entry: Entry, look: RowLook, actions: RowActions, toggle: () => void): HTMLElement => {
  const { marks, order, leaderMs } = look
  const timeMs = orderTime(entry, order)
  const { click, watch } = actions
  const row = el("div", "tgp-row")
  const watchButton = button("tgp-watch", "▶", () => watch(entry, look.order))
  const part = look.order === null ? "" : ` in S${look.order + 1}`
  watchButton.title = entry.mine ? `Watch your best${part}` : `Watch ${entry.name}${part}`
  watchButton.setAttribute("aria-label", watchButton.title)
  const splitsButton = button("tgp-open-splits", "▾", toggle)
  splitsButton.title = entry.rank > 1 ? "Splits against the run above" : "Splits"
  splitsButton.setAttribute("aria-label", splitsButton.title)
  if (entry.mine) row.classList.add("tgp-mine")
  row.append(
    el("span", "tgp-rank tgp-mono", String(entry.rank)),
    el("span", "tgp-name", entry.name.toUpperCase()),
    el("span", "tgp-time tgp-mono", formatTime(timeMs)),
    el("span", "tgp-behind tgp-mono", timeMs > leaderMs ? `+${((timeMs - leaderMs) / 1000).toFixed(3)}` : ""),
    el("span", "tgp-dot"),
    watchButton,
    splitsButton
  )
  row.dataset["key"] = entry.mine ? "me" : `player:${entry.name}`
  row.dataset["run"] = entry.runId
  row.dataset["rank"] = String(entry.rank)
  row.dataset["name"] = entry.name
  if (order !== null) row.dataset["lap"] = ` (lap ${formatTime(entry.timeMs)})`
  row.addEventListener("click", () => click(entry))
  markRow(row, marks)
  return row
}
