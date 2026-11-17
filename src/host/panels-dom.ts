/**
 * What the leaderboard's DOM panels share (`panels.ts`, `board-all.ts`): making elements,
 * buttons that leave the keyboard to the car, the HUD's colours as CSS variables, and one
 * run drawn as a row.
 */
import type { Entry } from "../api/contract.ts"
import type { GhostChoice } from "./boards.ts"
import { formatTime, panelAlpha } from "./hud.ts"
import { palette } from "./palette.ts"
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

/** Which runs are raced now: the chosen one, the player's own, and those beside the ghost. */
export interface RaceMarks {
  readonly raced: string | null
  readonly ownRaced: boolean
  readonly fieldRuns: ReadonlyArray<string>
}

export const raceMarks = (choice: GhostChoice, fieldRuns: ReadonlyArray<string>): RaceMarks => ({
  raced: choice.kind === "run" ? choice.runId : null,
  ownRaced: choice.kind === "own",
  fieldRuns
})

/** Marks `row` (drawn by `drawRow`) as raced or beside the ghost, or neither. */
export const markRow = (row: HTMLElement, marks: RaceMarks): void => {
  const runId = row.dataset["run"]
  const mine = row.classList.contains("tgp-mine")
  row.classList.toggle("tgp-raced", runId === marks.raced || (mine && marks.ownRaced))
  const inField = runId === undefined ? -1 : marks.fieldRuns.indexOf(runId)
  const dot = row.querySelector<HTMLElement>(".tgp-dot")
  // A run raced beside the ghost wears its ghost's tint.
  if (dot !== null) dot.style.background = inField >= 0 ? fieldTintCss(inField) : ""
}

/**
 * One run as a bar: its place, its driver, its time, and how far it is behind the fastest
 * (`leaderMs`). A click races it (`choose`).
 */
export const drawRow = (entry: Entry, marks: RaceMarks, leaderMs: number, choose: (choice: GhostChoice) => void): HTMLElement => {
  const row = el("div", "tgp-row")
  if (entry.mine) row.classList.add("tgp-mine")
  row.append(
    el("span", "tgp-rank tgp-mono", String(entry.rank)),
    el("span", "tgp-name", entry.name.toUpperCase()),
    el("span", "tgp-time tgp-mono", formatTime(entry.timeMs)),
    el("span", "tgp-behind tgp-mono", entry.timeMs > leaderMs ? `+${((entry.timeMs - leaderMs) / 1000).toFixed(3)}` : ""),
    el("span", "tgp-dot")
  )
  row.dataset["key"] = entry.mine ? "me" : `player:${entry.name}`
  row.dataset["run"] = entry.runId
  row.title = entry.mine ? "Race your best" : `Race ${entry.name}`
  row.addEventListener("click", () => choose(entry.mine ? { kind: "own" } : { kind: "run", runId: entry.runId }))
  markRow(row, marks)
  return row
}
