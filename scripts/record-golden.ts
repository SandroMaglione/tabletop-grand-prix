/**
 * Record the lap the rules are pinned by: the bot drives each track once, and its replay
 * and time are written to `test/replays/<track>.json`. Run it after raising `rulesVersion`
 * in `src/sim/version.ts`, never to make a failing test pass without raising it.
 *
 *   node scripts/record-golden.ts
 */
import { writeFileSync } from "node:fs"
import { botInput } from "../src/sim/bot.ts"
import { createRecorder, createSession, quantise, replayToText, rulesVersion, runReplay, tracks } from "../src/sim/index.ts"

for (const entry of tracks) {
  const session = createSession(entry.data)
  const recorder = createRecorder()
  let timeMs: number | null = null
  for (let tick = 0; tick < 120 * 120 && timeMs === null; tick++) {
    const input = quantise(botInput(session.view(), entry.data))
    session.tick(input)
    recorder.push(input, session.view().lap.phase !== "ready")
    for (const event of session.drainEvents()) if (event.kind === "finish") timeMs = event.timeMs
  }
  const bytes = recorder.take(entry.id, "car")
  if (timeMs === null || bytes === null) throw new Error(`The bot did not finish ${entry.id}`)
  const again = runReplay(bytes)
  if (!again.ok || again.timeMs !== timeMs) throw new Error(`The replay of ${entry.id} does not give the lap back`)
  writeFileSync(`test/replays/${entry.id}.json`, `${JSON.stringify({ rules: rulesVersion, track: entry.id, timeMs, replay: replayToText(bytes) }, null, 2)}\n`)
  console.log(`${entry.id}: ${(timeMs / 1000).toFixed(3)} s, ${bytes.length} bytes, rules ${rulesVersion}`)
}
