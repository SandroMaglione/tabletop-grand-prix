/**
 * The whole board, in the middle of the window: opened from the corner board's SHOW ALL, it
 * lands on the player's own run (the top when they have none) and reads more of the board,
 * a page at a time, as the list is scrolled toward either end. A click on a run races it, and
 * its ▶ watches it (closing the list) and its ▾ drops its splits down, as on the corner board.
 * It is in the corner board's order (by lap, or by one sector), and its tabs change both.
 *
 * It is modal: while it is open the car is left alone (`open()` is read by the page), and the
 * arrows, Page Up/Down, Home and End scroll the list. The cross, `Esc`, `L` and a click
 * outside close it. What it has read is dropped when it closes; opening it again reads afresh.
 */
import type { BoardOrder, BoardPage, Entry } from "../api/contract.ts"
import type { Online } from "./online.ts"
import { button, drawEntry, el, markRow, orderChoices, orderHeading, orderTime, raceMarks, type RowActions, setHudColours } from "./panels-dom.ts"

/** Runs read at a time. */
const PAGE = 100
/** How many runs above the player's own the first read starts. */
const ABOVE = 40
/** Read more once the list is scrolled this close (px) to an end. */
const NEAR = 600
/** One row's height and the gap under it (px), as `panels.css` draws them, for the arrow keys. */
const ROW = 30

export interface AllBoard {
  open(): boolean
  show(): void
  hide(): void
}

