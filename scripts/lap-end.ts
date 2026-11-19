/**
 * Drive laps with the bot against the stand-in board and check what follows the finish: the
 * wipe, the replay with the board beside it, the player's row moving up after a better lap,
 * the restart, the board staying closed once the player has closed it, and the email sign-up
 * in the timing panel's place (from the second lap, its field, each answer, signing up and
 * closing it for good). Takes pictures; the sign-up's are `s*.png`, with a close-up of the
 * corner beside each (`*-close.png`). Off typeonce.games the sign-up sends nothing.
 *
 *   node scripts/lap-end.ts [out-dir] [--size 1600x900] [--calm]
 *
 * `--calm` asks for less motion: the sign-up comes in without its entrance.
 * Needs the dev server (http://localhost:5380). Prints what it checked; exits 1 on a
 * failed check or a console error.
 */
import { mkdirSync } from "node:fs"
import { chromium } from "playwright-core"

const args = process.argv.slice(2)
const out = args.find((arg) => !arg.startsWith("--") && !/^\d+x\d+$/.test(arg)) ?? "output/round8"
const sizeAt = args.indexOf("--size")
const [width = 1600, height = 900] = (sizeAt >= 0 ? (args[sizeAt + 1] ?? "") : "1600x900").split("x").map(Number)
const calm = args.includes("--calm")
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--enable-unsafe-webgpu"] })
const errors: Array<string> = []
/** A new visit on a device that has never been here. */
const newDevice = async () => {
  const opened = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: calm ? "reduce" : "no-preference" })
  opened.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  opened.on("pageerror", (error) => errors.push(String(error)))
  // Nothing of the sign-up may leave the page while testing.
  await opened.route("**/api/subscribe**", (route) => {
    errors.push(`the sign-up was sent: ${route.request().url()}`)
    return route.abort()
  })
  return opened
}
let page = await newDevice()

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
      look: document.querySelector(".tgp-replay-look")?.classList.contains("tgp-replay-on") ?? false,
      signup: up(".tgp-signup-panel")
    }
  })

/** The sign-up as it is: where it is, what it says, and whether it or anything else has the keyboard. */
const signupState = () =>
  page.evaluate(async () => {
    const panel = document.querySelector(".tgp-signup-panel")
    const input = document.querySelector<HTMLInputElement>(".tgp-signup input")
    const note = document.querySelector<HTMLElement>(".tgp-signup-note")
    const box = panel?.getBoundingClientRect()
    const board = document.querySelector(".tgp-panels .tgp-panel")?.getBoundingClientRect()
    // The saves are in IndexedDB (`storage.ts`): an `entries` table of `{ key, value }`.
    const saved = await new Promise<string | null>((resolve) => {
      const opening = indexedDB.open("tabletop-grand-prix-saves")
      opening.onerror = () => resolve(null)
      opening.onsuccess = () => {
        const db = opening.result
        const reading = db.transaction("entries", "readonly").objectStore("entries").get("tabletop-grand-prix/settings")
        reading.onsuccess = () => {
          db.close()
          resolve(typeof reading.result?.value === "string" ? reading.result.value : null)
        }
        reading.onerror = () => resolve(null)
      }
    })
    const settings = JSON.parse(saved ?? "null")
    return {
      up: box !== undefined && box.width > 0,
      top: box?.top ?? -1,
      left: box?.left ?? -1,
      width: box?.width ?? -1,
      height: box?.height ?? -1,
      focused: document.activeElement === input,
      bodyFocused: document.activeElement === document.body || document.activeElement === null,
      value: input?.value ?? "",
      error: document.querySelector(".tgp-signup-error") !== null,
      invalid: input?.getAttribute("aria-invalid") === "true",
      border: input === null || input === undefined ? "" : getComputedStyle(input).borderTopColor,
      note: note !== null && note !== undefined && !note.hidden ? note.textContent ?? "" : "",
      done: (document.querySelector<HTMLElement>(".tgp-signup-done")?.offsetHeight ?? 0) > 0 ? document.querySelector(".tgp-signup-done")?.textContent ?? "" : "",
      animations: panel?.getAnimations({ subtree: true }).length ?? 0,
      board: board === undefined ? null : [board.top, board.left, board.width, board.height].map(Math.round).join(","),
      offer: settings?.signup as boolean | undefined,
      muted: settings?.muted as boolean | undefined
    }
  })

/** The window, and the timing panel's corner close up. */
const picture = async (name: string): Promise<void> => {
  await page.screenshot({ path: `${out}/${name}.png` })
  await page.screenshot({ path: `${out}/${name}-close.png`, clip: { x: 0, y: 0, width: Math.min(width, 440), height: Math.min(height, 340) } })
}

