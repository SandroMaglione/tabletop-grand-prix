/**
 * Drive laps with the bot against the stand-in board and check what follows the finish: the
 * wipe, the replay with the board beside it, the player's row moving up after a better lap,
 * the restart, and the board staying closed once the player has closed it. Takes pictures.
 *
 *   node scripts/lap-end.ts [out-dir] [--size 1600x900]
 *
 * Needs the dev server (http://localhost:5380). Prints what it checked; exits 1 on a
 * failed check or a console error.
 */
import { mkdirSync } from "node:fs"
import { chromium } from "playwright-core"

const args = process.argv.slice(2)
const out = args.find((arg) => !arg.startsWith("--") && !/^\d+x\d+$/.test(arg)) ?? "output/round8"
const sizeAt = args.indexOf("--size")
const [width = 1600, height = 900] = (sizeAt >= 0 ? (args[sizeAt + 1] ?? "") : "1600x900").split("x").map(Number)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--enable-unsafe-webgpu"] })
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
const errors: Array<string> = []
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text())
})
page.on("pageerror", (error) => errors.push(String(error)))

let failed = 0
const check = (name: string, ok: boolean, detail: string = ""): void => {
  if (!ok) failed++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`)
}

const state = () =>
  page.evaluate(() => {
    const race = (window as any).__race
    const view = race.session.view()
    const up = (selector: string): boolean => {
      const node = document.querySelector(selector)
      return node !== null && node.getBoundingClientRect().width > 0
    }
    return {
      phase: view.lap.phase as string,
      attempt: view.lap.attempt as number,
      replaying: race.rerun.active() as boolean,
      replayS: race.rerun.active() ? (race.rerun.view().car.s as number) : -1,
      board: up(".tgp-rows"),
      wipe: !(document.querySelector(".tgp-wipe")?.hasAttribute("hidden") ?? true),
      timingPlate: up(".tgp-plate-pinned"),
      boardPlate: up(".tgp-panel .tgp-plate"),
      mine: document.querySelector(".tgp-mine")?.textContent ?? "",
      gained: document.querySelector(".tgp-gained")?.textContent ?? "",
      look: document.querySelector(".tgp-replay-look")?.classList.contains("tgp-replay-on") ?? false
    }
  })

/** Lets the bot drive until the finish (`slow` lifts off the gas through half the lap), then lets go of everything. */
const driveLap = async (slow: boolean): Promise<void> => {
  await page.evaluate(async (slowly) => {
    const sim = await import("/src/sim/index.ts" as string)
    const race = (window as any).__race
    race.__finishes = 0
    const drain = race.session.__drain ?? race.session.drainEvents.bind(race.session)
    race.session.__drain = drain
    race.session.drainEvents = () => {
      const events = drain()
      for (const event of events) if (event.kind === "finish") race.__finishes += 1
      return events
    }
    race.drive = (view: any, track: any) => {
      if (race.__finishes > 0) return undefined
      const input = sim.botInput(view, track)
      return { ...input, throttle: input.throttle * (slowly && Math.sin(view.car.s * 0.05 + 5) > 0.2 ? 0.05 : 1) }
    }
  }, slow)
  await page.waitForFunction(() => (window as any).__race.__finishes > 0, undefined, { timeout: 120000 })
}

const open = async (): Promise<void> => {
  await page.waitForFunction(() => (window as any).__race?.online !== undefined)
  await page.waitForTimeout(1500)
}

await page.goto("http://localhost:5380/?server=fake&fresh", { waitUntil: "load" })
await open()
const arriving = await state()
check("the board is up on arriving, and the timing panel has its plate", arriving.board && arriving.timingPlate && arriving.boardPlate)
await page.screenshot({ path: `${out}/a1-ready.png` })

// A slow first lap: the board gets out of the way, the wipe waits, then the replay.
const first = driveLap(true)
await page.waitForTimeout(3000)
check("the board is away while the lap runs", !(await state()).board)
await first
await page.waitForTimeout(900)
const justDone = await state()
check("the wipe waits a moment after the finish, and the board with it", !justDone.wipe && !justDone.board)
await page.waitForTimeout(750)
await page.screenshot({ path: `${out}/a2-wipe-in.png` })
await page.waitForTimeout(400)
await page.screenshot({ path: `${out}/a3-covered.png` })
check("the wipe covers the window", (await state()).wipe)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${out}/a4-new-on-the-board.png` })
const shown = await state()
check("the lap is shown again behind the wipe", shown.replaying && shown.replayS > 0, `replay at s=${shown.replayS.toFixed(1)}`)
check("the live lap stays finished", shown.phase === "finished")
check("the board is back beside the replay, with the plate; the timing panel's is away", shown.board && shown.boardPlate && !shown.timingPlate)
check("the window wears the replay's look", shown.look)
check("the player's row comes onto the board marked as new", shown.gained === "NEW", `my row: ${shown.mine}`)
await page.waitForTimeout(3500)
await page.screenshot({ path: `${out}/a5-replay-board.png` })

// R starts again at once, from any moment of the replay.
await page.keyboard.press("r")
await page.waitForTimeout(120)
const again = await state()
check("R starts again at once, with the board and the timing panel back", again.phase === "ready" && !again.replaying && again.board && again.timingPlate && !again.look && again.attempt === shown.attempt + 1, JSON.stringify(again))

// A faster lap: the row climbs.
await driveLap(false)
await page.waitForTimeout(3900)
const climbing = await state()
check("a better lap moves the player's row up, with the places gained", /^▲ \d+$/.test(climbing.gained), `${climbing.gained}, my row: ${climbing.mine}`)
await page.screenshot({ path: `${out}/a6-row-climbing.png` })
await page.screenshot({ path: `${out}/p1-board.png`, clip: { x: width - 400, y: 0, width: 400, height: 480 } })
await page.waitForTimeout(600)
await page.screenshot({ path: `${out}/p2-board-later.png`, clip: { x: width - 400, y: 0, width: 400, height: 480 } })

// R during the wipe cancels it before anything changes.
await page.keyboard.press("r")
await driveLap(false)
await page.waitForTimeout(1700)
await page.keyboard.press("r")
await page.waitForTimeout(700)
const cancelled = await state()
check("R during the wipe cancels it", cancelled.phase === "ready" && !cancelled.wipe && !cancelled.replaying && cancelled.board, JSON.stringify(cancelled))

// The player closes the board: it stays closed, here and on the next visit.
await page.click(".tgp-x")
await page.waitForTimeout(200)
check("the cross closes the board", !(await state()).board)
await page.reload({ waitUntil: "load" })
await open()
check("it is still closed on the next visit", !(await state()).board)
await page.keyboard.press("l")
await page.waitForTimeout(200)
check("L opens it again", (await state()).board)

await browser.close()
for (const error of errors) console.error(`console error: ${error}`)
process.exit(failed > 0 || errors.length > 0 ? 1 : 0)
