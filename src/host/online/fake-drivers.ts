/**
 * The made-up players of the stand-in leaderboard (`?server=fake`), and how their laps are
 * driven: the simulation's bot with a few small habits of its own (lifting off the gas here
 * and there, a hand that wanders on the wheel), so the times spread out. Every lap is a real
 * replay, recorded the way the page records one.
 *
 * `scripts/fake-board.ts` drives them once and writes `fake-runs.json`; the stand-in reads
 * that. Driving them in the page would cost a second of frames.
 */
import { botInput, createRecorder, createSession, quantise, replayToText, type Steering, type TrackEntry } from "../../sim/index.ts"

export interface FakeDriver {
  readonly name: string
  readonly steering: Steering
  /** Share of the gas lifted where the driver hesitates, 0 to 1. */
  readonly lift: number
  /** How far the wheel wanders, as a share of full lock. */
  readonly wobble: number
  readonly seed: number
}

export const fakeDrivers: ReadonlyArray<FakeDriver> = [
  { name: "Pebble", steering: "screen", lift: 0, wobble: 0, seed: 0 },
  { name: "kaz_drift", steering: "screen", lift: 0.05, wobble: 0.1, seed: 15 },
  { name: "Mira.K", steering: "car", lift: 0, wobble: 0.15, seed: 22 },
  { name: "tinfoil", steering: "car", lift: 0.1, wobble: 0.2, seed: 11 },
  { name: "Otto 77", steering: "car", lift: 0.2, wobble: 0.2, seed: 23 },
  { name: "lunebox", steering: "screen", lift: 0.3, wobble: 0.1, seed: 4 },
  { name: "Breaker-9", steering: "car", lift: 0.35, wobble: 0.3, seed: 17 },
  { name: "sunny side", steering: "car", lift: 0.45, wobble: 0.3, seed: 13 },
  { name: "Wren", steering: "car", lift: 0.55, wobble: 0.35, seed: 7 },
  { name: "gravelpit", steering: "car", lift: 0.62, wobble: 0.4, seed: 10 },
  { name: "Odd.Socks", steering: "screen", lift: 0.7, wobble: 0.2, seed: 2 },
  { name: "Vee", steering: "car", lift: 0.78, wobble: 0.45, seed: 19 },
  { name: "slowpoke_jo", steering: "car", lift: 0.85, wobble: 0.7, seed: 8 },
  { name: "Brakes On", steering: "car", lift: 0.95, wobble: 0.5, seed: 8 },
  { name: "tumbleweed", steering: "car", lift: 0.95, wobble: 0.9, seed: 8 }
]

/** One lap by `driver` on `entry`: its time and replay, or null when the driver went off the road. */
export const driveFake = (entry: TrackEntry, driver: FakeDriver): { readonly timeMs: number; readonly replay: string } | null => {
  const session = createSession(entry.data, driver.steering)
  const recorder = createRecorder()
  const frequency = 0.02 + (driver.seed % 5) * 0.01
  for (let tick = 0; tick < 120 * 120; tick++) {
    const view = session.view()
    const base = botInput(view, entry.data)
    const hesitating = Math.sin(view.car.s * 0.05 + driver.seed) > 0.2 ? driver.lift : 0
    const steer = Math.max(-1, Math.min(1, base.steer + driver.wobble * Math.sin(tick * frequency + driver.seed)))
    const input = quantise({ ...base, throttle: base.throttle * (1 - hesitating), steer })
    session.tick(input)
    recorder.push(input, session.view().lap.phase !== "ready")
    for (const event of session.drainEvents()) {
      if (event.kind === "reset") return null
      if (event.kind !== "finish") continue
      const bytes = recorder.take(entry.id, driver.steering)
      return bytes === null ? null : { timeMs: event.timeMs, replay: replayToText(bytes) }
    }
  }
  return null
}