/** Waits for the sign-up to come in after a finish; how long after the finish it did. */
const signupComesIn = async (finishedAt: number): Promise<number> => {
  await page.waitForFunction(() => (document.querySelector(".tgp-signup-panel")?.getBoundingClientRect().width ?? 0) > 0, undefined, { timeout: 15000, polling: "raf" })
  return Date.now() - finishedAt
}

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
// With less motion asked for the board's rows do not slide, and carry no mark.
if (calm) check("with less motion the player's row comes onto the board without sliding", shown.gained === "", `my row: ${shown.mine}`)
else check("the player's row comes onto the board marked as new", shown.gained === "NEW", `my row: ${shown.mine}`)
check("no email sign-up beside the replay of the first lap", !shown.signup)
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
if (calm) check("with less motion a better lap moves the player's row up without sliding", climbing.gained === "", `my row: ${climbing.mine}`)
else check("a better lap moves the player's row up, with the places gained", /^▲ \d+$/.test(climbing.gained), `${climbing.gained}, my row: ${climbing.mine}`)
check("the second lap's replay carries the email sign-up where the timing panel was", climbing.signup && !climbing.timingPlate)
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
check("and no sign-up comes in after it", !cancelled.signup)

// The player closes the board: it stays closed, here and on the next visit.
await page.click(".tgp-panels .tgp-x")
await page.waitForTimeout(200)
check("the cross closes the board", !(await state()).board)
await page.reload({ waitUntil: "load" })
await open()
check("it is still closed on the next visit", !(await state()).board)
await page.keyboard.press("l")
await page.waitForTimeout(200)
check("L opens it again", (await state()).board)

// ── the email sign-up ────────────────────────────────────────────────────
/** The wipe leaves the window this long after the finish (`wipeLeavesMs` in `brand/plate.ts`). */
const wipeLeavesMs = 1420 + 380 + 55 * 2 + 780 + 440 + 55 * 2

// A new visit: the first lap's replay has none.
await page.reload({ waitUntil: "load" })
await open()
await driveLap(false)
await page.waitForTimeout(5000)
check("a new visit: no sign-up beside its first lap", !(await state()).signup && (await state()).replaying)
await page.keyboard.press("r")
await page.waitForTimeout(150)
const boardBefore = (await signupState()).board

// The second lap: the sign-up comes in once the wipe has gone.
await driveLap(false)
const secondAt = Date.now()
await page.waitForTimeout(2600)
check("not while the wipe is still on screen", !(await state()).signup)
const cameAfter = await signupComesIn(secondAt)
if (!calm) {
  // The entrance, held still at a few moments of it.
  await page.evaluate(() => {
    for (const animation of document.querySelector(".tgp-signup-panel")?.getAnimations({ subtree: true }) ?? []) animation.pause()
  })
  for (const [i, ms] of [70, 200, 560].entries()) {
    await page.evaluate((at) => {
      for (const animation of document.querySelector(".tgp-signup-panel")?.getAnimations({ subtree: true }) ?? []) animation.currentTime = at
    }, ms)
    await picture(`s1-entrance-${i + 1}-${ms}ms`)
  }
  await page.evaluate(() => {
    for (const animation of document.querySelector(".tgp-signup-panel")?.getAnimations({ subtree: true }) ?? []) animation.finish()
  })
} else {
  check("with less motion asked for it simply appears", (await signupState()).animations === 0)
}
await page.waitForTimeout(300)
const rest = await signupState()
check("it comes in once the wipe has left", cameAfter >= wipeLeavesMs - 100 && cameAfter <= wipeLeavesMs + 800, `${cameAfter} ms after the finish`)
check("it comes in without taking the keyboard", !rest.focused && rest.bodyFocused)
// The timing panel's scale (`hud.ts`), and REPLAY's half width at it: about 54px before scaling.
const hudScale = Math.max(0.72, Math.min(1, width / 1500, height / 840))
const replayLeft = width / 2 - 54 * hudScale
check("it sits in the timing panel's place, 330 wide at the HUD's scale, and smaller than the timing panel", Math.round(rest.top) === 12 && Math.round(rest.left) === 12 && Math.abs(rest.width - 330 * hudScale) < 1 && rest.height < 250 * hudScale, `${rest.width}×${rest.height} at ${rest.left},${rest.top}`)
check("it keeps well clear of REPLAY at the top centre", rest.left + rest.width + 40 * hudScale < replayLeft, `right edge ${Math.round(rest.left + rest.width)}, REPLAY from about ${Math.round(replayLeft)}`)
check("the board beside it has not moved", rest.board === boardBefore, `${rest.board} against ${boardBefore}`)
check("the entrance has played out", rest.animations === 0)
await picture("s2-at-rest")

// The field: keys typed into it are its own, never the car's or the page's.
const typingFrom = await state()
await page.click(".tgp-signup input")
await page.keyboard.type("player@example.com", { delay: 15 })
await page.waitForTimeout(150)
const typed = await signupState()
const afterTyping = await state()
check("typing an address into the field drives nothing: no restart, no mute", typed.value === "player@example.com" && afterTyping.replaying && afterTyping.attempt === typingFrom.attempt && typed.muted !== true, JSON.stringify({ value: typed.value, attempt: afterTyping.attempt, muted: typed.muted }))
await picture("s3-typed")

