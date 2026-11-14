/**
 * A lap as its inputs.
 *
 * The simulation is deterministic, so the input of every tick of one attempt, from the
 * standing start to the finish line, is the whole lap: played into a fresh race on the same
 * track under the same rules it gives the same car, the same props and the same time, to the
 * millisecond. A replay is what the game keeps as a best lap, what it sends to the
 * leaderboard, what the server drives again to trust a time, and what a ghost is made of.
 *
 * For that to hold the simulation must receive exactly what is recorded, so an input is
 * first rounded to bytes (`pack`) and the simulation is given the rounded input back
 * (`unpack`). `quantise` is both, and the page passes every input through it.
 *
 * The bytes of a replay:
 * - `TGP`, the format version (1), the steering (0 car, 1 screen), the rules version (2
 *   bytes), the number of ticks (4 bytes), the track id's length and its characters;
 * - then runs: a count (2 bytes) and one packed input (4 bytes) held for that many ticks.
 * Numbers are little-endian.
 */
import { Ops } from "@typeonce/ritmo"
import type { Steering } from "./schema.ts"
import { createSession } from "./session.ts"
import { trackById } from "./track/index.ts"
import type { DriveInput } from "./types.ts"
import { rulesVersion } from "./version.ts"

export type { Steering }

/** The longest attempt a replay may hold, in ticks (three minutes): anything longer is not kept. */
export const maxReplayTicks = 3 * 60 * 120

/** Directions the pointed steering tells apart: 1.5 degrees each, so the eight keyboard directions are exact. */
const aimSteps = 240
const noAim = 255

/** One tick's input as four bytes: throttle, brake, steer and aim. */
export type PackedInput = readonly [throttle: number, brake: number, steer: number, aim: number]

const clamp01 = (value: number): number => (value > 0 ? (value < 1 ? value : 1) : 0)

export const pack = (input: DriveInput): PackedInput => {
  const steer = input.steer > 1 ? 1 : input.steer < -1 ? -1 : input.steer
  let aim = noAim
  if (input.aim !== null && (input.aim.x !== 0 || input.aim.z !== 0)) {
    const turns = Ops.atan2(input.aim.x, input.aim.z) / (2 * Math.PI)
    aim = ((Math.round(turns * aimSteps) % aimSteps) + aimSteps) % aimSteps
  }
  return [Math.round(clamp01(input.throttle) * 255), Math.round(clamp01(input.brake) * 255), Math.round(steer * 127) + 127, aim]
}

export const unpack = (packed: PackedInput): DriveInput => {
  const angle = (packed[3] / aimSteps) * 2 * Math.PI
  return {
    throttle: packed[0] / 255,
    brake: packed[1] / 255,
    steer: (packed[2] - 127) / 127,
    aim: packed[3] === noAim ? null : { x: Ops.sin(angle), z: Ops.cos(angle) },
    restart: false
  }
}

/**
 * The input the simulation is given for what the player asked: the same, rounded to what a
 * replay can hold. `restart` passes through; it is never part of a replay, because a restart
 * ends the attempt.
 */
export const quantise = (input: DriveInput): DriveInput => ({ ...unpack(pack(input)), restart: input.restart })

/** A replay, read. */
export interface Replay {
  readonly track: string
  readonly rules: number
  readonly steering: Steering
  /** One packed input per tick, flat: four bytes each. */
  readonly inputs: Uint8Array
}

const magic = [0x54, 0x47, 0x50] as const
const formatVersion = 1

export const encodeReplay = (replay: Replay): Uint8Array => {
  const ticks = replay.inputs.length / 4
  const runs: Array<number> = []
  let count = 0
  for (let tick = 0; tick < ticks; tick++) {
    const at = tick * 4
    const same =
      tick > 0 &&
      replay.inputs[at] === replay.inputs[at - 4] &&
      replay.inputs[at + 1] === replay.inputs[at - 3] &&
      replay.inputs[at + 2] === replay.inputs[at - 2] &&
      replay.inputs[at + 3] === replay.inputs[at - 1]
    if (same && count < 0xffff) {
      count++
      continue
    }
    if (count > 0) runs.push(count & 0xff, count >> 8, ...replay.inputs.subarray(at - 4, at))
    count = 1
  }
  if (count > 0) runs.push(count & 0xff, count >> 8, ...replay.inputs.subarray(ticks * 4 - 4, ticks * 4))
  const id = Array.from(replay.track, (character) => character.charCodeAt(0) & 0x7f)
  return Uint8Array.from([
    ...magic,
    formatVersion,
    replay.steering === "screen" ? 1 : 0,
    replay.rules & 0xff,
    (replay.rules >> 8) & 0xff,
    ticks & 0xff,
    (ticks >> 8) & 0xff,
    (ticks >> 16) & 0xff,
    (ticks >>> 24) & 0xff,
    id.length,
    ...id,
    ...runs
  ])
}

