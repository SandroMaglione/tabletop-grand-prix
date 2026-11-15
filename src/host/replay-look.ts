/**
 * How the window looks while a lap is shown again, so nobody takes the replay for the race:
 * a border of recorded footage round the window. Along its edges the picture darkens and
 * shows fine scan lines, fading to nothing well before the middle, inside a thin pale frame;
 * the map itself is left as it is. It fades in and out, takes no clicks, and lies over the
 * canvas but under the panels and links.
 */
import "./replay-look.css"

export interface ReplayLook {
  /** Once per drawn frame: whether a lap is being shown again. */
  show(on: boolean): void
}

/** Adds the look to the page, just above `canvas`. */
export const createReplayLook = (host: Document, canvas: HTMLElement): ReplayLook => {
  const look = host.createElement("div")
  look.className = "tgp-replay-look"
  look.setAttribute("aria-hidden", "true")
  canvas.insertAdjacentElement("afterend", look)
  let shown = false
  return {
    show(on) {
      if (on === shown) return
      shown = on
      look.classList.toggle("tgp-replay-on", on)
    }
  }
}