export const createAllBoard = (online: Online, actions: RowActions, sectors: number): AllBoard => {
  const root = el("div", "tgp-all")
  setHudColours(root)
  root.hidden = true
  const panel = el("div", "tgp-panel tgp-all-panel")
  const head = el("div", "tgp-head")
  const count = el("span", "tgp-count")
  head.append(el("span", "tgp-title", "LEADERBOARD"), count, button("tgp-x", "×", () => hide()))
  const cols = el("div", "tgp-cols")
  const timeHeading = el("span", "", "BEST")
  cols.append(el("span", "", "POS"), el("span", "", "DRIVER"), timeHeading, el("span", "", "GAP"), el("span"), el("span"), el("span"))
  const orderLine = el("div", "tgp-line")
  orderLine.appendChild(el("span", "tgp-label", "BY"))
  const orderChips = orderChoices(sectors).map(({ text, order }) => {
    const chip = button("tgp-chip", text, () => online.setOrder(order))
    orderLine.appendChild(chip)
    return { chip, order }
  })
  const list = el("div", "tgp-rows tgp-all-rows")
  const topLine = el("div", "tgp-all-more")
  const bottomLine = el("div", "tgp-all-more")
  const rows = el("div", "tgp-all-list")
  list.append(topLine, rows, bottomLine)
  const foot = el("div", "tgp-line")
  const top = button("tgp-chip", "TOP", () => void jump(1))
  const me = button("tgp-chip", "MY POSITION", () => void jump(myRank()))
  const keys = el("span", "tgp-fill tgp-dim tgp-all-keys", "ESC TO CLOSE")
  foot.append(top, me, keys)
  panel.append(head, orderLine, cols, list, foot)
  root.appendChild(panel)
  document.body.appendChild(root)

  // What has been read: the runs from rank `first` to `last`, drawn in order.
  let first = 1
  let last = 0
  let total = 0
  let leaderMs = 0
  /** The order the list was read in; another one reads it afresh. */
  let drawnOrder: BoardOrder = null
  let loadingUp = false
  let loadingDown = false
  /** Drops answers read for an earlier opening or jump. */
  let generation = 0
  const shown = new Set<string>()

  const myRank = (): number | null => {
    const state = online.state()
    return state.shown?.me?.rank ?? (state.order === null ? state.rank?.rank ?? null : null)
  }
  const look = () => ({ marks: raceMarks(online.state(), drawnOrder), order: drawnOrder, leaderMs })

  const drawEnds = (): void => {
    topLine.textContent = loadingUp ? "LOADING…" : ""
    topLine.hidden = !loadingUp
    bottomLine.textContent = loadingDown ? "LOADING…" : last > 0 && last >= total ? `${total} ${total === 1 ? "DRIVER" : "DRIVERS"}` : ""
    bottomLine.hidden = bottomLine.textContent === ""
    count.textContent = total > 0 ? `${total} ${total === 1 ? "DRIVER" : "DRIVERS"}` : ""
    me.disabled = myRank() === null
    timeHeading.textContent = orderHeading(drawnOrder)
    for (const { chip, order } of orderChips) chip.setAttribute("aria-pressed", String(order === online.state().order))
  }

  const rowsOf = (entries: ReadonlyArray<Entry>): DocumentFragment => {
    const fragment = document.createDocumentFragment()
    const now = look()
    entries.forEach((entry, i) => {
      // The board may have moved between two reads: a run already drawn is not drawn twice.
      if (shown.has(entry.runId)) return
      shown.add(entry.runId)
      const before = entries[i - 1]
      fragment.appendChild(drawEntry(entry, before !== undefined && before.rank === entry.rank - 1 ? before : null, now, actions))
    })
    return fragment
  }

  const took = (page: BoardPage): void => {
    total = page.total
    if (page.from === 1 && page.entries[0] !== undefined) leaderMs = orderTime(page.entries[0], drawnOrder)
  }

  /** Reads the runs just before those drawn, keeping the list where it was on screen. */
  const loadUp = async (): Promise<void> => {
    if (loadingUp || first <= 1) return
    const request = generation
    loadingUp = true
    drawEnds()
    const from = Math.max(1, first - PAGE)
    const page = await online.page(from, first - from, drawnOrder)
    if (request !== generation) return
    loadingUp = false
    if (page !== null) {
      took(page)
      const before = list.scrollHeight
      rows.prepend(rowsOf(page.entries))
      first = from
      list.scrollTop += list.scrollHeight - before
    }
    drawEnds()
    if (page !== null) fill()
  }

  /** Reads the runs just after those drawn. */
  const loadDown = async (): Promise<void> => {
    if (loadingDown || last >= total) return
    const request = generation
    loadingDown = true
    drawEnds()
    const page = await online.page(last + 1, PAGE, drawnOrder)
    if (request !== generation) return
    loadingDown = false
    if (page !== null) {
      took(page)
      rows.append(rowsOf(page.entries))
      last = page.entries.length > 0 ? last + page.entries.length : total
    }
    drawEnds()
    if (page !== null) fill()
  }

  /** Reads more while an end is in sight. */
  const fill = (): void => {
    if (root.hidden) return
    if (list.scrollTop < NEAR) void loadUp()
    if (list.scrollHeight - list.scrollTop - list.clientHeight < NEAR) void loadDown()
  }
  list.addEventListener("scroll", fill, { passive: true })

  /** The row of the run at `rank`, when drawn (open splits sit between rows). */
  const rowAt = (rank: number): HTMLElement | null => rows.querySelector<HTMLElement>(`.tgp-row[data-rank="${rank}"]`)

  /** Starts the list over at `rank` (the top for none), with that run in the middle. */
  const jump = async (rank: number | null): Promise<void> => {
    // Already drawn in this order: scroll to it.
    const drawn = rank === null || rank < first || rank > last || online.state().order !== drawnOrder ? null : rowAt(rank)
    if (drawn instanceof HTMLElement) {
      list.scrollTop = drawn.offsetTop - list.clientHeight / 2 + drawn.offsetHeight / 2
      return
    }
    const request = ++generation
    shown.clear()
    rows.replaceChildren()
    loadingUp = false
    loadingDown = true
    drawnOrder = online.state().order
    const leader = online.state().shown?.top[0]
    leaderMs = leader === undefined ? 0 : orderTime(leader, drawnOrder)
    total = online.state().shown?.total ?? 0
    drawEnds()
    const from = rank === null ? 1 : Math.max(1, rank - ABOVE)
    const page = await online.page(from, PAGE, drawnOrder)
    if (request !== generation) return
    loadingDown = false
    if (page === null) {
      first = 1
      last = 0
      rows.replaceChildren(el("div", "tgp-empty", "CAN'T REACH THE BOARD"))
      drawEnds()
      return
    }
    took(page)
    first = from
    last = from - 1 + page.entries.length
    rows.appendChild(page.entries.length === 0 ? el("div", "tgp-empty", "NO LAPS YET: SET THE FIRST") : rowsOf(page.entries))
    drawEnds()
    const target = rank === null ? null : rowAt(rank)
    list.scrollTop = target instanceof HTMLElement ? target.offsetTop - list.clientHeight / 2 + target.offsetHeight / 2 : 0
    fill()
  }

  const show = (): void => {
    if (!root.hidden) return
    root.hidden = false
    void jump(myRank())
  }

  const hide = (): void => {
    if (root.hidden) return
    root.hidden = true
    generation++
    shown.clear()
    rows.replaceChildren()
    first = 1
    last = 0
  }

  // A click outside the panel closes it.
  root.addEventListener("pointerdown", (event) => {
    if (event.target === root) hide()
  })
  // The car's keys are the list's while it is open (the car's own handler leaves them unused).
  window.addEventListener("keydown", (event) => {
    if (root.hidden || event.ctrlKey || event.metaKey || event.altKey) return
    const page = list.clientHeight * 0.9
    const by: Record<string, number> = { ArrowUp: -ROW, ArrowDown: ROW, PageUp: -page, PageDown: page }
    const step = by[event.key]
    if (step !== undefined) list.scrollBy({ top: step })
    else if (event.key === "Home") list.scrollTop = 0
    else if (event.key === "End") list.scrollTop = list.scrollHeight
    else return
    event.preventDefault()
  })

  // The raced ghost and the field may change while the list is open, and the order with its tabs.
  online.subscribe(() => {
    if (root.hidden) return
    const state = online.state()
    // Another order: read afresh once its board is in, to land on the player's place in it.
    if (state.order !== drawnOrder && (state.shown !== null || !state.boardLoading)) return void jump(myRank())
    const now = raceMarks(state, drawnOrder)
    for (const row of rows.querySelectorAll<HTMLElement>(".tgp-row")) markRow(row, now)
    drawEnds()
  })

  return { open: () => !root.hidden, show, hide }
}
