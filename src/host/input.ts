/**
 * Keyboard and gamepad to `DriveInput`, plus the page's own keys (restart, handling
 * variant, sound).
 *
 * Both devices are bound to the same actions with ritmo's `Keyboard` and `Gamepad` and
 * merged with `Controls`, so a press counts once whichever device made it. `read` is
 * called once per simulation tick: a press shorter than a frame still reaches one tick.
 *
 * Two ways to steer, chosen by the handling variant:
 * - relative to the car (every variant whose name does not start with `screen`): left and
 *   right turn the wheel, up is throttle, down is brake.
 * - relative to the screen (`screen...`): the held direction is where to go on screen, and
 *   holding any direction is full throttle. The stick's direction is turned into a ground
 *   direction by the stage. The four keys follow the track's grid instead: the camera looks
 *   at the table a little from the side, so the roads run about 20 degrees off the screen's
 *   axes, and a key that followed the screen exactly would drift into a wall on every
 *   straight.
 *
 * Space brakes in both (and reverses from a stop): with screen steering every arrow is a
 * direction, so the brake needs a key of its own.
 */
import { Controls, Gamepad, Keyboard } from "@typeonce/ritmo-browser"
import type { DriveInput } from "../sim/index.ts"

const Actions = Controls.actions({ buttons: ["throttle", "brake", "stop", "restart", "variant", "mute"], vectors: ["move"] })

const keyBindings = {
  move: Keyboard.vector({ up: ["ArrowUp", "w"], down: ["ArrowDown", "s"], left: ["ArrowLeft", "a"], right: ["ArrowRight", "d"] }),
  throttle: ["ArrowUp", "w"],
  brake: ["ArrowDown", "s"],
  stop: [" "],
  restart: ["r"],
  variant: ["v"],
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
  variant: ["select"],
  mute: ["leftStick"]
} as const

/** One tick of input: the car's input and the page's own presses. */
export interface InputTick {
  readonly drive: DriveInput
  /** `V` or the pad's select: cycle the handling variant. */
  readonly cycleVariant: boolean
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
  /**
   * Once per simulation tick. `screenSteering` picks the steering mode;
   * `groundDirection` is `Stage.groundDirection`.
   */
  read(screenSteering: boolean, groundDirection: (x: number, y: number) => { x: number; z: number }): InputTick
  /**
   * Shake the gamepad, when it can: `strength` 0 to 1, for `milliseconds`. `sharp` uses the
   * small fast motor (a hit), otherwise the big slow one (a landing, the boost).
   */
  rumble(strength: number, milliseconds: number, sharp: boolean): void
  dispose(): void
}

/** Stick tilt below this reads as no direction in screen steering. */
const aimDeadZone = 0.2

/**
 * The stick's tilt to steering: gentle near the centre for small corrections on a straight,
 * full lock at full tilt.
 */
const stickCurve = (tilt: number): number => Math.sign(tilt) * Math.abs(tilt) ** 1.6

/** The axis of the track's grid (+X, -X, +Z or -Z) nearest to a ground direction. */
const gridAxis = (direction: { x: number; z: number }): { x: number; z: number } =>
  Math.abs(direction.x) > Math.abs(direction.z) ? { x: Math.sign(direction.x), z: 0 } : { x: 0, z: Math.sign(direction.z) }

export const createInput = (host: Window): Input => {
  const controls = Actions.merge({
    keyboard: Keyboard.actions(host, keyBindings),
    gamepad: Gamepad.actions(host, padBindings)
  })
  /** The device used last, so the HUD names the right buttons. */
  let padActive = false

  // Space is the brake: it must not scroll the page too.
  const stopSpace = (event: KeyboardEvent): void => {
    if (event.key === " " && !event.ctrlKey && !event.metaKey) event.preventDefault()
  }
  host.addEventListener("keydown", stopSpace)

  return {
    read(screenSteering, groundDirection) {
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
      const page = { cycleVariant: snapshot.actions.variant.pressed, toggleMute: snapshot.actions.mute.pressed, pad: padState }

      if (!screenSteering) {
        const throttle = Math.max(keyboard.actions.throttle.held ? 1 : 0, padThrottle)
        const brake = Math.max(keyboard.actions.brake.held || space ? 1 : 0, padBrake)
        // Screen x grows to the right; steer is positive to the left.
        // The keyboard is all or nothing; the stick goes through the curve.
        const keySteer = -keyboard.vectors.move.x
        const steer = Math.max(-1, Math.min(1, keySteer !== 0 ? keySteer : -stickCurve(pad.vectors.move.x)))
        return { drive: { throttle, brake, steer, aim: null, restart }, ...page }
      }

      const keys = keyboard.vectors.move
      const stick = pad.vectors.move
      const keysHeld = keys.x !== 0 || keys.y !== 0
      const stickLength = Math.hypot(stick.x, stick.y)
      let aim: { x: number; z: number } | null = null
      let throttle = padThrottle
      if (keysHeld) {
        // Up and right on the track's grid: the grid directions nearest to the screen's.
        const up = gridAxis(groundDirection(0, -1))
        const right = gridAxis(groundDirection(1, 0))
        const x = right.x * keys.x - up.x * keys.y
        const z = right.z * keys.x - up.z * keys.y
        const length = Math.hypot(x, z)
        aim = length === 0 ? null : { x: x / length, z: z / length }
        // Space with a direction held slows the car while it turns.
        throttle = space ? 0 : 1
      } else if (stickLength > aimDeadZone) {
        aim = groundDirection(stick.x, stick.y)
        // The stick's tilt is the throttle, full a little before full tilt.
        throttle = Math.max(throttle, Math.min(1, stickLength * 1.25))
      }
      const brake = Math.max(space ? 1 : 0, padBrake)
      return { drive: { throttle, brake, steer: 0, aim, restart }, ...page }
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
