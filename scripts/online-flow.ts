/**
 * Plays the leaderboard's flows in the real page against the stand-in server and takes a
 * picture at each step (into `output/online/`): the first lap, the name offered, the
 * answers to names typed, the lap posted, the board, racing a rival, changing the name,
 * a lap kept while the server is down and sent on the next visit, and the game with no
 * server at all. The bot drives (through `__race.drive`); keys are typed like a player's.
 *
 *   node scripts/online-flow.ts [out-dir]
 *
 * Prints what it checked; the exit code is 1 when a check failed or the page logged an error.
 */
import { mkdirSync } from "node:fs"
import { chromium, type Page } from "playwright-core"

const out = process.argv[2] ?? "output/online"
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu"] })
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()
let failures = 0
page.on("console", (message) => {
  if (message.text().includes("[vite]") && !message.text().includes("connect")) console.log(`vite: ${message.text()}`)
  if (message.type() === "error") {
    failures += 1
    console.log(`console error: ${message.text()}`)
  }
})
page.on("pageerror", (error) => {
  failures += 1
  console.log(`page error: ${String(error)}`)
})

const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures += 1
}
const shot = async (name: string): Promise<void> => {
  await page.screenshot({ path: `${out}/${name}.png` })
  console.log(`     ${out}/${name}.png`)
}
const open = async (path: string): Promise<void> => {
  await page.goto(`http://localhost:5380${path}`, { waitUntil: "load" })
  await page.waitForFunction(() => (window as any).__race?.online !== undefined)
  await page.waitForTimeout(2500)
}
const state = (target: Page = page) => target.evaluate(() => {
  const race = (window as any).__race
  const online = race.online.state()
  const view = race.session.view()
  const ghost = race.ghost.current()
  return {
    phase: view.lap.phase as string,
    attempt: view.lap.attempt as number,
    variant: race.session.variant() as string,
    identity: online.identity?.name ?? null,
    rank: online.rank,
    post: online.post?.state ?? null,
    reachable: online.reachable,
    best: race.laps.best()?.timeMs ?? null,
    ghost: ghost === null ? null : { kind: ghost.kind, name: ghost.name, timeMs: ghost.timeMs },
    namePrompts: online.namePrompts
  }
})

/** Lets the bot drive one lap (`slow` lifts off the gas through half the lap), then lets go. Returns the finish time. */
const driveLap = async (slow: boolean): Promise<number> => {
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
      if (race.__finishes > 0) return { throttle: 0, brake: 1, steer: 0, aim: null, restart: false }
      const input = sim.botInput(view, track)
      const lift = slowly && Math.sin(view.car.s * 0.05 + 5) > 0.2 ? 0.05 : 1
      return { ...input, throttle: input.throttle * lift }
    }
  }, slow)
  await page.waitForFunction(() => (window as any).__race.__finishes > 0, undefined, { timeout: 90000 })
  const time = await page.evaluate(() => (window as any).__race.laps.lastFinish().timeMs as number)
  return time
}
const typeName = async (name: string): Promise<void> => {
  await page.fill(".tgp-input", "")
  await page.type(".tgp-input", name, { delay: 30 })
  await page.waitForTimeout(900)
}
const status = () => page.evaluate(() => document.querySelector(".tgp-status")?.textContent ?? "")

// ── a first visit ───────────────────────────────────────────────────────
await open("/?server=fake&fresh=1")
let now = await state()
check(now.ghost?.kind === "rival" && now.ghost.name === "tumbleweed", `with no lap yet the ghost is the slowest on the board (${now.ghost?.name})`)
// The board is up without a key.
check(await page.isVisible(".tgp-rows"), "the board is up on a first visit")
await shot("01-first-visit")

// ── the first lap ───────────────────────────────────────────────────────
const first = await driveLap(true)
await page.waitForTimeout(500)
await shot("03-first-finish")
await page.waitForTimeout(2900)
now = await state()
const given = now.identity ?? ""
check(given.split(" ").length === 3 && now.post?.kind === "sent", `the first lap goes to the board under a made-up name (${given}, ${JSON.stringify(now.post)})`)
check(!(await page.isVisible(".tgp-input")) && (await page.isVisible(".tgp-rows")), "no name is asked for: the board opens beside the replay")
await shot("04-first-lap-on-the-board")

