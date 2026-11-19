/**
 * The field: more ghosts beside the raced one, each in its own tint (`tints.ts`). In the game
 * they are runs from the board (`online.ts` picks them: the ones just ahead of the player);
 * in dev, `?ghosts=100` makes a crowd of bot laps instead, to see how many the page can draw.
 *
 * Their laps are driven in a worker (`field-worker.ts`), off the page's thread. Like the raced
 * ghost, a new field waits for the lap that runs to end, and a ghost whose lap arrives while
 * one runs joins from the next. The crowd joins at once, as its laps come in.
 *
 * Drawn like the raced ghost, fainter, every one at its own lap's pose on the race clock, and
 * faded near the car and once its lap is over (`ghostFade`).
 */
import { Container3D } from "@pixi/3d"
import type { RaceView } from "../sim/index.ts"
import { buildCar, ghostLook, type CarLook, type CarModel } from "./actors/car.ts"
import type { GhostPose } from "./contract.ts"
import type { FieldAsk, FieldReply } from "./field-worker.ts"
import { ghostFade, poseAt } from "./ghost.ts"
import { fieldTint } from "./tints.ts"

/** How see-through a ghost of the field is when nothing fades it (the raced one is 0.38). */
const FIELD_ALPHA = 0.3

/** A run of the board to race, as `online.ts` gives it. */
export interface FieldRun {
  /** The run id. */
  readonly key: string
  readonly name: string
  readonly replay: string
}

/** A ghost of the field on screen this frame, for the marks of passing it (`passes.ts`). */
export interface FieldGhost {
  readonly key: string
  /** A run of the board: its passing is marked (a crowd's bot lap is not). */
  readonly marked: boolean
  readonly color: number
  readonly pose: GhostPose | null
}

export interface Field {
  /** Race these runs, in this order (it sets their tints), from the next lap on. */
  set(runs: ReadonlyArray<FieldRun>): void
  /**
   * Once per drawn frame, with the view drawn and whether a lap of the player's runs. With
   * `drawn` false (a run of the board is watched) no ghost is drawn.
   */
  update(view: RaceView, racing: boolean, drawn?: boolean): void
  /** The ghosts drawn this frame. */
  ghosts(): ReadonlyArray<FieldGhost>
  /** Laps ready to race, of those asked for. */
  ready(): number
  wanted(): number
  /** For scripts (the trailer): how much of the field to draw, 0 (none) to 1 (all), the first ghosts first. */
  show(amount: number): void
}

interface Lap {
  readonly timeMs: number
  readonly poses: ArrayLike<number>
}

interface Slot {
  readonly model: CarModel
  readonly look: CarLook
}

export const createField = (parent: Container3D, options: { readonly crowd?: { readonly track: string; readonly count: number } } = {}): Field => {
  const layer = new Container3D({ label: "field", parent })
  const laps = new Map<string, Lap>()
  /** The field raced now, and the one waiting for the lap to end. */
  let racing: ReadonlyArray<FieldRun> = []
  let waiting: ReadonlyArray<FieldRun> | null = null
  /** Keys that may be drawn: their lap was known when no lap ran (or, for the crowd, at once). */
  const joined = new Set<string>()
  const slots: Array<Slot> = []
  let shown: Array<FieldGhost> = []
  let running = false
  let amount = 1

  const slot = (index: number): Slot => {
    const known = slots[index]
    if (known !== undefined) return known
    const look = ghostLook(fieldTint(index), FIELD_ALPHA)
    const model = buildCar(look, true)
    model.root.visible = false
    layer.addChild(model.root)
    const made = { model, look }
    slots[index] = made
    return made
  }

  const listen = (worker: Worker, onDone: () => void): void => {
    worker.onmessage = (message: MessageEvent<FieldReply>) => {
      const reply = message.data
      if (reply.kind === "done") return onDone()
      laps.set(reply.key, { timeMs: reply.timeMs, poses: reply.poses })
      if (options.crowd !== undefined) joined.add(reply.key)
    }
  }

  // One worker drives the board's runs, made when first needed and kept.
  let replays: Worker | null = null
  const drive = (runs: ReadonlyArray<FieldRun>): void => {
    const missing = runs.filter((run) => !laps.has(run.key))
    if (missing.length === 0) return
    if (replays === null) {
      replays = new Worker(new URL("./field-worker.ts", import.meta.url), { type: "module" })
      listen(replays, () => undefined)
    }
    replays.postMessage({ kind: "replays", runs: missing.map(({ key, replay }) => ({ key, replay })) } satisfies FieldAsk)
  }

  // The crowd: a few workers share the bot laps, each posting a lap as it finishes it.
  if (options.crowd !== undefined) {
    const { track, count } = options.crowd
    const workers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1, count))
    const started = performance.now()
    let finished = 0
    const crowd: Array<FieldRun> = []
    for (let w = 0; w < workers; w++) {
      const share = Math.floor(count / workers) + (w < count % workers ? 1 : 0)
      for (let i = 0; i < share; i++) crowd.push({ key: `bot:${count * 31 + w}:${i}`, name: "", replay: "" })
      const worker = new Worker(new URL("./field-worker.ts", import.meta.url), { type: "module" })
      listen(worker, () => {
        worker.terminate()
        if (++finished === workers) console.info(`field: ${laps.size} bot ghosts in ${Math.round(performance.now() - started)} ms`)
      })
      worker.postMessage({ kind: "bots", track, count: share, seed: count * 31 + w } satisfies FieldAsk)
    }
    racing = crowd
  }

  return {
    set(runs) {
      drive(runs)
      if (running) waiting = runs
      else {
        racing = runs
        waiting = null
      }
    },
    update(view, isRacing, drawn = true) {
      running = isRacing
      if (!running) {
        if (waiting !== null) {
          racing = waiting
          waiting = null
        }
        for (const run of racing) if (laps.has(run.key)) joined.add(run.key)
      }
      const timeMs = view.lap.phase === "ready" ? 0 : view.lap.timeMs
      shown = []
      for (let i = 0; i < Math.max(racing.length, slots.length); i++) {
        const run = racing[i]
        const lap = !drawn || run === undefined || !joined.has(run.key) || i >= amount * racing.length ? undefined : laps.get(run.key)
        const pose = run === undefined || lap === undefined ? null : poseAt(lap.poses, timeMs)
        if (run === undefined || lap === undefined || pose === null) {
          const idle = slots[i]
          if (idle !== undefined) idle.model.root.visible = false
          continue
        }
        const { model, look } = slot(i)
        const fade = ghostFade(pose, view.car, timeMs, lap.timeMs)
        model.root.visible = fade > 0.01
        look.body.alpha = FIELD_ALPHA * fade
        model.root.position.set(pose.x, pose.y, pose.z)
        model.root.rotation.y = pose.yaw
        model.pitch.rotation.x = -pose.pitch
        model.roll.rotation.z = pose.roll
        shown.push({ key: run.key, marked: run.name !== "", color: fieldTint(i), pose: { ...pose, fade } })
      }
    },
    ghosts: () => shown,
    ready: () => racing.filter((run) => laps.has(run.key)).length,
    wanted: () => racing.length,
    show(next) {
      amount = Math.max(0, Math.min(1, next))
    }
  }
}
