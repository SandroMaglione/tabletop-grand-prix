/**
 * The Typeonce plate and the wipe.
 *
 * The plate is the maker's pixel lockup and "more games" as one link to typeonce.games, in
 * the place a racing game's timing screen carries the series' mark. It is a real link (a DOM
 * `<a>`), so it opens in a new tab, can be middle-clicked and is read by a screen reader.
 * There are two: the hatched header of the timing panel (the HUD places it with `place` and
 * hides it with `show`, since only the HUD knows where the timing panel is and when it is
 * up), and the first row of the leaderboard (`createPlateLink`, in `panels.ts`).
 *
 * The wipe plays when a lap is finished, the way a race broadcast cuts to a replay: three
 * slanted slabs (yellow, white, then the dark one that covers the whole window) speed in
 * from the right, and with them the lockup on a band: in fast, then very slowly on across
 * the middle of the window, never quite still, then away fast to the left as the slabs
 * leave. While the window is covered it calls `covered` once, so the page can change what
 * is behind it (the replay, the board). It never takes a click, and `cancel` (a restart)
 * removes it at once. A player who asked their system for less motion gets a short fade
 * instead.
 */
import { palette } from "../palette.ts"
import { createLockup } from "./lockup.ts"
import "./plate.css"

/** Where the plate leads: the home of the maker's games. */
export const site = "https://typeonce.games"

export interface BrandPlate {
  /** Top-left corner in CSS pixels, the size before scaling, and the HUD's scale. */
  place(x: number, y: number, width: number, height: number, scale: number): void
  /** Whether the timing panel's plate is up: it goes with the panel while a lap is shown again. */
  show(visible: boolean): void
  /** Cover the window with the brand, call `covered` while nothing behind it shows, then uncover. */
  wipe(covered: () => void): void
  /** Stop a wipe that is playing. Its `covered` is not called after this. */
  cancel(): void
}

const css = (colour: number, alpha: number = 1): string => `rgba(${(colour >> 16) & 255}, ${(colour >> 8) & 255}, ${colour & 255}, ${alpha})`

/**
 * The wipe's timing, in milliseconds: `wait` lets the player see the lap is done, each slab
 * starts `stagger` after the one before and takes `enter` to cross, the window stays covered
 * for `hold`, and `leave` uncovers it.
 */
const timing = { wait: 1420, enter: 380, stagger: 55, hold: 780, leave: 440 }

/** An arrow pointing up and to the right, as pixel art: a head of two bars and a shaft two pixels thick. */
const ARROW = ["..#####", "..#####", "....###", "...####", "..##.##", ".##....", "##....."]

/** The arrow as an SVG element `size` CSS pixels square, in the colour of the text around it. */
const createPixelArrow = (host: Document, size: number): SVGSVGElement => {
  const svg = host.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", `0 0 ${ARROW.length} ${ARROW.length}`)
  svg.setAttribute("width", String(size))
  svg.setAttribute("height", String(size))
  svg.setAttribute("shape-rendering", "crispEdges")
  svg.setAttribute("aria-hidden", "true")
  svg.classList.add("tgp-plate-arrow")
  const path = host.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", ARROW.flatMap((row, y) => Array.from(row, (cell, x) => (cell === "#" ? `M${x} ${y}h1v1h-1z` : ""))).join(""))
  path.setAttribute("fill", "currentColor")
  svg.appendChild(path)
  return svg
}

/** From the finish until the wipe has uncovered the window again, in milliseconds. */
export const wipeLeavesMs = timing.wait + timing.enter + timing.stagger * 2 + timing.hold + timing.leave + timing.stagger * 2

/** The band's size before scaling, as laid out in `plate.css`. */
const band = { width: 620, height: 176 }

const colours: ReadonlyArray<readonly [string, string]> = [
  ["--plate-back", css(palette.hudHead, 0.72)],
  ["--plate-back-lit", css(palette.hudHead, 0.95)],
  ["--plate-solid", css(palette.hudHead, 0.94)],
  ["--plate-cover", css(palette.hudBack)],
  ["--plate-text", css(palette.hudText)],
  ["--plate-dim", css(palette.hudDim)],
  ["--plate-accent", css(palette.hudAccent)]
]

/** One Typeonce plate: the lockup (`lockup` CSS pixels tall), "more games" and the arrow, as a link. The caller places it. */
export const createPlateLink = (host: Document, lockup: number = 20): HTMLAnchorElement => {
  const link = host.createElement("a")
  link.className = "tgp-plate"
  link.href = site
  link.target = "_blank"
  link.rel = "noopener"
  link.tabIndex = -1
  link.setAttribute("aria-label", "Typeonce Games: more games by the maker of this one (opens in a new tab)")
  // Where the link goes, with an arrow in the lockup's own pixels that points out of the game.
  const where = host.createElement("span")
  where.className = "tgp-plate-site"
  where.textContent = "MORE GAMES"
  link.append(createLockup(host, lockup), where, createPixelArrow(host, 12))
  // The keys belong to the game again as soon as the link has been used.
  link.addEventListener("click", () => link.blur())
  for (const [name, value] of colours) link.style.setProperty(name, value)
  return link
}