const answer = async (email: string, name: string): Promise<Awaited<ReturnType<typeof signupState>>> => {
  await page.fill(".tgp-signup input", email)
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => {
    const note = document.querySelector<HTMLElement>(".tgp-signup-note")
    const done = document.querySelector<HTMLElement>(".tgp-signup-done")
    return (note !== null && !note.hidden) || (done !== null && !done.hidden)
  }, undefined, { timeout: 5000 })
  await page.waitForTimeout(100)
  await picture(name)
  return signupState()
}
const wrong = await answer("player.example.com", "s4-error-invalid-email")
check("an address without @ is not right, in red under the field", wrong.note === "THAT ADDRESS DOES NOT LOOK RIGHT." && wrong.error && wrong.invalid && wrong.border === "rgb(255, 107, 120)", JSON.stringify(wrong))
check("an error grows the panel downward only", wrong.top === rest.top && wrong.height > rest.height)
await page.keyboard.press("End")
await page.keyboard.type("x")
const edited = await signupState()
check("editing the address clears the error", !edited.error && edited.note === "" && !edited.invalid)
const limited = await answer("limit@example.com", "s5-error-rate-limited")
check("too many tries", limited.note === "TOO MANY TRIES. WAIT A MINUTE AND TRY AGAIN." && limited.error && !limited.invalid && limited.top === rest.top, `${limited.note} at ${limited.top}, ${limited.height} tall`)
const down = await answer("down@example.com", "s6-error-unavailable")
check("did not go through", down.note === "THAT DID NOT GO THROUGH. TRY AGAIN." && down.error)

// Esc in the field only leaves the field; then the game's keys are the game's again.
await page.keyboard.press("Escape")
await page.waitForTimeout(100)
const left = await signupState()
const leftState = await state()
check("Esc leaves the field, and only that", !left.focused && left.up && leftState.board && leftState.replaying, JSON.stringify({ focused: left.focused, up: left.up, board: leftState.board }))
// Watching a run of the board: the sign-up is not over someone else's lap.
await page.click(".tgp-panels .tgp-row .tgp-watch")
await page.waitForFunction(() => (window as any).__race.rerun.watched() !== null, undefined, { timeout: 10000 })
await page.waitForTimeout(150)
check("watching a run of the board puts the sign-up away", !(await signupState()).up)
await page.keyboard.press("r")
await page.waitForTimeout(150)
check("R starts again, with the timing panel back and no sign-up", (await state()).phase === "ready" && (await state()).timingPlate && !(await signupState()).up)

// The next lap: it is offered again (not yet declined); this time the player signs up.
await driveLap(false)
await signupComesIn(Date.now())
await page.waitForTimeout(1800)
// The field keeps what was typed in it earlier in the visit.
await page.fill(".tgp-signup input", "")
await page.keyboard.type("player@example.com")
await page.keyboard.press("r")
await page.waitForTimeout(150)
const rTyped = { replaying: (await state()).replaying, value: (await signupState()).value }
check("R typed in the field is a letter, not a restart", rTyped.replaying && rTyped.value === "player@example.comr", JSON.stringify(rTyped))
const signed = await answer("player@example.com", "s7-signed-up")
check("signing up says to check the inbox, in place of the field and the button", signed.done === "CHECK YOUR INBOX TO CONFIRM." && signed.note === "" && !signed.focused, JSON.stringify(signed))
check("and is kept on the device", signed.offer === false)
await page.keyboard.press("r")
await page.waitForTimeout(150)
check("R takes the thanks away with the replay", !(await signupState()).up && (await state()).phase === "ready")
await driveLap(false)
await page.waitForTimeout(wipeLeavesMs + 1500)
check("once signed up it never comes back", !(await signupState()).up && (await state()).replaying)

// Another device: two laps, then the player closes it, for good.
await page.close()
page = await newDevice()
await page.goto("http://localhost:5380/?server=fake&fresh", { waitUntil: "load" })
await open()
for (const lap of [1, 2]) {
  await driveLap(false)
  if (lap === 1) {
    await page.waitForTimeout(wipeLeavesMs + 1000)
    await page.keyboard.press("r")
  }
}
await signupComesIn(Date.now())
await page.waitForTimeout(1800)
await page.click(".tgp-signup input")
await page.keyboard.type("half")
await page.click(".tgp-signup-x")
await page.waitForTimeout(200)
const closed = await signupState()
check("the cross closes it at once and gives the keyboard back", !closed.up && !closed.focused && closed.offer === false, JSON.stringify(closed))
check("the replay and the board carry on", (await state()).replaying && (await state()).board)
await picture("s8-closed")
await page.reload({ waitUntil: "load" })
await open()
for (const lap of [1, 2]) {
  await driveLap(false)
  await page.waitForTimeout(wipeLeavesMs + 1500)
  if (lap === 1) await page.keyboard.press("r")
}
check("closed, it does not come back on the next visit", !(await signupState()).up && (await state()).replaying)

await browser.close()
for (const error of errors) console.error(`console error: ${error}`)
process.exit(failed > 0 || errors.length > 0 ? 1 : 0)