/** The replay in `bytes`, or null when they are not one (or hold more than `maxReplayTicks`). */
export const decodeReplay = (bytes: Uint8Array): Replay | null => {
  if (bytes.length < 12 || bytes[0] !== magic[0] || bytes[1] !== magic[1] || bytes[2] !== magic[2] || bytes[3] !== formatVersion) return null
  const steering = bytes[4] === 0 ? "car" : bytes[4] === 1 ? "screen" : null
  if (steering === null) return null
  const rules = (bytes[5] ?? 0) | ((bytes[6] ?? 0) << 8)
  const ticks = ((bytes[7] ?? 0) | ((bytes[8] ?? 0) << 8) | ((bytes[9] ?? 0) << 16) | ((bytes[10] ?? 0) << 24)) >>> 0
  const idLength = bytes[11] ?? 0
  if (ticks === 0 || ticks > maxReplayTicks || idLength === 0 || bytes.length < 12 + idLength) return null
  const track = String.fromCharCode(...bytes.subarray(12, 12 + idLength))
  const inputs = new Uint8Array(ticks * 4)
  let tick = 0
  let at = 12 + idLength
  if ((bytes.length - at) % 6 !== 0) return null
  while (at < bytes.length) {
    const count = (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
    if (count === 0 || tick + count > ticks) return null
    for (let i = 0; i < count; i++) inputs.set(bytes.subarray(at + 2, at + 6), (tick + i) * 4)
    tick += count
    at += 6
  }
  return tick === ticks ? { track, rules, steering, inputs } : null
}

/** A replay as text, for JSON: base64 with `-` and `_`, no padding. */
export const replayToText = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** The bytes of a replay written by `replayToText`, or null when the text is not base64. */
export const replayFromText = (text: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"))
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

/** Collects one attempt's inputs as it is driven. */
export interface Recorder {
  /** Forget the attempt: call when it starts again. */
  clear(): void
  /**
   * After each tick, with the input the simulation was given (already through `quantise`)
   * and whether the clock has started. Ticks spent waiting on the line with nothing
   * pressed are not kept: they change nothing.
   */
  push(input: DriveInput, started: boolean): void
  /** The attempt so far as a replay's bytes, or null when it is empty or grew past `maxReplayTicks`. */
  take(track: string, steering: Steering): Uint8Array | null
}

export const createRecorder = (): Recorder => {
  let bytes: Array<number> = []
  let overflow = false
  return {
    clear() {
      bytes = []
      overflow = false
    },
    push(input, started) {
      const packed = pack(input)
      const idle = packed[0] === 0 && packed[1] === 0 && packed[2] === 127 && packed[3] === noAim
      if (bytes.length === 0 && !started && idle) return
      if (bytes.length >= maxReplayTicks * 4) {
        overflow = true
        return
      }
      bytes.push(packed[0], packed[1], packed[2], packed[3])
    },
    take(track, steering) {
      if (overflow || bytes.length === 0) return null
      return encodeReplay({ track, rules: rulesVersion, steering, inputs: Uint8Array.from(bytes) })
    }
  }
}

/** Why a replay is not a lap. */
export type ReplayFault =
  /** The bytes are not a replay. */
  | "unreadable"
  /** It names a track this build does not have. */
  | "unknown-track"
  /** It was driven under other rules than this build's. */
  | "other-rules"
  /** Driven again, the attempt reset (off the road) before the finish. */
  | "reset"
  /** Driven again, it never crosses the finish line, or goes on after crossing it. */
  | "unfinished"

/** A replay driven again. */
export type ReplayRun =
  | { readonly ok: false; readonly fault: ReplayFault }
  | {
      readonly ok: true
      readonly track: string
      readonly rules: number
      readonly steering: Steering
      readonly ticks: number
      readonly timeMs: number
      readonly splitsMs: ReadonlyArray<number>
      /**
       * The car through the lap, for a ghost: one pose every `ghostEveryTicks` ticks from
       * the moment the clock starts, flat, `ghostStride` numbers each: elapsed ms, x, y, z,
       * yaw, pitch, roll. The last pose is the finish.
       */
      readonly poses: ReadonlyArray<number>
    }

export const ghostEveryTicks = 4
export const ghostStride = 7

/**
 * Drives a replay again from the standing start and says what lap it is. This is the only
 * way a time is trusted: the time comes from the simulation, never from whoever sent the
 * replay. `ghost: false` skips the poses, for a server that only wants the time.
 */
export const runReplay = (bytes: Uint8Array, options: { readonly ghost?: boolean } = {}): ReplayRun => {
  const replay = decodeReplay(bytes)
  if (replay === null) return { ok: false, fault: "unreadable" }
  const entry = trackById(replay.track)
  if (entry === undefined) return { ok: false, fault: "unknown-track" }
  if (replay.rules !== rulesVersion) return { ok: false, fault: "other-rules" }
  const session = createSession(entry.data, replay.steering)
  const ghost = options.ghost ?? true
  const ticks = replay.inputs.length / 4
  const poses: Array<number> = []
  const keep = (timeMs: number): void => {
    const { car } = session.view()
    poses.push(timeMs, car.x, car.y, car.z, car.yaw, car.pitch, car.roll)
  }
  /** Ticks since the clock started, or -1 before it has. */
  let running = -1
  for (let tick = 0; tick < ticks; tick++) {
    const at = tick * 4
    session.tick(unpack([replay.inputs[at] ?? 0, replay.inputs[at + 1] ?? 0, replay.inputs[at + 2] ?? 127, replay.inputs[at + 3] ?? noAim]))
    for (const event of session.drainEvents()) {
      if (event.kind === "reset") return { ok: false, fault: "reset" }
      if (event.kind === "start") running = 0
      if (event.kind !== "finish") continue
      if (tick !== ticks - 1) return { ok: false, fault: "unfinished" }
      if (ghost) keep(event.timeMs)
      return { ok: true, track: replay.track, rules: replay.rules, steering: replay.steering, ticks, timeMs: event.timeMs, splitsMs: event.splitsMs, poses }
    }
    if (running < 0) continue
    // The clock covers the tick it started in, so the first pose is one tick in.
    running++
    if (ghost && (running - 1) % ghostEveryTicks === 0) keep((running * 1000) / session.hz)
  }
  return { ok: false, fault: "unfinished" }
}