export const createBrandPlate = (host: Document): BrandPlate => {
  const link = createPlateLink(host)
  link.classList.add("tgp-plate-pinned")

  const stage = host.createElement("div")
  stage.className = "tgp-wipe"
  stage.setAttribute("aria-hidden", "true")
  // Bottom to top: the yellow slab leads in and trails out, the dark one covers.
  const slabs = ["tgp-wipe-accent", "tgp-wipe-pale", "tgp-wipe-dark"].map((name) => {
    const slab = host.createElement("div")
    slab.className = `tgp-wipe-slab ${name}`
    return slab
  })
  const plateBand = host.createElement("div")
  plateBand.className = "tgp-wipe-band"
  const artwork = host.createElement("div")
  artwork.className = "tgp-wipe-art"
  const line = host.createElement("span")
  line.textContent = "TYPEONCE.GAMES"
  artwork.append(createLockup(host, 76), line)
  plateBand.appendChild(artwork)
  stage.append(...slabs, plateBand)
  stage.hidden = true

  for (const [name, value] of colours) stage.style.setProperty(name, value)
  host.body.append(link, stage)

  let playing: Array<Animation> = []
  let timers: Array<ReturnType<typeof setTimeout>> = []
  const stop = (): void => {
    for (const animation of playing) animation.cancel()
    for (const timer of timers) clearTimeout(timer)
    playing = []
    timers = []
    stage.hidden = true
  }
  const later = (ms: number, run: () => void): void => {
    timers.push(setTimeout(run, ms))
  }
  return {
    place(x, y, width, height, scale) {
      link.style.width = `${width}px`
      link.style.height = `${height}px`
      link.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    },
    show(visible) {
      link.hidden = !visible
    },
    wipe(covered) {
      stop()
      const view = host.defaultView
      if (view === null) return covered()
      const calm = view.matchMedia("(prefers-reduced-motion: reduce)").matches
      later(timing.wait, () => {
        stage.hidden = false
        const dark = slabs[2]
        if (calm || dark === undefined) {
          for (const slab of slabs) slab.style.visibility = slab === dark ? "visible" : "hidden"
          const total = 220 + timing.hold + 260
          const fade = [{ opacity: 0 }, { opacity: 1, offset: 220 / total }, { opacity: 1, offset: (220 + timing.hold) / total }, { opacity: 0 }]
          playing = [dark, plateBand].flatMap((part) => (part === undefined ? [] : [part.animate(fade, { duration: total, fill: "forwards" })]))
          later(260, covered)
          later(total, stop)
          return
        }
        for (const slab of slabs) slab.style.visibility = "visible"
        // The slabs are wider than the window by their slant, so they cross a little more than its width.
        const cross = view.innerWidth + view.innerHeight * 0.7
        // The band fills a good half of a wide window, and still fits a narrow one.
        const fit = Math.max(0.4, Math.min(1.45, (view.innerWidth * 0.56) / band.width, (view.innerWidth - 40) / band.width))
        const coveredAt = timing.enter + timing.stagger * 2
        const total = coveredAt + timing.hold + timing.leave + timing.stagger * 2
        const at = (ms: number): number => Math.min(1, ms / total)
        // How far each side of the middle the lockup creeps while the window is covered.
        const drift = 18 * fit
        playing = [
          ...slabs.map((slab, index) => {
            // In: yellow first. Out: the dark one first, so yellow and white trail it.
            const inAt = index * timing.stagger
            const outAt = coveredAt + timing.hold + (slabs.length - 1 - index) * timing.stagger
            return slab.animate(
              [
                { transform: `translateX(${cross}px) skewX(-16deg)`, easing: "linear" },
                { transform: `translateX(${cross}px) skewX(-16deg)`, offset: at(inAt), easing: "cubic-bezier(0.3, 0.7, 0.2, 1)" },
                { transform: "translateX(0) skewX(-16deg)", offset: at(inAt + timing.enter), easing: "linear" },
                { transform: "translateX(0) skewX(-16deg)", offset: at(outAt), easing: "cubic-bezier(0.7, 0, 0.75, 0.4)" },
                { transform: `translateX(${-cross}px) skewX(-16deg)`, offset: at(outAt + timing.leave) },
                { transform: `translateX(${-cross}px) skewX(-16deg)` }
              ],
              { duration: total, fill: "forwards" }
            )
          }),
          // The lockup: in fast with the dark slab, very slowly on across the middle while the
          // window is covered, never still, then away fast to the left as the slabs leave.
          plateBand.animate(
            [
              { transform: `translate(${cross}px, 0) scale(${fit})`, easing: "linear" },
              { transform: `translate(${cross}px, 0) scale(${fit})`, offset: at(timing.stagger * 2), easing: "cubic-bezier(0.1, 0.75, 0.25, 1)" },
              { transform: `translate(${drift}px, 0) scale(${fit})`, offset: at(coveredAt), easing: "linear" },
              { transform: `translate(${-drift}px, 0) scale(${fit})`, offset: at(coveredAt + timing.hold), easing: "cubic-bezier(0.7, 0, 0.9, 0.3)" },
              { transform: `translate(${-cross}px, 0) scale(${fit})`, offset: at(coveredAt + timing.hold + timing.leave) },
              { transform: `translate(${-cross}px, 0) scale(${fit})` }
            ],
            { duration: total, fill: "forwards" }
          )
        ]
        later(coveredAt + 40, covered)
        later(total + 20, () => {
          for (const animation of playing) animation.cancel()
          playing = []
          stage.hidden = true
        })
      })
    },
    cancel: stop
  }
}
