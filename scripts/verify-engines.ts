/**
 * Drive the kept replays again in every browser engine and compare with Node.
 *
 *   node scripts/verify-engines.ts          (needs the dev server on http://localhost:5380)
 *
 * The leaderboard's server drives a replay again to trust its time, and a ghost is a
 * replay driven on the player's own device. Both only work if every engine computes the
 * same lap from the same inputs, so this checks the time and every ghost pose, bit for
 * bit, in Chromium, Firefox and WebKit against Node. Exits 1 on any difference.
 */
import { readFileSync } from "node:fs"
import { chromium, firefox, webkit } from "playwright-core"
import { replayFromText, runReplay, tracks } from "../src/sim/index.ts"

/** A lap as one line of text that differs if any number differs in any bit. */
const fingerprint = (timeMs: number, splitsMs: ReadonlyArray<number>, poses: ReadonlyArray<number>): string => {
  const view = new DataView(new ArrayBuffer(8))
  let hash = 0x811c9dc5
  for (const value of [timeMs, ...splitsMs, ...poses]) {
    view.setFloat64(0, value)
    for (let i = 0; i < 8; i++) hash = Math.imul(hash ^ view.getUint8(i), 0x01000193) >>> 0
  }
  return `${timeMs} ${poses.length / 7} poses ${hash.toString(16)}`
}

let failed = false
for (const entry of tracks) {
  const kept = JSON.parse(readFileSync(new URL(`../test/replays/${entry.id}.json`, import.meta.url), "utf8")) as { replay: string }
  const bytes = replayFromText(kept.replay)
  if (bytes === null) throw new Error(`${entry.id}: the kept replay is not text`)
  const here = runReplay(bytes)
  if (!here.ok) throw new Error(`${entry.id}: Node cannot drive the kept replay (${here.fault})`)
  const expected = fingerprint(here.timeMs, here.splitsMs, here.poses)
  console.log(`${entry.id}  node      ${expected}`)
  for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]] as const) {
    let got: string
    try {
      const browser = await engine.launch()
      const page = await browser.newPage()
      // Any page of the dev server gives the origin the simulation's modules load from.
      await page.goto("http://localhost:5380/src/sim/version.ts")
      got = await page.evaluate(
        async ({ text, source }) => {
          const sim = await import("/src/sim/index.ts" as string)
          const run = sim.runReplay(sim.replayFromText(text))
          if (!run.ok) return `fault ${run.fault}`
          // The same fingerprint, built in the page.
          return new Function("timeMs", "splitsMs", "poses", `return (${source})(timeMs, splitsMs, poses)`)(run.timeMs, run.splitsMs, run.poses) as string
        },
        { text: kept.replay, source: fingerprint.toString() }
      )
      await browser.close()
    } catch (error) {
      got = `could not run: ${String(error).split("\n")[0]}`
    }
    const same = got === expected
    if (!same) failed = true
    console.log(`${entry.id}  ${name.padEnd(9)} ${got}${same ? "" : "   <-- DIFFERS"}`)
  }
}
if (failed) process.exit(1)
