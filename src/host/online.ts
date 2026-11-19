/**
 * The leaderboard, as the page lives with it: the player's name, sending a best lap, the
 * board of the track being driven (by the lap, or by one sector), and which ghosts to race.
 *
 * It talks to the server only through the `Leaderboard` service and keeps what it learns in
 * plain fields the page reads while it draws. Nothing here throws or waits in the game
 * loop: every request runs on its own, every failure (the server cannot be reached, it is
 * slow, it answers something unexpected) becomes a value, and the game goes on with what the
 * device has. With no server at all (`enabled` false) it asks nothing, and the ghost is the
 * device's own best, as before there was a leaderboard.
 *
 * A player never has to type a name: on the first finished lap the device is registered under
 * a made-up one (`handles.ts`), and the lap goes to the board under it. The player can change
 * it from the board whenever they like. A player who closed the name panel without a name
 * (before names were made up) chose to stay off the board, and is left there.
 *
 * A best lap is first put in the outbox, then sent; it leaves the outbox only once the
 * server has answered for it. The outbox is sent again after every finish and on every visit.
 */
import { Effect, Result } from "effect"
import { type Board, type BoardOrder, type BoardPage, type Entry, type Identity, Leaderboard, type LeaderboardShape, type NameRefused, type RunReplay, type Submitted, type Unavailable } from "../api/contract.ts"
import { tidyName } from "../api/names.ts"
import { Bests, type GhostChoice, Outbox, Rivals, type SavedRival } from "./boards.ts"
import { ghostFromReplay, sectorGhost, type Ghost, type LapGhost } from "./ghost.ts"
import type { FieldRun } from "./field.ts"
import { makeHandle } from "./handles.ts"
import type { FinishResult, Laps } from "./laps.ts"
import { Profile } from "./profile.ts"

/** What the page asks of the device and the server. */
export type OnlineServices = Leaderboard | Profile | Bests | Rivals | Outbox

/** Runs an effect that cannot fail; a defect is logged and reads as undefined. */
export type Runner = <A>(effect: Effect.Effect<A, never, OnlineServices>) => Promise<A | undefined>

/** What became of a best lap sent to the board. */
export type PostState =
  | { readonly kind: "sending" }
  | { readonly kind: "sent"; readonly rank: number; readonly total: number }
  /** Kept on the device; it goes when the server can be reached. */
  | { readonly kind: "waiting" }
  /** Kept on the device; it goes once the player picks a name. */
  | { readonly kind: "unlisted" }
  /** The server would not file it. */
  | { readonly kind: "refused" }

/** The answer to a name, while the player types it or when they save it. */
export type NameAnswer =
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly reason: NameRefused["reason"] }
  | { readonly kind: "taken" }
  | { readonly kind: "limited"; readonly seconds: number }
  | { readonly kind: "unavailable" }

export interface OnlineState {
  /** A server is configured. Without one there is no name, no board, no rival. */
  readonly enabled: boolean
  /** Whether the last request reached the server; null before any. */
  readonly reachable: boolean | null
  readonly identity: Identity | null
  /** The board by lap: the player's place on it, and the runs near it. */
  readonly board: Board | null
  /** How the board is shown: by the lap (null), or by one sector (0 is the first). */
  readonly order: BoardOrder
  /** The board as it is shown, in `order` (the lap board itself when by lap); null until read. */
  readonly shown: Board | null
  readonly boardLoading: boolean
  /** What became of the last best lap, and the attempt it was driven in. */
  readonly post: { readonly attempt: number; readonly state: PostState } | null
  /** The player's place on this board, from the last board or the last run sent. */
  readonly rank: { readonly rank: number; readonly total: number } | null
  readonly choice: GhostChoice
  /** The runs of the board raced as the ghost: the next closest or the fastest, or each sector's driver. */
  readonly raced: ReadonlyArray<string>
  /** Racing by sector: each sector's driver as found (the fastest there, unless one was picked), null where none is. Empty otherwise. */
  readonly legs: ReadonlyArray<{ readonly runId: string; readonly name: string } | null>
  /** The runs the player added from the board, in the order added (`maxPicked` at most). */
  readonly picked: ReadonlyArray<string>
  /** The runs of the board raced beside the ghost, in the order of their tints (`fieldTint`): the picked ones whose laps are in, less the raced. */
  readonly fieldRuns: ReadonlyArray<string>
  /** A ghost is being fetched or driven. */
  readonly ghostLoading: boolean
  /** Counts the times the page should offer the player a name (a name the server no longer knows). */
  readonly namePrompts: number
}

