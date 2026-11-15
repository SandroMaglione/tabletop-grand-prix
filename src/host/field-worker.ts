/**
 * Drives laps for the field (`field.ts`) off the page's thread, so the race never waits for
 * them: a run's replay from the board, or (in dev, for the crowd) bot laps made up here.
 * Posts each lap's poses as it finishes it, then `done`.
 */
import { trackById } from "../sim/index.ts"
import { ghostFromReplay } from "./ghost.ts"
import { driveFake } from "./online/fake-drivers.ts"

export type FieldAsk =
  | { readonly kind: "replays"; readonly runs: ReadonlyArray<{ readonly key: string; readonly replay: string }> }
  | { readonly kind: "bots"; readonly track: string; readonly count: number; readonly seed: number }

export type FieldReply =
  | { readonly kind: "lap"; readonly key: string; readonly timeMs: number; readonly poses: Float64Array }
  | { readonly kind: "done" }

const post = (key: string, timeMs: number, poses: ReadonlyArray<number>): void => {
  const flat = Float64Array.from(poses)
  self.postMessage({ kind: "lap", key, timeMs, poses: flat } satisfies FieldReply, { transfer: [flat.buffer] })
}

/** A small seeded random (mulberry32), so the same crowd comes back for the same seed. */
const random = (seed: number) => {
  let a = seed >>> 0
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

self.onmessage = (message: MessageEvent<FieldAsk>) => {
  const ask = message.data
  if (ask.kind === "replays") {
    for (const run of ask.runs) {
      const lap = ghostFromReplay(run.replay, { kind: "rival", name: "", runId: null })
      if (lap !== null) post(run.key, lap.timeMs, lap.poses)
    }
  } else {
    const entry = trackById(ask.track)
    const rand = random(ask.seed)
    let made = 0
    for (let tries = 0; entry !== undefined && made < ask.count && tries < ask.count * 4; tries++) {
      const driver = { name: "bot", steering: "car" as const, lift: rand() * 0.9, wobble: rand() * 0.5, seed: Math.floor(rand() * 1000) }
      const run = driveFake(entry, driver)
      const lap = run === null ? null : ghostFromReplay(run.replay, { kind: "rival", name: "", runId: null })
      if (lap === null) continue
      post(`bot:${ask.seed}:${made++}`, lap.timeMs, lap.poses)
    }
  }
  self.postMessage({ kind: "done" } satisfies FieldReply)
}