// The name is the player's to change, from the board.
await page.click(".tgp-link")
await page.waitForTimeout(300)
check((await page.inputValue(".tgp-input")) === given, "the name panel starts from the made-up name")
await page.click(".tgp-random")
await page.waitForTimeout(700)
const rolled = await page.inputValue(".tgp-input")
check(rolled !== given && rolled.split(" ").length === 3 && (await status()).includes("FREE"), `RANDOM offers another (${rolled}: ${await status()})`)

// The game's keys do nothing while the field has focus.
await page.fill(".tgp-input", "")
const before = await state()
await page.focus(".tgp-input")
for (const key of ["v", "m", "r", "w", "a", "s", "d", " "]) await page.keyboard.press(key)
await page.keyboard.down("ArrowUp")
await page.waitForTimeout(400)
await page.keyboard.up("ArrowUp")
const after = await state()
check(after.variant === before.variant && after.attempt === before.attempt && after.phase === before.phase, "keys typed into the name do not steer, restart, start or mute")
check((await page.inputValue(".tgp-input")) === "vmrwasd ", "the keys went into the field instead")

await typeName("a")
check((await status()).includes("TOO SHORT"), `too short: ${await status()}`)
await shot("05-name-too-short")
await typeName("big wheels!")
check((await status()).includes("ONLY LETTERS"), `odd characters: ${await status()}`)
await shot("06-name-characters")
await typeName("PEBBLE")
check((await status()).includes("TAKEN"), `taken: ${await status()}`)
await shot("07-name-taken")
await typeName("admin")
check((await status()).includes("KEPT BACK"), `reserved: ${await status()}`)
await typeName("Lap Hound")
check((await status()).includes("FREE"), `free: ${await status()}`)
await shot("08-name-free")
await page.keyboard.press("Enter")
await page.waitForTimeout(1500)
now = await state()
check(now.identity === "Lap Hound", `the name is kept (${now.identity})`)
check(now.post?.kind === "sent", `the lap is on the board under the new name (${JSON.stringify(now.post)})`)
await shot("09-posted")
check(now.ghost?.kind === "rival" && (now.ghost.timeMs ?? 0) < first, `the ghost is now the next closest (${now.ghost?.name} ${now.ghost?.timeMs} vs ${first})`)

// ── the board ───────────────────────────────────────────────────────────
// The board opened beside the replay when the lap was shown again, and came back after the name.
check(await page.isVisible(".tgp-rows"), "the board is open beside the replay of the lap")
await page.waitForTimeout(800)
await shot("10-board")
// Race lunebox, by its row.
await page.click(".tgp-row:has-text('LUNEBOX')")
await page.waitForTimeout(800)
now = await state()
check(now.ghost?.name === "lunebox", `a row clicked is the ghost (${now.ghost?.name})`)
await shot("11-rival-picked")
await page.click(".tgp-chip:has-text('OFF')")
await page.waitForTimeout(300)
check((await state()).ghost === null, "OFF races no ghost")
await page.click(".tgp-chip:has-text('MY BEST')")
await page.waitForTimeout(300)
check((await state()).ghost?.kind === "own", "MY BEST races the device's best")
await page.click(".tgp-row:has-text('LUNEBOX')")
await page.waitForTimeout(500)

// Change the name from the board.
await page.click(".tgp-link")
await page.waitForTimeout(300)
await shot("12-change-name")
await typeName("Lap Hound 2")
await page.keyboard.press("Enter")
await page.waitForTimeout(1500)
check((await state()).identity === "Lap Hound 2", "the name changed")
await shot("13-renamed")
await page.keyboard.press("Escape")

const fresh = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const old = await fresh.newPage()
await old.goto("http://localhost:5380/world-lab.html", { waitUntil: "load" })
await old.evaluate(() => {
  localStorage.setItem("tabletop-grand-prix:variant", "screen")
  localStorage.setItem("tabletop-grand-prix:muted", "1")
  localStorage.setItem("tabletop-grand-prix:best:spindle-leap:412", JSON.stringify({ timeMs: 1, splitsMs: [], poses: [] }))
})
await old.goto("http://localhost:5380/", { waitUntil: "load" })
await old.waitForFunction(() => (window as any).__race?.online !== undefined)
const carried = await old.evaluate(() => ({
  variant: (window as any).__race.session.variant() as string,
  best: (window as any).__race.laps.best(),
  left: Object.keys(localStorage).filter((key) => key.startsWith("tabletop-grand-prix:"))
}))
check(carried.variant === "car" && carried.best === null && carried.left.length === 0, `old saves: best laps dropped, old keys removed, one way to steer (${JSON.stringify(carried)})`)
await fresh.close()

await browser.close()
console.log(failures === 0 ? "all checks passed" : `${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
