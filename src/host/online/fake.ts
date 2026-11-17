/**
 * A stand-in leaderboard that lives in the page, for building and showing the online parts
 * without a server: open the game with `?server=fake`. It answers like the real one (the
 * contract in `src/api/contract.ts`): names are checked, a run is driven again to file its
 * own time, a board keeps each player's best.
 *
 * It starts with the made-up players of `fake-runs.json` (real replays). What the player
 * adds (their name, their runs) is kept in localStorage, so a reload finds the same board;
 * `?server=fake&fresh=1` starts it over, and `?server=fake&drivers=2000` pads the board with
 * more made-up drivers, up to that many, to see a long one (their laps borrow the fixture's
 * replays). (`?server=down` is a server that never answers: `down.ts`.)
 * Every answer comes after a short wait, like a network.
 */
import { Effect, Layer } from "effect"
import { type Board, type BoardPage, type Entry, type Identity, Leaderboard, pageMax, type NameRefused, type NameTaken, type RunRefused, type RunReplay, type Submitted, type Unauthorised } from "../../api/contract.ts"
import { nameShape, tidyName } from "../../api/names.ts"
import { replayFromText, rulesVersion, runReplay, type Steering } from "../../sim/index.ts"
import { makeHandle } from "../handles.ts"
import fixture from "./fake-runs.json" with { type: "json" }

interface Run {
  readonly runId: string
  readonly playerId: string
  readonly timeMs: number
  readonly steering: Steering
  readonly replay: string
}

interface Player {
  readonly id: string
  name: string
  readonly secret: string
}

interface Saved {
  readonly players: ReadonlyArray<Player>
  /** By board (`track/rules`). */
  readonly runs: Readonly<Record<string, ReadonlyArray<Run>>>
}

const savedKey = "tabletop-grand-prix-fake-server"
const reserved = ["admin", "moderator", "tabletop", "grand prix", "anonymous", "ghost"]
const blocked = ["badword", "rude"]
const topCount = 10
const aroundCount = 2

/** A name as compared: lower case, and the joiners read the same. */
const folded = (name: string): string => tidyName(name).toLowerCase().replace(/[ ._-]/g, "")