export interface Online {
  state(): OnlineState
  /** Called after every change of `state()`. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Once, when the page is ready: sends what waits, fetches the board and the rival. */
  start(): void
  /** After every finished lap. */
  finished(result: FinishResult): void
  refreshBoard(): void
  /** Up to `count` runs of this track's board in `order` from rank `from` on, for reading all of it; null when it cannot be had. */
  page(from: number, count: number, order: BoardOrder): Promise<BoardPage | null>
  /** Races the ghost `choice` asks for, and only it: the runs added go (OFF races nothing at all). Kept. */
  choose(choice: GhostChoice): void
  /** Shows the board by the lap (null) or by one sector; the `fastest` ghost follows it. Kept with the choice. */
  setOrder(order: BoardOrder): void
  /**
   * A click on a run of the board: races its ghost too, or stops racing it when it races
   * (added, or as the ghost the choice found: then no ghost is chosen, and the runs added stay). Kept.
   */
  toggle(entry: Entry): void
  /** Takes away every run added. */
  clearPicked(): void
  /** Races by sector, with `runId` (null: the fastest there) as the driver of `sector`. */
  setLeg(sector: number, runId: string | null): void
  /** A run's replay, to watch it; null when it cannot be had. */
  replay(runId: string): Promise<RunReplay | null>
  /** Whether a name could be taken now (it is not saved). */
  checkName(name: string): Promise<NameAnswer>
  /** Registers the name, or renames the player who has one. */
  saveName(name: string): Promise<NameAnswer>
  /** The player would rather stay off the board for now. */
  skipName(): void
}

export interface OnlineOptions {
  readonly enabled: boolean
  readonly run: Runner
  readonly track: string
  readonly rules: number
  readonly laps: Laps
  readonly ghost: Ghost
  readonly identity: Identity | null
  /** The player has a name or chose to have none: none is made up for them. */
  readonly asked: boolean
  /** Makes up a name for a new player. `makeHandle` unless a test wants to know it. */
  readonly handle?: () => string
  readonly rival: SavedRival
  /** How many sectors the track's lap has (`sectorCount`): the orders the board can be shown in. */
  readonly sectors?: number
  /** Gets the runs to race beside the ghost, whenever they change (`Field.set`). */
  readonly raceField?: (runs: ReadonlyArray<FieldRun>) => void
  /** Every track id, to send what waits on each. */
  readonly tracks: ReadonlyArray<string>
  /** Defers work that would cost a frame (driving a replay again) out of the current tick. */
  readonly defer?: (work: () => void) => void
  /** How long a request may take before it counts as unavailable. */
  readonly timeoutMs?: number
}

/** The most runs the player may add beside the ghost. */
export const maxPicked = 20

const unavailable: Unavailable = { _tag: "Unavailable" }

/** Every way a request can end, as a value: its own failures, a timeout, and anything unexpected. */
const ask = <A, E>(timeoutMs: number, use: (board: LeaderboardShape) => Effect.Effect<A, E>): Effect.Effect<Result.Result<A, E | Unavailable>, never, Leaderboard> =>
  Leaderboard.use(use).pipe(
    Effect.timeoutOrElse({ duration: `${timeoutMs} millis`, orElse: () => Effect.fail(unavailable) }),
    Effect.result,
    Effect.catchCause((cause) => {
      console.warn("the leaderboard failed", cause)
      return Effect.succeed(Result.fail(unavailable))
    })
  )

const nameAnswer = (failure: { readonly _tag: string; readonly reason?: NameRefused["reason"]; readonly retryAfterSeconds?: number }): NameAnswer =>
  failure._tag === "NameRefused" && failure.reason !== undefined
    ? { kind: "refused", reason: failure.reason }
    : failure._tag === "NameTaken"
      ? { kind: "taken" }
      : failure._tag === "RateLimited"
        ? { kind: "limited", seconds: failure.retryAfterSeconds ?? 0 }
        : { kind: "unavailable" }

