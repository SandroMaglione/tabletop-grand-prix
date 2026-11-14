/**
 * Drives the stand-in leaderboard's made-up players (`src/host/online/fake-drivers.ts`) on
 * every track and writes their laps to `src/host/online/fake-runs.json`. Run it again when
 * the rules version changes: the stand-in shows an empty board for laps from other rules.
 *
 *   node scripts/fake-board.ts
 */
import { writeFileSync } from "node:fs"
import { driveFake, fakeDrivers } from "../src/host/online/fake-drivers.ts"
import { rulesVersion, tracks } from "../src/sim/index.ts"

const runs: Record<string, Array<{ name: string; steering: string; timeMs: number; replay: string }>> = {}
for (const entry of tracks) {
  const list: Array<{ name: string; steering: string; timeMs: number; replay: string }> = []
  for (const driver of fakeDrivers) {
    const lap = driveFake(entry, driver)
    if (lap === null) {
      console.log(`${entry.id}: ${driver.name} went off the road`)
      continue
    }
    list.push({ name: driver.name, steering: driver.steering, timeMs: lap.timeMs, replay: lap.replay })
    console.log(`${entry.id}: ${driver.name.padEnd(12)} ${(lap.timeMs / 1000).toFixed(3)} s  ${lap.replay.length} chars`)
  }
  runs[entry.id] = list
}
const out = new URL("../src/host/online/fake-runs.json", import.meta.url)
writeFileSync(out, `${JSON.stringify({ rules: rulesVersion, runs })}\n`)
console.log(`wrote ${out.pathname}`)
