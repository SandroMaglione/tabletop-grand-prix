/**
 * The email sign-up: one small DOM panel where a player can leave an address to hear when
 * Typeonce Games ships its next game. It posts to the studio's sign-up endpoint, which sends
 * a confirmation email (`subscribe.ts`).
 *
 * It sits in the timing panel's place, top left, at the timing panel's width and scale, while
 * that panel is away: during the replay of the player's own lap, from the second lap finished
 * in a visit, once the brand's wipe has left. It comes in with one short move and glint (`enter`;
 * none when the player asked for less motion) and goes when the replay does (`R`), or when the
 * player watches someone else's run. Never on arriving, during a lap or over a watched run.
 *
 * It is never in the way: it never takes the keyboard by itself and gives it back when it
 * goes; its buttons never take it; keys typed into its field are the field's (ritmo's keyboard,
 * `L`, `Esc` and space all leave a field alone), and `Esc` there only leaves the field. Once
 * the player has signed up or closed it, it is gone for good on this device
 * (`SignupOptions.done`, kept in the settings).
 *
 * Nothing is sent until the player submits. Off a typeonce.games address (`pnpm dev`, the
 * staging site) the form answers itself and sends nothing (`subscribe.ts`).
 */
import { wipeLeavesMs } from "./brand/plate.ts"
import { button, el, setHudColours } from "./panels-dom.ts"
import { messages, subscribe } from "./subscribe.ts"
import "./signup.css"

export interface Signup {
  /** A lap was finished (counted for the visit): the wipe begins. */
  lapFinished(): void
  /** Once per drawn frame: whether the player's own lap is being shown again. */
  update(ownReplay: boolean): void
}

export interface SignupOptions {
  /** The player has signed up or closed it before, on this device: it never shows. */
  readonly done: boolean
  /** The player signed up or closed it: keep that, so it never comes back. */
  readonly keep: () => void
}

/** From this finished lap of a visit on, the replay may carry the sign-up. */
const fromLap = 2

export const createSignup = (options: SignupOptions): Signup => {
  let done = options.done
  let finishes = 0
  /** When (`performance.now`) the last finish's wipe has left the window. */
  let wipeGone = Number.POSITIVE_INFINITY
  let shown = false
  let sending = false
  /** Signed up while on screen: the thanks stays until the panel goes, this once. */
  let thanking = false

  const root = el("div", "tgp-signup")
  setHudColours(root)
  root.hidden = true
  const panel = el("div", "tgp-panel tgp-signup-panel")
  // The light that crosses the panel once as it comes in.
  const glint = el("div", "tgp-signup-glint")
  const close = button("tgp-x tgp-signup-x", "×", () => finish())
  close.title = "Close"
  close.setAttribute("aria-label", "Close the email sign-up")
  const form = el("form", "tgp-form tgp-signup-form")
  form.noValidate = true
  form.setAttribute("aria-label", "Email sign-up")
  const hint = el("div", "tgp-hint", "AN EMAIL EACH TIME A NEW GAME SHIPS. SIMPLE, AND FREE.")
  hint.id = "tgp-signup-hint"
  const input = el("input", "tgp-input")
  input.type = "email"
  input.name = "email"
  input.placeholder = "you@example.com"
  input.autocomplete = "email"
  input.spellcheck = false
  input.tabIndex = -1
  input.setAttribute("aria-label", "Email address")
  input.setAttribute("aria-describedby", hint.id)
  const note = el("div", "tgp-signup-note tgp-bad")
  note.setAttribute("role", "status")
  note.hidden = true
  const submit = el("button", "tgp-button tgp-primary", "GET NEW GAMES")
  submit.type = "submit"
  submit.tabIndex = -1
  // A click on the button leaves the keyboard where it was: in the field, or with the car.
  submit.addEventListener("pointerdown", (event) => event.preventDefault())
  const thanks = el("div", "tgp-signup-done tgp-good", messages.ok)
  thanks.setAttribute("role", "status")
  thanks.hidden = true
  form.append(hint, input, note, submit, thanks)
  panel.append(glint, close, form)
  root.appendChild(panel)
  document.body.appendChild(root)

  const layout = (): void => {
    // The timing panel's own scale (`hud.ts`), so the two are the same size.
    const scale = Math.max(0.72, Math.min(1, window.innerWidth / 1500, window.innerHeight / 840))
    root.style.transform = `scale(${scale})`
  }
  layout()
  window.addEventListener("resize", layout)

  const clearError = (): void => {
    form.classList.remove("tgp-signup-error")
    input.removeAttribute("aria-invalid")
    note.hidden = true
    note.textContent = ""
  }

  /** The keyboard goes back to the game, if the panel had it. */
  const letGo = (): void => {
    if (root.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  /**
   * Coming in, once: in from the left edge as it fades up, its rim lit in the yellow accent
   * and cooling to the usual pale one, and a light crossing it. All inside its own place,
   * over the timing panel's empty spot. Nothing at all with less motion asked for.
   */
  const enter = (): void => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const accent = getComputedStyle(root).getPropertyValue("--hud-accent")
    panel.animate([{ opacity: 0, transform: "translateX(-28px)" }, { opacity: 1, transform: "none" }], { duration: 460, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" })
    panel.animate([{ borderColor: accent }, { borderColor: accent, offset: 0.45 }, { borderColor: "rgba(255, 255, 255, 0.24)" }], { duration: 1600, easing: "ease-out" })
    glint.animate([{ transform: "translateX(-120%) skewX(-20deg)" }, { transform: "translateX(320%) skewX(-20deg)" }], { duration: 760, delay: 320, easing: "cubic-bezier(0.4, 0, 0.3, 1)", fill: "backwards" })
  }

  const show = (next: boolean): void => {
    if (next === shown) return
    shown = next
    root.hidden = !next
    if (next) return enter()
    letGo()
    clearError()
    thanking = false
  }

  /** Signed up or closed: gone, for good. */
  const finish = (): void => {
    if (!done) options.keep()
    done = true
    show(false)
  }

  input.addEventListener("input", () => {
    if (form.classList.contains("tgp-signup-error")) clearError()
  })
  input.addEventListener("keydown", (event) => {
    // Esc only leaves the field; the board and the rest stay as they are.
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    input.blur()
  })

  form.addEventListener("submit", (event) => {
    event.preventDefault()
    if (sending) return
    sending = true
    clearError()
    submit.disabled = true
    void subscribe(input.value.trim(), window.location).then((outcome) => {
      sending = false
      submit.disabled = false
      if (outcome === "ok") {
        letGo()
        input.hidden = true
        submit.hidden = true
        thanks.hidden = false
        // It stays to say so until the replay ends, then never comes back.
        thanking = shown
        if (!done) options.keep()
        done = true
        return
      }
      // An answer that comes once the panel has gone is not kept for its next showing.
      if (!shown) return
      form.classList.add("tgp-signup-error")
      if (outcome === "invalid_email") input.setAttribute("aria-invalid", "true")
      note.textContent = messages[outcome]
      note.hidden = false
    })
  })

  return {
    lapFinished() {
      finishes++
      wipeGone = performance.now() + wipeLeavesMs
    },
    update(ownReplay) {
      // Signed up this visit: the thanks stays with the replay, and goes with it.
      const offered = !done || thanking
      show(offered && ownReplay && finishes >= fromLap && performance.now() >= wipeGone)
    }
  }
}