const randomId = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`

export interface FakeOptions {
  /** Start over instead of reading what an earlier visit kept. */
  readonly fresh?: boolean
  /** Where to keep what players add; null keeps nothing. */
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null
  /** Milliseconds each answer waits. */
  readonly latencyMs?: number
  /** Pads each board with made-up drivers up to this many. */
  readonly drivers?: number
}

/** Numbers from `seed`, the same each visit (mulberry32). */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The stand-in as a `Leaderboard` layer. */
export const layerFake = (options: FakeOptions = {}): Layer.Layer<Leaderboard> => {
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage
  const players = new Map<string, Player>()
  const boards = new Map<string, Map<string, Run>>()
  const board = (track: string, rules: number): Map<string, Run> => {
    const key = `${track}/${rules}`
    let found = boards.get(key)
    if (found === undefined) {
      found = new Map()
      boards.set(key, found)
    }
    return found
  }

  // The made-up players, when their laps were driven under these rules.
  if (fixture.rules === rulesVersion) {
    for (const [track, runs] of Object.entries(fixture.runs)) {
      for (const [i, run] of runs.entries()) {
        const id = `fake-${i}`
        players.set(id, { id, name: run.name, secret: `fake-secret-${i}` })
        board(track, rulesVersion).set(id, { runId: `${track}-fake-${i}`, playerId: id, timeMs: Math.floor(run.timeMs), steering: run.steering === "screen" ? "screen" : "car", replay: run.replay })
      }
    }
    // The padding: times from just behind the leader to twice as slow, most of them in between.
    const wanted = Math.min(10_000, Math.max(0, Math.floor(options.drivers ?? 0)))
    for (const [track, runs] of Object.entries(fixture.runs)) {
      const fastest = Math.min(...runs.map((run) => run.timeMs))
      const random = seeded(wanted)
      for (let i = runs.length; i < wanted; i++) {
        const id = `fake-pad-${i}`
        const lent = runs[i % runs.length]
        if (lent === undefined) break
        players.set(id, { id, name: makeHandle(random), secret: `fake-secret-pad-${i}` })
        const timeMs = Math.floor(fastest * (1.02 + (random() + random() + random()) / 3))
        board(track, rulesVersion).set(id, { runId: `${track}-fake-pad-${i}`, playerId: id, timeMs, steering: "car", replay: lent.replay })
      }
    }
  } else {
    console.warn(`the stand-in board's laps are from rules ${fixture.rules}, not ${rulesVersion}: run node scripts/fake-board.ts`)
  }

  // What players added on an earlier visit.
  if (options.fresh === true) storage?.removeItem(savedKey)
  try {
    const raw = storage?.getItem(savedKey)
    if (raw !== null && raw !== undefined) {
      const saved = JSON.parse(raw) as Saved
      for (const player of saved.players) players.set(player.id, { ...player })
      for (const [key, runs] of Object.entries(saved.runs)) {
        const [track = "", rules = "0"] = key.split("/")
        for (const run of runs) board(track, Number(rules)).set(run.playerId, run)
      }
    }
  } catch {
    // Nothing kept, or it cannot be read: start from the made-up players.
  }
  const persist = (): void => {
    if (storage === null || storage === undefined) return
    const own = (playerId: string): boolean => !playerId.startsWith("fake-")
    const runs: Record<string, ReadonlyArray<Run>> = {}
    for (const [key, runsOf] of boards) runs[key] = [...runsOf.values()].filter((run) => own(run.playerId))
    try {
      storage.setItem(savedKey, JSON.stringify({ players: [...players.values()].filter((player) => own(player.id)), runs } satisfies Saved))
    } catch {
      // Full or blocked: the stand-in forgets on reload.
    }
  }

  const delay = options.latencyMs ?? 250
  const answer = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> => (delay > 0 ? Effect.sleep(`${delay} millis`).pipe(Effect.andThen(effect)) : effect)

  const nameProblem = (raw: string, except: string | null): NameRefused | NameTaken | null => {
    const name = tidyName(raw)
    const shape = nameShape(name)
    if (shape !== "ok") return { _tag: "NameRefused", reason: shape }
    const key = folded(name)
    if (reserved.some((word) => folded(word) === key)) return { _tag: "NameRefused", reason: "reserved" }
    if (blocked.some((word) => key.includes(folded(word)))) return { _tag: "NameRefused", reason: "blocked" }
    for (const player of players.values()) if (player.id !== except && folded(player.name) === key) return { _tag: "NameTaken" }
    return null
  }

  const known = (identity: Identity): Player | null => {
    const player = players.get(identity.id)
    return player !== undefined && player.secret === identity.secret ? player : null
  }

  /** The runs of a board, fastest first; the earlier run first on a tie. */
  const ranked = (track: string): ReadonlyArray<Run> => [...board(track, rulesVersion).values()].sort((a, b) => a.timeMs - b.timeMs)

  const entry = (run: Run, rank: number, me: string | null): Entry => ({
    rank,
    runId: run.runId,
    name: players.get(run.playerId)?.name ?? "?",
    timeMs: run.timeMs,
    steering: run.steering,
    mine: run.playerId === me
  })

  return Layer.succeed(
    Leaderboard,
    Leaderboard.of({
      checkName: (name) =>
        answer(
          Effect.suspend(() => {
            const problem = nameProblem(name, null)
            return problem === null ? Effect.void : Effect.fail(problem)
          })
        ),
      register: (name) =>
        answer(
          Effect.suspend(() => {
            const problem = nameProblem(name, null)
            if (problem !== null) return Effect.fail(problem)
            const player: Player = { id: randomId("p"), name: tidyName(name), secret: randomId("s") }
            players.set(player.id, player)
            persist()
            return Effect.succeed({ ...player })
          })
        ),
      rename: (identity, name) =>
        answer(
          Effect.suspend((): Effect.Effect<Identity, NameRefused | NameTaken | Unauthorised> => {
            const player = known(identity)
            if (player === null) return Effect.fail({ _tag: "Unauthorised" } as const)
            const problem = nameProblem(name, player.id)
            if (problem !== null) return Effect.fail(problem)
            player.name = tidyName(name)
            persist()
            return Effect.succeed({ ...player })
          })
        ),
      submit: (identity, text) =>
        answer(
          Effect.suspend((): Effect.Effect<Submitted, RunRefused | Unauthorised> => {
            const player = known(identity)
            if (player === null) return Effect.fail({ _tag: "Unauthorised" } as const)
            const bytes = replayFromText(text)
            if (bytes === null) return Effect.fail({ _tag: "RunRefused", fault: "unreadable" } as const)
            const run = runReplay(bytes, { ghost: false })
            if (!run.ok) return Effect.fail({ _tag: "RunRefused", fault: run.fault } as const)
            const runs = board(run.track, run.rules)
            const before = runs.get(player.id)
            const timeMs = Math.floor(run.timeMs)
            const improved = before === undefined || timeMs < before.timeMs
            const kept = improved ? { runId: randomId("r"), playerId: player.id, timeMs, steering: run.steering, replay: text } : before
            if (improved) {
              runs.set(player.id, kept)
              persist()
            }
            const order = ranked(run.track)
            return Effect.succeed({ runId: kept.runId, timeMs, improved, rank: order.indexOf(kept) + 1, total: order.length })
          })
        ),
      board: (track, identity) =>
        answer(
          Effect.suspend(() => {
            const me = identity === null ? null : known(identity)?.id ?? null
            const order = ranked(track)
            const entries = order.map((run, i) => entry(run, i + 1, me))
            const mine = entries.find((one) => one.mine) ?? null
            const top = entries.slice(0, topCount)
            const around = mine === null || mine.rank <= topCount ? [] : entries.slice(Math.max(0, mine.rank - 1 - aroundCount), mine.rank + aroundCount)
            return Effect.succeed({ track, rules: rulesVersion, total: order.length, top, around, me: mine } satisfies Board)
          })
        ),
      page: (track, from, count, identity) =>
        answer(
          Effect.suspend(() => {
            const me = identity === null ? null : known(identity)?.id ?? null
            const order = ranked(track)
            const first = Math.max(1, Math.floor(from))
            const size = Math.max(1, Math.min(pageMax, Math.floor(count)))
            const entries = order.slice(first - 1, first - 1 + size).map((run, i) => entry(run, first + i, me))
            return Effect.succeed({ track, rules: rulesVersion, total: order.length, from: first, entries } satisfies BoardPage)
          })
        ),
      rival: (track, fasterThanMs, identity) =>
        answer(
          Effect.suspend(() => {
            const me = identity === null ? null : known(identity)?.id ?? null
            const entries = ranked(track).map((run, i) => entry(run, i + 1, me))
            const ahead = entries.filter((one) => !one.mine && (fasterThanMs === null || one.timeMs < fasterThanMs))
            return Effect.succeed(ahead[ahead.length - 1] ?? null)
          })
        ),
      replay: (runId) =>
        answer(
          Effect.suspend(() => {
            for (const runs of boards.values()) {
              for (const run of runs.values()) {
                if (run.runId !== runId) continue
                const found: RunReplay = { runId, name: players.get(run.playerId)?.name ?? "?", timeMs: run.timeMs, steering: run.steering, replay: run.replay }
                return Effect.succeed(found)
              }
            }
            return Effect.fail({ _tag: "NotFound" } as const)
          })
        )
    })
  )
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}
