/**
 * The leaderboard, as the page lives with it: the player's name, sending a best lap, the
 * board of the track being driven, and which ghost to race.
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
import { type Board, type Entry, type Identity, Leaderboard, type LeaderboardShape, type NameRefused, type RunReplay, type Submitted, type Unavailable } from "../api/contract.ts"
import { tidyName } from "../api/names.ts"
import { Bests, type GhostChoice, Outbox, Rivals, type SavedRival } from "./boards.ts"
import { ghostFromReplay, type Ghost, type LapGhost } from "./ghost.ts"
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
  readonly board: Board | null
  readonly boardLoading: boolean
  /** What became of the last best lap, and the attempt it was driven in. */
  readonly post: { readonly attempt: number; readonly state: PostState } | null
  /** The player's place on this board, from the last board or the last run sent. */
  readonly rank: { readonly rank: number; readonly total: number } | null
  readonly choice: GhostChoice
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
  choose(choice: GhostChoice): void
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
  /** Every track id, to send what waits on each. */
  readonly tracks: ReadonlyArray<string>
  /** Defers work that would cost a frame (driving a replay again) out of the current tick. */
  readonly defer?: (work: () => void) => void
  /** How long a request may take before it counts as unavailable. */
  readonly timeoutMs?: number
}

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
  let boardLoading = false
  let post: OnlineState["post"] = null
  let submitted: Submitted | null = null
  let choice: GhostChoice = options.rival.choice
  /** The last rival's run, kept for offline. */
  let rivalRun: RunReplay | null = options.rival.run
  let ghostLoading = false
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
    void run(Rivals.use((rivals) => rivals.set(track, rules, { version: 1, choice, run: rivalRun })))
  }

  /** Shows the ghost the device can show without asking anyone. */
  const showLocal = (): void => {
    if (choice.kind === "none") ghost.set(null)
    else if (choice.kind === "own" || !enabled) ghost.set(ownGhost())
    else if (choice.kind === "run") ghost.set(rivalRun !== null && rivalRun.runId === choice.runId ? rivalGhost(rivalRun) ?? ownGhost() : ownGhost())
    else ghost.set(stillAhead(rivalRun) ? rivalGhost(rivalRun) ?? ownGhost() : ownGhost())
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
    if (rivalRun !== null && rivalRun.runId === runId) return race(request, rivalRun)
    const got = await run(ask(timeoutMs, (lb) => lb.replay(runId)))
    if (request !== ghostRequest) return
    if (got !== undefined) reached(got)
    if (got !== undefined && Result.isSuccess(got)) return race(request, got.success)
    // Gone or unreachable: the device's own best stands in.
    ghostLoading = false
    defer(() => {
      if (request === ghostRequest) ghost.set(ownGhost())
    })
    changed()
  }

  /** Finds the ghost the choice asks for, asking the server when it must. */
  const resolveGhost = (): void => {
    const request = ++ghostRequest
    defer(() => {
      if (request === ghostRequest) showLocal()
    })
    if (!enabled || choice.kind === "none" || choice.kind === "own") {
      ghostLoading = false
      changed()
      return
    }
    ghostLoading = true
    changed()
    if (choice.kind === "run") {
      void fetchRun(request, choice.runId)
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
      if (entry === null) {
        // Nobody is ahead: the player's own best is the one to beat.
        rivalRun = null
        keepRival()
        ghostLoading = false
        defer(() => {
          if (request === ghostRequest) ghost.set(ownGhost())
        })
        changed()
        return
      }
      void fetchRun(request, entry.runId)
    })
  }

  // ── the board ──────────────────────────────────────────────────────────

  const refreshBoard = (): void => {
    if (!enabled) return
    boardLoading = true
    changed()
    void run(ask(timeoutMs, (lb) => lb.board(track, identity))).then((got) => {
      boardLoading = false
      if (got !== undefined) {
        reached(got)
        if (Result.isSuccess(got)) board = got.success
        else if (got.failure._tag === "NotFound") board = { track, rules, total: 0, top: [], around: [], me: null }
      }
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
      snapshot = { enabled, reachable, identity, board, boardLoading, post, rank, choice, ghostLoading, namePrompts }
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
        if (!enabled || choice.kind === "own" || (choice.kind === "next" && !stillAhead(rivalRun))) {
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
    choose(next) {
      choice = next
      keepRival()
      resolveGhost()
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
