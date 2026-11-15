/**
 * Keyboard and gamepad to `DriveInput`, plus the page's own keys (restart, handling
 * variant, sound).
 *
 * Both devices are bound to the same actions with ritmo's `Keyboard` and `Gamepad` and
 * merged with `Controls`, so a press counts once whichever device made it. `read` is
 * called once per simulation tick: a press shorter than a frame still reaches one tick.
 *
 * Keys typed into a form field (the player's name) are left to it: ritmo's keyboard does
 * not press an action for them.
 *
 * Up is throttle, down and space brake (and reverse from a stop), left and right turn the
 * wheel; on a gamepad the right trigger, the left trigger and the stick. Throttle and brake
 * held together in a turn are the drift (the simulation's rule, not a key of its own). Nothing on screen
 * explains this beyond the start prompt: the arrows are the game.
 */
import { Controls, Gamepad, Keyboard } from "@typeonce/ritmo-browser"
import type { DriveInput } from "../sim/index.ts"

const Actions = Controls.actions({ buttons: ["throttle", "brake", "stop", "restart", "mute"], vectors: ["move"] })

const keyBindings = {
  move: Keyboard.vector({ up: ["ArrowUp", "w"], down: ["ArrowDown", "s"], left: ["ArrowLeft", "a"], right: ["ArrowRight", "d"] }),
  throttle: ["ArrowUp", "w"],
  brake: ["ArrowDown", "s"],
  stop: [" "],
  restart: ["r"],
  mute: ["m"]
} as const

const padBindings = {
  move: Gamepad.vector({ stick: "left", up: ["dpadUp"], down: ["dpadDown"], left: ["dpadLeft"], right: ["dpadRight"] }),
  // The triggers are read as analog values below, so half a pull is half throttle; A and B
  // are the all-or-nothing buttons for pads without them.
  throttle: ["south"],
  brake: ["east"],
  stop: ["west"],
  restart: ["north", "start"],
  mute: ["leftStick"]
} as const

/** One tick of input: the car's input and the page's own presses. */
export interface InputTick {
  readonly drive: DriveInput
  /** `M` or a click of the left stick: sound on or off. */
  readonly toggleMute: boolean
  /** The gamepad, for the HUD's wording. */
  readonly pad: PadState
}

/**
 * - `none`: no gamepad.
 * - `ready`: a gamepad the browser understands; `active` when it was the last device used.
 * - `buttons-only`: a gamepad outside the browser's standard mapping: its sticks and
 *   triggers cannot be read, only its buttons.
 */
export type PadState = { readonly kind: "none" } | { readonly kind: "ready"; readonly active: boolean } | { readonly kind: "buttons-only" }

export interface Input {
  /** Once per simulation tick. */
  read(): InputTick
  /**
   * Shake the gamepad, when it can: `strength` 0 to 1, for `milliseconds`. `sharp` uses the
   * small fast motor (a hit), otherwise the big slow one (a landing, the boost).
   */
  rumble(strength: number, milliseconds: number, sharp: boolean): void
  dispose(): void
}

/**
 * The stick's tilt to steering: gentle near the centre for small corrections on a straight,
 * full lock at full tilt.
 */
const stickCurve = (tilt: number): number => Math.sign(tilt) * Math.abs(tilt) ** 1.6

export const createInput = (host: Window): Input => {
  const controls = Actions.merge({
    keyboard: Keyboard.actions(host, keyBindings),
    gamepad: Gamepad.actions(host, padBindings)
  })
  /** The device used last, so the HUD names the right buttons. */
  let padActive = false

  // Space is the brake: it must not scroll the page too. A space typed into a form field
  // (the player's name) is the field's.
  const stopSpace = (event: KeyboardEvent): void => {
    const target = event.target
    const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    if (event.key === " " && !event.ctrlKey && !event.metaKey && !typing) event.preventDefault()
  }
  host.addEventListener("keydown", stopSpace)

  return {
    read() {
      const snapshot = controls.snapshot()
      const keyboard = snapshot.devices.keyboard
      const pad = snapshot.devices.gamepad
      const padThrottle = Math.max(pad.rightTrigger, pad.actions.throttle.held ? 1 : 0)
      const padBrake = Math.max(pad.leftTrigger, pad.actions.brake.held || pad.actions.stop.held ? 1 : 0)
      const space = keyboard.actions.stop.held
      const restart = snapshot.actions.restart.pressed
      if (pad.used) padActive = true
      else if (keyboard.used) padActive = false
      const padState: PadState = !pad.connected ? { kind: "none" } : pad.standard ? { kind: "ready", active: padActive } : { kind: "buttons-only" }
      const page = { toggleMute: snapshot.actions.mute.pressed, pad: padState }

      const throttle = Math.max(keyboard.actions.throttle.held ? 1 : 0, padThrottle)
      const brake = Math.max(keyboard.actions.brake.held || space ? 1 : 0, padBrake)
      // Screen x grows to the right; steer is positive to the left.
      // The keyboard is all or nothing; the stick goes through the curve.
      const keySteer = -keyboard.vectors.move.x
      const steer = Math.max(-1, Math.min(1, keySteer !== 0 ? keySteer : -stickCurve(pad.vectors.move.x)))
      return { drive: { throttle, brake, steer, aim: null, restart }, ...page }
    },
    rumble(strength, milliseconds, sharp) {
      if (!padActive) return
      try {
        for (const device of host.navigator.getGamepads()) {
          const motor = device?.vibrationActuator
          if (motor === undefined || motor === null) continue
          void motor.playEffect("dual-rumble", {
            duration: milliseconds,
            strongMagnitude: sharp ? strength * 0.4 : strength,
            weakMagnitude: sharp ? strength : strength * 0.5
          }).catch(() => {})
        }
      } catch {
        // No rumble on this browser or pad: nothing to do.
      }
    },
    dispose() {
      controls.dispose()
      host.removeEventListener("keydown", stopSpace)
    }
  }
}
