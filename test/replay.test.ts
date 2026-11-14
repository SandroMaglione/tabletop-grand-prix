/**
 * Replays: a lap as its inputs, driven again to give the same lap.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { botInput } from "../src/sim/bot.ts"
import { createRecorder, createSession, decodeReplay, quantise, replayFromText, replayToText, rulesVersion, runReplay, tracks } from "../src/sim/index.ts"
import type { DriveInput, Steering, TrackEntry } from "../src/sim/index.ts"
import { encodeReplay } from "../src/sim/replay.ts"

/** The bot drives one lap the way the page does: every input through `quantise`, every tick to the recorder. */
const drive = (entry: TrackEntry, steering: Steering, wait: number = 0): { timeMs: number; bytes: Uint8Array } => {
  const session = createSession(entry.data, steering)
  const recorder = createRecorder()
  let timeMs: number | null = null
  for (let tick = 0; tick < 120 * 120 && timeMs === null; tick++) {
    const asked: DriveInput = tick < wait ? { throttle: 0, brake: 0, steer: 0, aim: null, restart: false } : botInput(session.view(), entry.data)
    const input = quantise(asked)
    session.tick(input)
    recorder.push(input, session.view().lap.phase !== "ready")
    for (const event of session.drainEvents()) if (event.kind === "finish") timeMs = event.timeMs
  }
  const bytes = recorder.take(entry.id, steering)
  assert.ok(timeMs !== null && bytes !== null, `${entry.id}: no lap`)
  return { timeMs, bytes }
}

test("a recorded lap driven again gives the same time, on every track and with both steerings", () => {
  for (const entry of tracks) {
    for (const steering of ["car", "screen"] as const) {
      const lap = drive(entry, steering)
      const again = runReplay(lap.bytes)
      assert.ok(again.ok, `${entry.id} ${steering}: ${again.ok ? "" : again.fault}`)
      assert.equal(again.timeMs, lap.timeMs)
      assert.equal(again.steering, steering)
      assert.equal(again.track, entry.id)
      assert.equal(again.poses.length % 7, 0)
      assert.equal(again.poses[again.poses.length - 7], lap.timeMs, "the ghost does not end on the finish")
    }
  }
})

test("waiting on the line before the start is not part of the replay", () => {
  const entry = tracks[0]
  assert.ok(entry !== undefined)
  const prompt = drive(entry, "car")
  const late = drive(entry, "car", 600)
  assert.equal(late.timeMs, prompt.timeMs)
  assert.deepEqual(late.bytes, prompt.bytes)
})

test("an input rounded once does not change when rounded again", () => {
  for (const input of [
    { throttle: 0.3337, brake: 0.9, steer: -0.4242, aim: null, restart: false },
    { throttle: 1, brake: 0, steer: 1, aim: { x: 0.3, z: -0.8 }, restart: true },
    { throttle: 2, brake: -1, steer: -3, aim: { x: 0, z: 0 }, restart: false }
  ] satisfies ReadonlyArray<DriveInput>) {
    const once = quantise(input)
    assert.deepEqual(quantise(once), once)
    assert.equal(once.restart, input.restart)
  }
})

test("replay bytes survive text and are refused when damaged", () => {
  const entry = tracks[0]
  assert.ok(entry !== undefined)
  const { bytes } = drive(entry, "car")
  assert.deepEqual(replayFromText(replayToText(bytes)), bytes)
  const read = decodeReplay(bytes)
  assert.ok(read !== null)
  assert.deepEqual(encodeReplay(read), bytes)
  assert.deepEqual(runReplay(Uint8Array.from([1, 2, 3])), { ok: false, fault: "unreadable" })
  assert.deepEqual(runReplay(bytes.subarray(0, bytes.length - 6)), { ok: false, fault: "unreadable" })
  assert.deepEqual(runReplay(encodeReplay({ ...read, track: "nowhere" })), { ok: false, fault: "unknown-track" })
  assert.deepEqual(runReplay(encodeReplay({ ...read, rules: rulesVersion + 1 })), { ok: false, fault: "other-rules" })
  // Cut short it never reaches the line; with ticks after the line it is not one attempt.
  assert.deepEqual(runReplay(encodeReplay({ ...read, inputs: read.inputs.subarray(0, read.inputs.length - 400) })), { ok: false, fault: "unfinished" })
  const longer = new Uint8Array(read.inputs.length + 40)
  longer.set(read.inputs)
  assert.deepEqual(runReplay(encodeReplay({ ...read, inputs: longer })), { ok: false, fault: "unfinished" })
  assert.equal(replayFromText("not base64 !"), null)
})

test("the rules have not moved: the lap kept for each track still gives its time", () => {
  for (const entry of tracks) {
    const kept = JSON.parse(readFileSync(new URL(`./replays/${entry.id}.json`, import.meta.url), "utf8")) as { rules: number; timeMs: number; replay: string }
    assert.equal(kept.rules, rulesVersion, `${entry.id}: record the lap again for rules ${rulesVersion} (node scripts/record-golden.ts)`)
    const bytes = replayFromText(kept.replay)
    assert.ok(bytes !== null)
    const run = runReplay(bytes)
    assert.ok(run.ok && run.timeMs === kept.timeMs, `${entry.id}: the rules changed (the kept lap now gives ${run.ok ? run.timeMs : run.fault}, not ${kept.timeMs}). Raise rulesVersion in src/sim/version.ts and record the lap again.`)
  }
})