export const createOnline = (options: OnlineOptions): Online => {
  const { enabled, run, track, rules, laps, ghost } = options
  const timeoutMs = options.timeoutMs ?? 8000
  const defer = options.defer ?? ((work: () => void) => setTimeout(work, 0))
  const listeners = new Set<() => void>()

  let reachable: boolean | null = null
  let identity = options.identity
  let asked = options.asked
  let board: Board | null = null
  const sectors = Math.max(1, Math.floor(options.sectors ?? 1))
  const validOrder = (asked: BoardOrder): BoardOrder => (asked !== null && Number.isInteger(asked) && asked >= 0 && asked < sectors ? asked : null)
  let order: BoardOrder = validOrder(options.rival.order)
  /** The board by one sector, with the sector it is of, so it is never shown as another's. */
  let sectorBoard: { readonly order: number; readonly board: Board } | null = null
  let boardLoading = false
  let post: OnlineState["post"] = null
  let submitted: Submitted | null = null
  let choice: GhostChoice = options.rival.choice
  /** The last rival's run, kept for offline. */
  let rivalRun: RunReplay | null = options.rival.run
  let ghostLoading = false
  let picked: ReadonlyArray<string> = options.rival.picked.slice(0, maxPicked)
  let legs: OnlineState["legs"] = []
  let fieldRuns: ReadonlyArray<string> = []
  /** The field last asked for (its run ids), so a change asks once. */
  let fieldWanted = ""
  /** Replays of the board's runs fetched this visit, by run id. */
  const fetched = new Map<string, RunReplay>()
  let namePrompts = 0
  /** A made-up name is being registered: the lap waits for that, not for the player. */
  let naming = false
  /** Ghosts already driven, by run id (and "own:<time>" for the player's own), so going back to one costs nothing. */
  const driven = new Map<string, LapGhost>()
  /** Drops answers to an older choice. */
  let ghostRequest = 0

  let snapshot: OnlineState | null = null
  const changed = (): void => {
    snapshot = null
    pickField()
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error(error)
      }
    }
  }

  const reached = (result: Result.Result<unknown, { readonly _tag: string }>): void => {
    reachable = Result.isSuccess(result) || result.failure._tag !== "Unavailable"
  }

  /** A run's replay, fetched once a visit; undefined when it cannot be had. */
  const replayOf = async (runId: string): Promise<RunReplay | undefined> => {
    if (rivalRun !== null && rivalRun.runId === runId) return rivalRun
    const known = fetched.get(runId)
    if (known !== undefined) return known
    const got = await run(ask(timeoutMs, (lb) => lb.replay(runId)))
    if (got !== undefined) reached(got)
    if (got === undefined || Result.isFailure(got)) return undefined
    fetched.set(runId, got.success)
    return got.success
  }

  /** The fastest run of the board in `by` that is not the player's own (of the first two, one is not); null for none, undefined when it cannot be had. */
  const fastestIn = async (by: BoardOrder): Promise<Entry | null | undefined> => {
    const got = await run(ask(timeoutMs, (lb) => lb.page(track, 1, 2, identity, by)))
    if (got !== undefined) reached(got)
    if (got === undefined || Result.isFailure(got)) return undefined
    return got.success.entries.find((one) => !one.mine) ?? null
  }

  // ── the ghost ──────────────────────────────────────────────────────────

  const ownGhost = (): LapGhost | null => {
    const best = laps.best()
    if (best === null) return null
    const key = `own:${best.replay.length}:${best.timeMs}`
    const known = driven.get(key)
    if (known !== undefined) return known
    const made = ghostFromReplay(best.replay, { kind: "own", name: identity?.name ?? "you", runId: null })
    if (made !== null) driven.set(key, made)
    return made
  }

  const rivalGhost = (runReplay: RunReplay): LapGhost | null => {
    const known = driven.get(runReplay.runId)
    if (known !== undefined) return known
    const replayed = ghostFromReplay(runReplay.replay, { kind: "rival", name: runReplay.name, runId: runReplay.runId })
    // Shown with the board's own time, so the timing panel and the board agree to the millisecond.
    const made = replayed === null ? null : { ...replayed, timeMs: runReplay.timeMs }
    if (made !== null) driven.set(runReplay.runId, made)
    return made
  }

  /** Whether the kept rival is still worth chasing: faster than the player's best. */
  const stillAhead = (one: RunReplay | null): one is RunReplay => {
    const best = laps.best()
    return one !== null && (best === null || one.timeMs < best.timeMs)
  }

  const keepRival = (): void => {
    void run(Rivals.use((rivals) => rivals.set(track, rules, { version: 2, choice, order, picked, run: rivalRun })))
  }

  /** Shows the ghost the device can show without asking anyone. */
  const showLocal = (): void => {
    if (choice.kind === "none") ghost.set(null)
    else if (choice.kind === "own" || !enabled) ghost.set(ownGhost())
    // The fastest found last time, until the board says who it is now.
    else if (choice.kind === "fastest") ghost.set(rivalRun !== null ? rivalGhost(rivalRun) ?? ownGhost() : ownGhost())
    // By sector: the drivers raced until now stay until the new ones are in.
    else if (choice.kind === "sectors") {
      if (ghost.current()?.kind !== "sectors") ghost.set(ownGhost())
    } else ghost.set(stillAhead(rivalRun) ? rivalGhost(rivalRun) ?? ownGhost() : ownGhost())
  }

  /** Drives `found` again (out of the tick) and races it, unless a newer choice came meanwhile. */
  const race = (request: number, found: RunReplay): void => {
    defer(() => {
      if (request !== ghostRequest) return
      const made = rivalGhost(found)
      rivalRun = found
      keepRival()
      ghost.set(made ?? ownGhost())
      ghostLoading = false
      changed()
    })
  }

  const fetchRun = async (request: number, runId: string): Promise<void> => {
    const got = await replayOf(runId)
    if (request !== ghostRequest) return
    if (got !== undefined) return race(request, got)
    // Gone or unreachable: the device's own best stands in.
    ghostLoading = false
    defer(() => {
      if (request === ghostRequest) ghost.set(ownGhost())
    })
    changed()
  }

  /**
   * Races one driver per sector: the one picked for it, or the fastest there. A sector whose
   * driver cannot be had is driven by the player's own best; without one, the own best races alone.
   */
  const raceBySector = async (request: number, asked: ReadonlyArray<string | null>): Promise<void> => {
    const ids = await Promise.all(Array.from({ length: sectors }, async (_, i) => asked[i] ?? (await fastestIn(i))?.runId ?? null))
    const replays = await Promise.all(ids.map((id) => (id === null ? Promise.resolve(undefined) : replayOf(id))))
    if (request !== ghostRequest) return
    defer(() => {
      if (request !== ghostRequest) return
      const own = ownGhost()
      const made = replays.map((one) => (one === undefined ? null : rivalGhost(one)) ?? own)
      legs = replays.map((one) => (one === undefined ? null : { runId: one.runId, name: one.name }))
      ghost.set(made.every((leg): leg is LapGhost => leg !== null) ? sectorGhost(made) : own)
      ghostLoading = false
      changed()
    })
  }

  /** Finds the ghost the choice asks for, asking the server when it must. */
  const resolveGhost = (): void => {
    const request = ++ghostRequest
    if (choice.kind !== "sectors") legs = []
    defer(() => {
      if (request !== ghostRequest) return
      showLocal()
      // The raced ghost may have changed: it leaves the field.
      changed()
    })
    if (!enabled || choice.kind === "none" || choice.kind === "own") {
      ghostLoading = false
      changed()
      return
    }
    ghostLoading = true
    changed()
    if (choice.kind === "sectors") {
      void raceBySector(request, choice.runs)
      return
    }
    if (choice.kind === "fastest") {
      void fastestIn(order).then((entry) => {
        if (request !== ghostRequest) return
        if (entry === undefined) {
          // Unreachable: the last fastest kept (or the own best), already shown.
          ghostLoading = false
          changed()
          return
        }
        if (entry === null) return nobodyAhead(request)
        void fetchRun(request, entry.runId)
      })
      return
    }
    const best = laps.best()
    void run(ask(timeoutMs, (lb) => lb.rival(track, best === null ? null : Math.floor(best.timeMs), identity))).then((got) => {
      if (request !== ghostRequest) return
      if (got !== undefined) reached(got)
      if (got === undefined || Result.isFailure(got)) {
        // Unreachable: the kept rival (if still ahead) or the own best, already shown.
        ghostLoading = false
        changed()
        return
      }
      const entry: Entry | null = got.success
      if (entry === null) return nobodyAhead(request)
      void fetchRun(request, entry.runId)
    })
  }

  /** Nobody else is there to race: the player's own best is the one to beat. */
  const nobodyAhead = (request: number): void => {
    rivalRun = null
    keepRival()
    ghostLoading = false
    defer(() => {
      if (request === ghostRequest) ghost.set(ownGhost())
    })
    changed()
  }

  // ── the field ──────────────────────────────────────────────────────────

  /** The board as it is shown: by the lap, or the board of the sector it is shown by (null until read). */
  const shownBoard = (): Board | null => (order === null ? board : sectorBoard !== null && sectorBoard.order === order ? sectorBoard.board : null)

  /** The runs of the board raced as the ghost now (or about to be): none for the player's own. */
  const racedRuns = (): ReadonlyArray<string> => {
    const current = ghost.current()
    if (current === null) return []
    const runs = current.kind === "sectors" ? current.legs.map((leg) => leg.runId) : [current.runId]
    return runs.filter((runId): runId is string => runId !== null)
  }

  /** The runs of the board raced as the ghost the choice found: the next closest or the fastest, or each sector's driver. */
  const racedNow = (): ReadonlyArray<string> =>
    choice.kind === "sectors" ? legs.flatMap((leg) => (leg === null ? [] : [leg.runId])) : choice.kind === "next" || choice.kind === "fastest" ? racedRuns() : []

  /** The runs the player added, less any raced as the ghost: their replays are fetched, then handed on. */
  const pickField = (): void => {
    const raced = new Set(racedRuns())
    const wanted = enabled ? picked.filter((runId) => !raced.has(runId)) : []
    const key = wanted.join(" ")
    if (key === fieldWanted) return
    fieldWanted = key
    void Promise.all(wanted.map(replayOf)).then((found) => {
      if (key !== fieldWanted) return
      const runs = found.filter((one): one is RunReplay => one !== undefined)
      fieldRuns = runs.map((one) => one.runId)
      options.raceField?.(runs.map((one) => ({ key: one.runId, name: one.name, replay: one.replay })))
      changed()
    })
  }

  // ── the board ──────────────────────────────────────────────────────────

  /** The board of the track in `by`: an empty one when there is none yet, undefined when it cannot be had. */
  const readBoard = async (by: BoardOrder): Promise<Board | undefined> => {
    const got = await run(ask(timeoutMs, (lb) => lb.board(track, identity, by)))
    if (got === undefined) return undefined
    reached(got)
    if (Result.isSuccess(got)) return got.success
    return got.failure._tag === "NotFound" ? { track, rules, total: 0, top: [], around: [], me: null } : undefined
  }

  /** Reads the board by lap, and by the sector it is shown by. */
  const refreshBoard = (): void => {
    if (!enabled) return
    boardLoading = true
    changed()
    const asked = order
    void Promise.all([readBoard(null), asked === null ? Promise.resolve(undefined) : readBoard(asked)]).then(([byLap, bySector]) => {
      boardLoading = false
      if (byLap !== undefined) board = byLap
      if (asked !== null && bySector !== undefined) sectorBoard = { order: asked, board: bySector }
      changed()
    })
  }

  // ── sending ────────────────────────────────────────────────────────────

  let sending: Promise<void> = Promise.resolve()

  /** Sends what waits in the outbox of `trackId`; `attempt` is the lap the answer belongs to, if it is this track's latest. */
  const sendWaiting = (trackId: string, attempt: number | null): Promise<void> => {
    const send = async (): Promise<void> => {
      const waiting = await run(Outbox.use((outbox) => outbox.get(trackId, rules)))
      if (waiting === undefined || waiting === null) return
      const mine = trackId === track && attempt !== null
      const show = (state: PostState): void => {
        if (mine && attempt !== null) post = { attempt, state }
        changed()
      }
      const who = identity
      // While a name is being made up the lap is on its way; it is sent as soon as the name is.
      if (who === null) return naming ? undefined : show({ kind: "unlisted" })
      show({ kind: "sending" })
      const got = await run(ask(timeoutMs, (lb) => lb.submit(who, waiting.replay)))
      if (got === undefined) return show({ kind: "waiting" })
      reached(got)
      if (Result.isSuccess(got)) {
        await run(Outbox.use((outbox) => outbox.clear(trackId, rules, waiting.replay)))
        if (trackId === track) submitted = got.success
        return show({ kind: "sent", rank: got.success.rank, total: got.success.total })
      }
      switch (got.failure._tag) {
        case "RunRefused":
          // The server cannot file it, now or later.
          console.warn("the leaderboard refused the run", got.failure.fault)
          await run(Outbox.use((outbox) => outbox.clear(trackId, rules, waiting.replay)))
          return show({ kind: "refused" })
        case "Unauthorised":
          // The server no longer knows this device: it must pick a name again. The run waits.
          identity = null
          await run(Profile.use((profile) => profile.setIdentity(null)))
          namePrompts++
          return show({ kind: "unlisted" })
        default:
          return show({ kind: "waiting" })
      }
    }
    // One send at a time, in order: a run is never sent twice at once.
    sending = sending.then(send, send)
    return sending
  }

  const sendAll = (attempt: number | null): Promise<void> =>
    options.tracks.reduce<Promise<void>>((before, trackId) => before.then(() => sendWaiting(trackId, trackId === track ? attempt : null)), Promise.resolve())

  /** After the player has a name, or a run was sent: everything they see may have moved. */
  const afterSend = (): void => {
    refreshBoard()
    if (choice.kind === "next") resolveGhost()
  }

  // ── names ──────────────────────────────────────────────────────────────

  const named = (next: Identity): void => {
    identity = next
    asked = true
    void run(Profile.use((profile) => profile.setIdentity(next)))
    changed()
    void sendAll(laps.lastFinish()?.attempt ?? null).then(afterSend)
  }

  /**
   * Registers a new player under a made-up name, drawing again when one is taken. When the
   * server cannot be reached nothing is kept: the next finish tries again.
   */
  const giveName = async (): Promise<void> => {
    if (naming || identity !== null) return
    naming = true
    let given: Identity | null = null
    for (let tries = 0; tries < 5 && given === null; tries++) {
      const handle = (options.handle ?? makeHandle)()
      const got = await run(ask(timeoutMs, (lb) => lb.register(handle)))
      if (got === undefined) break
      reached(got)
      if (Result.isSuccess(got)) given = got.success
      else if (got.failure._tag !== "NameTaken" && got.failure._tag !== "NameRefused") break
    }
    naming = false
    // The player may have typed a name of their own meanwhile: theirs stands.
    if (identity !== null) return
    if (given !== null) named(given)
    else void sendAll(laps.lastFinish()?.attempt ?? null)
  }

  const saveName = async (name: string): Promise<NameAnswer> => {
    if (!enabled) return { kind: "unavailable" }
    const tidy = tidyName(name)
    const who = identity
    const got = await run(ask(timeoutMs, (lb) => (who === null ? lb.register(tidy) : lb.rename(who, tidy))))
    if (got === undefined) return { kind: "unavailable" }
    reached(got)
    if (Result.isSuccess(got)) {
      named(got.success)
      return { kind: "ok" }
    }
    if (got.failure._tag === "Unauthorised") {
      // The server forgot this device: register the name afresh.
      identity = null
      return saveName(tidy)
    }
    return nameAnswer(got.failure)
  }

  return {
    state() {
      if (snapshot !== null) return snapshot
      const me = board?.me ?? null
      const rank = submitted !== null ? { rank: submitted.rank, total: submitted.total } : me !== null && board !== null ? { rank: me.rank, total: board.total } : null
      const raced = racedNow()
      snapshot = { enabled, reachable, identity, board, order, shown: shownBoard(), boardLoading, post, rank, choice, raced, legs, picked, fieldRuns, ghostLoading, namePrompts }
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      showLocal()
      if (!enabled) return
      refreshBoard()
      resolveGhost()
      // A lap driven while the server could not be reached still wants a name.
      if (identity === null && !asked && laps.best() !== null) void giveName()
      void sendAll(null).then(() => {
        if (submitted !== null) afterSend()
      })
    },
    finished(result) {
      const best = laps.best()
      if (result.improved && best !== null) {
        void run(Bests.use((bests) => bests.set(track, rules, best)))
        // The new best is the ghost when the player races their own (or nobody is ahead).
        if (!enabled || choice.kind === "own" || (choice.kind === "next" && !stillAhead(rivalRun)) || (choice.kind === "fastest" && rivalRun === null)) {
          defer(() => {
            if (choice.kind !== "none") ghost.set(ownGhost())
          })
        }
      }
      if (!enabled) return
      if (identity === null && !asked) void giveName()
      const put = result.improved && best !== null ? run(Outbox.use((outbox) => outbox.put(track, rules, { version: 1, replay: best.replay, timeMs: best.timeMs }))) : Promise.resolve()
      if (result.improved) {
        post = { attempt: result.attempt, state: identity === null && !naming ? { kind: "unlisted" } : { kind: "sending" } }
        changed()
      }
      void put
        .then(() => sendAll(result.improved ? result.attempt : null))
        .then(() => {
          if (result.improved) afterSend()
        })
    },
    refreshBoard,
    async page(from, count, by) {
      if (!enabled) return null
      const got = await run(ask(timeoutMs, (lb) => lb.page(track, from, count, identity, by)))
      if (got === undefined) return null
      reached(got)
      if (Result.isSuccess(got)) return got.success
      return got.failure._tag === "NotFound" ? { track, rules, total: 0, from, entries: [] } : null
    },
    async replay(runId) {
      if (!enabled) return null
      if (rivalRun !== null && rivalRun.runId === runId) return rivalRun
      const got = await run(ask(timeoutMs, (lb) => lb.replay(runId)))
      if (got === undefined) return null
      reached(got)
      return Result.isSuccess(got) ? got.success : null
    },
    toggle(entry) {
      const { runId } = entry
      const raced = (entry.mine && choice.kind === "own") || racedNow().includes(runId)
      if (raced || picked.includes(runId)) {
        picked = picked.filter((one) => one !== runId)
        if (!raced) {
          keepRival()
          return changed()
        }
        choice = { kind: "none" }
        keepRival()
        return resolveGhost()
      }
      picked = [...picked, runId].slice(-maxPicked)
      keepRival()
      changed()
    },
    clearPicked() {
      picked = []
      keepRival()
      changed()
    },
    setLeg(sector, runId) {
      if (!Number.isInteger(sector) || sector < 0 || sector >= sectors) return
      const runs = Array.from({ length: sectors }, (_, i) => (choice.kind === "sectors" ? choice.runs[i] ?? null : null))
      runs[sector] = runId
      choice = { kind: "sectors", runs }
      keepRival()
      resolveGhost()
    },
    choose(next) {
      choice = next
      picked = []
      keepRival()
      resolveGhost()
    },
    setOrder(next) {
      const valid = validOrder(next)
      if (valid === order) return
      order = valid
      keepRival()
      // The fastest ghost is the fastest in the order shown.
      if (choice.kind === "fastest") resolveGhost()
      if (enabled) refreshBoard()
      else changed()
    },
    async checkName(name) {
      if (!enabled) return { kind: "unavailable" }
      const got = await run(ask(timeoutMs, (lb) => lb.checkName(tidyName(name))))
      if (got === undefined) return { kind: "unavailable" }
      reached(got)
      return Result.isSuccess(got) ? { kind: "ok" } : nameAnswer(got.failure)
    },
    saveName,
    skipName() {
      asked = true
      void run(Profile.use((profile) => profile.markAsked))
      changed()
    }
  }
}
