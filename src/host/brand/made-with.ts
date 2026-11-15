/**
 * The note in the bottom left corner: "made with PixiJS 3D", with PixiJS's own logo
 * (`pixijs-logo.svg`, the file PixiJS publishes for this, used with their permission), as a
 * link to the renderer's page. Smaller and quieter than the HUD's panels: it is a credit, not
 * a readout. A real link (a DOM `<a>` over the canvas), like the Typeonce plate.
 */
import { palette } from "../palette.ts"
import logoUrl from "./pixijs-logo.svg"
import "./made-with.css"

/** Where the note leads: the page of the renderer the game is drawn with. */
export const rendererSite = "https://pixijs.com/3d"

const css = (colour: number, alpha: number = 1): string => `rgba(${(colour >> 16) & 255}, ${(colour >> 8) & 255}, ${colour & 255}, ${alpha})`

/** Adds the note to the page. `panelAlpha` is how solid the HUD's panels are; the note is a little more, so the logo reads on any ground. */
export const createMadeWith = (host: Document, panelAlpha: number): void => {
  const link = host.createElement("a")
  link.className = "tgp-made"
  link.href = rendererSite
  link.target = "_blank"
  link.rel = "noopener"
  link.setAttribute("aria-label", "Made with PixiJS 3D (opens in a new tab)")
  link.style.setProperty("--made-back", css(palette.hudBack, Math.min(1, panelAlpha + 0.2)))
  link.style.setProperty("--made-back-lit", css(palette.hudHead, 0.9))
  link.style.setProperty("--made-text", css(palette.hudText))
  link.style.setProperty("--made-dim", css(palette.hudDim))
  const made = host.createElement("span")
  made.className = "tgp-made-with"
  made.textContent = "MADE WITH"
  const logo = host.createElement("img")
  logo.src = logoUrl
  logo.alt = "PixiJS"
  logo.draggable = false
  const three = host.createElement("span")
  three.className = "tgp-made-3d"
  three.textContent = "3D"
  link.append(made, logo, three)
  // The keys belong to the game again as soon as the link has been used.
  link.addEventListener("click", () => link.blur())
  host.body.appendChild(link)

  const view = host.defaultView
  if (view === null) return
  // The HUD's own scale (`hud.ts`), so the note shrinks with the panels on a small window.
  const layout = (): void => {
    link.style.transform = `scale(${Math.max(0.72, Math.min(1, view.innerWidth / 1500, view.innerHeight / 840))})`
  }
  layout()
  view.addEventListener("resize", layout)
}
