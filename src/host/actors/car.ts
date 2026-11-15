/**
 * The car and its ghost: a rally hatchback built from rounded boxes and torus tyres.
 *
 * Seen from about 52 degrees above, about 40 px long, the shape has to read from the top: a body
 * with wide wheel arches, a dark glass cabin set back with a raked windscreen, a body-coloured
 * roof with a spoiler, and one wide pale stripe over hood and roof that shows the heading.
 *
 * Node chain, outermost first: `root` (position, yaw, pop-in scale) > `pitch` > `roll` (the
 * view's pose) > `body` (lean, squat and bounce, for the picture only). Wheels hang from `roll`,
 * so they stay on the road while the body moves on its springs. The body leans about the
 * axles' height, and the wheels follow its stretch and squash along the ground, so each stays
 * under its arch instead of the body swinging off it and the tyre showing through.
 */
import { Container3D, CylinderGeometry, Material3D, Mesh3D, PointLight, TorusGeometry, Vector3 } from "@pixi/3d"
import type { Geometry3D } from "@pixi/3d"
import type { CarView } from "../../sim/index.ts"
import type { GhostPose } from "../contract.ts"
import { palette } from "../palette.ts"
import { approach, clamp } from "./pose.ts"
import { roundedBox } from "./shapes.ts"

/** The car's size and where its wheels are, in its own frame: origin on the ground under the centre, +Z forward. */
export const CAR = {
  wheelRadius: 0.3,
  wheelX: 0.54,
  wheelZ: 0.78,
  length: 2.4
} as const

/** The four wheels' ground contacts in the car's frame: front left, front right, rear left, rear right. */
export const WHEELS: ReadonlyArray<readonly [number, number]> = [
  [CAR.wheelX, CAR.wheelZ],
  [-CAR.wheelX, CAR.wheelZ],
  [CAR.wheelX, -CAR.wheelZ],
  [-CAR.wheelX, -CAR.wheelZ]
]

/** The height the body leans about: the axles'. */
const AXLE = CAR.wheelRadius
/** Where each wheel arch sits on the body: this far out from its wheel, at this height (its middle). */
const ARCH_OUT = 0.02
const ARCH_Y = 0.52

interface Shapes {
  readonly lower: Geometry3D
  readonly arch: Geometry3D
  readonly cabin: Geometry3D
  readonly roof: Geometry3D
  readonly spoiler: Geometry3D
  readonly stripeHood: Geometry3D
  readonly stripeRoof: Geometry3D
  readonly stripeTail: Geometry3D
  readonly bumper: Geometry3D
  readonly lamp: Geometry3D
  readonly tyre: Geometry3D
  readonly hub: Geometry3D
  readonly spoke: Geometry3D
}

let shared: Shapes | null = null

/** Built once and shared by the car and the ghost. */
const shapes = (): Shapes => {
  if (shared !== null) return shared
  const cabinHalfHeight = 0.17
  const cabinHalfDepth = 0.65
  shared = {
    lower: roundedBox({ width: 1.22, height: 0.44, depth: 2.38, radius: 0.14, segments: 3 }),
    arch: roundedBox({ width: 0.24, height: 0.22, depth: 0.74, radius: 0.09, segments: 3 }),
    // The cabin narrows toward the roof and leans its windscreen back; the hatch stays steep.
    cabin: roundedBox({
      width: 1.06,
      height: cabinHalfHeight * 2,
      depth: cabinHalfDepth * 2,
      radius: 0.1,
      segments: 3,
      deform: (x, y, z, out) => {
        const up = (y + cabinHalfHeight) / (cabinHalfHeight * 2)
        out.x = x * (1 - 0.16 * up)
        out.y = y
        out.z = z > 0 ? z - 0.42 * up * (z / cabinHalfDepth) : z - 0.1 * up * (z / cabinHalfDepth)
      }
    }),
    roof: roundedBox({ width: 0.86, height: 0.07, depth: 0.8, radius: 0.03, segments: 2 }),
    spoiler: roundedBox({ width: 1.0, height: 0.06, depth: 0.22, radius: 0.025, segments: 2 }),
    stripeHood: roundedBox({ width: 0.32, height: 0.02, depth: 0.6, radius: 0.008, segments: 1 }),
    stripeRoof: roundedBox({ width: 0.32, height: 0.02, depth: 0.74, radius: 0.008, segments: 1 }),
    stripeTail: roundedBox({ width: 0.32, height: 0.02, depth: 0.2, radius: 0.008, segments: 1 }),
    bumper: roundedBox({ width: 1.16, height: 0.14, depth: 0.16, radius: 0.05, segments: 2 }),
    lamp: roundedBox({ width: 0.26, height: 0.1, depth: 0.05, radius: 0.02, segments: 1 }),
    tyre: new TorusGeometry({ radius: 0.2, tube: 0.1, radialSegments: 10, tubularSegments: 20 }),
    hub: new CylinderGeometry({ radiusTop: 0.125, radiusBottom: 0.125, height: 0.19, radialSegments: 14 }),
    spoke: roundedBox({ width: 0.21, height: 0.05, depth: 0.22, radius: 0.015, segments: 1 })
  }
  return shared
}

export interface CarLook {
  readonly body: Material3D
  readonly stripe: Material3D
  readonly glass: Material3D
  readonly tyre: Material3D
  readonly hub: Material3D
  readonly trim: Material3D
  /** Brake lights: glow strength goes up while braking. */
  readonly brake: Material3D
  readonly head: Material3D
}

/** The real car's materials: outlined body, tyres and trim, plain stripe and glass. */
export const carLook = (): CarLook => ({
  body: new Material3D({ baseColor: palette.car, roughness: 0.42, metallic: 0, passes: { outline: true } }),
  stripe: new Material3D({ baseColor: palette.carStripe, roughness: 0.5 }),
  glass: new Material3D({ baseColor: palette.glass, roughness: 0.18, metallic: 0.2, passes: { outline: true } }),
  tyre: new Material3D({ baseColor: palette.tyre, roughness: 0.9, passes: { outline: true } }),
  hub: new Material3D({ baseColor: palette.concrete, roughness: 0.5, metallic: 0.3 }),
  trim: new Material3D({ baseColor: palette.tyre, roughness: 0.7, passes: { outline: true } }),
  brake: new Material3D({ baseColor: palette.brakeLight, roughness: 0.4, emissive: { color: palette.brakeLight, strength: 0.25 } }),
  head: new Material3D({ baseColor: palette.headLight, roughness: 0.3, emissive: { color: palette.headLight, strength: 0.5 } })
})

/** The ghost: one see-through material for every part, no outline. */
export const ghostLook = (): CarLook => {
  const ghost = new Material3D({ baseColor: palette.ghost, roughness: 0.6, alphaMode: "blend", alpha: 0.38 })
  return { body: ghost, stripe: ghost, glass: ghost, tyre: ghost, hub: ghost, trim: ghost, brake: ghost, head: ghost }
}

export interface CarModel {
  readonly root: Container3D
  readonly pitch: Container3D
  readonly roll: Container3D
  readonly body: Container3D
  /** Front wheels turn about Y. */
  readonly steer: ReadonlyArray<Container3D>
  /** Every wheel spins about X. */
  readonly spin: ReadonlyArray<Container3D>
  /** Every wheel's pivot and where it stands at rest, in `roll`'s frame. */
  readonly wheels: ReadonlyArray<{ readonly pivot: Container3D; readonly x: number; readonly z: number }>
}

/** Builds one car. The ghost leaves out the small parts, so fewer see-through layers stack up. */
export const buildCar = (look: CarLook, ghost: boolean): CarModel => {
  const s = shapes()
  const shadow = !ghost
  const root = new Container3D({ label: ghost ? "ghost" : "car" })
  const pitch = new Container3D({ parent: root })
  const roll = new Container3D({ parent: pitch })
  const body = new Container3D({ parent: roll })
  const part = (geometry: Geometry3D, material: Material3D, x: number, y: number, z: number, parent: Container3D): Mesh3D =>
    new Mesh3D({ geometry, material, position: { x, y, z }, castShadow: shadow, receiveShadow: shadow, parent })

  part(s.lower, look.body, 0, 0.38, 0, body)
  for (const [x, z] of WHEELS) part(s.arch, look.body, x + Math.sign(x) * ARCH_OUT, ARCH_Y, z, body)
  part(s.cabin, look.glass, 0, 0.74, -0.22, body)
  part(s.roof, look.body, 0, 0.925, -0.38, body)
  if (!ghost) {
    part(s.spoiler, look.body, 0, 0.975, -0.78, body)
    part(s.stripeHood, look.stripe, 0, 0.605, 0.74, body)
    part(s.stripeRoof, look.stripe, 0, 0.965, -0.38, body)
    part(s.stripeTail, look.stripe, 0, 0.605, -0.98, body)
    part(s.bumper, look.trim, 0, 0.24, 1.14, body)
    part(s.bumper, look.trim, 0, 0.24, -1.14, body)
    for (const x of [0.4, -0.4]) {
      part(s.lamp, look.head, x, 0.47, 1.185, body)
      part(s.lamp, look.brake, x, 0.5, -1.185, body)
    }
  }

  const steer: Array<Container3D> = []
  const spin: Array<Container3D> = []
  const wheels: Array<{ pivot: Container3D; x: number; z: number }> = []
  for (const [x, z] of WHEELS) {
    const pivot = new Container3D({ position: { x, y: CAR.wheelRadius, z }, parent: roll })
    const spinner = new Container3D({ parent: pivot })
    // The torus lies in XZ; a quarter turn about Z puts its axle along X.
    part(s.tyre, look.tyre, 0, 0, 0, spinner).rotation.z = Math.PI / 2
    if (!ghost) {
      part(s.hub, look.hub, 0, 0, 0, spinner).rotation.z = Math.PI / 2
      part(s.spoke, look.trim, 0, 0, 0, spinner)
    }
    if (z > 0) steer.push(pivot)
    spin.push(spinner)
    wheels.push({ pivot, x, z })
  }
  return { root, pitch, roll, body, steer, spin, wheels }
}

/** Places a model at a pose. */
const pose = (model: CarModel, x: number, y: number, z: number, yaw: number, pitch: number, roll: number): void => {
  model.root.position.set(x, y, z)
  model.root.rotation.y = yaw
  model.pitch.rotation.x = -pitch
  model.roll.rotation.z = roll
}

/** Overshooting ease for the pop-in: 0 to 1 with a small bounce past 1. */
const popScale = (t: number): number => {
  if (t >= 1) return 1
  const c = 2.2
  const u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

/** The real car: pose from the view, plus the springs and lights that make it feel driven. */
export const createCar = (parent: Container3D) => {
  const look = carLook()
  const model = buildCar(look, false)
  parent.addChild(model.root)
  const brakeGlow = look.brake.emissive
  // The brake lights are real lights too: a red glow thrown on the road behind the car while
  // it brakes. Off (and free) the rest of the time.
  const brakeLight = new PointLight({ color: palette.brakeGlow, intensity: 0, range: 3.6, visible: false, position: { x: 0, y: 0.55, z: -1.75 }, parent: model.body })
  let brakeOn = 0
  /** An arch's middle in `roll`'s frame, worked out each frame. */
  const archAt = new Vector3()
  let wheelAngle = 0
  let steerAngle = 0
  let leanPitch = 0
  let leanPitchSpeed = 0
  let leanRoll = 0
  let leanRollSpeed = 0
  let bounce = 0
  let bounceSpeed = 0
  let pop = 1
  // Squash and stretch, so the car reads at game size where a few degrees of lean do not:
  // `stretch` is how much longer than rest the body is (negative: shorter), `squashY` how
  // much flatter (a landing), `squashX` how much narrower (a hit from the side).
  let stretch = 0
  let stretchSpeed = 0
  let squashY = 0
  let squashYSpeed = 0
  let squashX = 0
  let squashXSpeed = 0
  /** Speed last frame and the smoothed change of it, m/s^2: what the body reacts to. */
  let lastSpeed = 0
  let accel = 0
  /** Thrown off a rock and not yet down: the landing that follows squashes harder. */
  let hopped = false
  return {
    model,
    /** Starts the pop-in from nothing. */
    popIn() {
      pop = 0
      hopped = false
    },
    /** A landing pushes the body down on its springs and flattens it for a moment; after a rock's throw, harder. */
    land(impact: number) {
      const hit = clamp(impact, 0, 20) * (hopped ? 1.9 : 1)
      hopped = false
      bounceSpeed -= hit * 0.16
      squashYSpeed += hit * 0.6
    },
    /** Thrown off a rock: the nose kicks up as the front wheels ride it, and the body stretches a little. */
    hop(strength: number) {
      const k = clamp(strength, 0, 1)
      hopped = true
      leanPitchSpeed += 2.4 + k * 3
      bounceSpeed += 0.6 + k * 0.8
      stretchSpeed += 0.8 + k * 1.2
    },
    /** A hit kicks the body sideways and pinches it. */
    knock(amount: number) {
      leanRollSpeed += amount * 3
      squashXSpeed += Math.min(6, Math.abs(amount) * 3)
    },
    /** The boost pad's shove: the body snaps long. */
    surge() {
      stretchSpeed += 4.5
    },
    /** A small kick to the springs from a bumpy surface: up and down, side to side, flatter or taller. */
    jolt(up: number, side: number, flatten: number) {
      bounceSpeed += up
      leanRollSpeed += side
      squashYSpeed += flatten
    },
    /** The smoothed forward acceleration the body is reacting to, m/s^2. */
    accel: () => accel,
    update(car: CarView, seconds: number) {
      const dt = Math.min(seconds, 0.05)
      pose(model, car.x, car.y, car.z, car.yaw, car.pitch, car.roll)
      pop = Math.min(1, pop + dt / 0.32)
      model.root.scale.set(popScale(pop))

      steerAngle = approach(steerAngle, car.steer * 0.5, 18, dt)
      for (const pivot of model.steer) pivot.rotation.y = steerAngle
      // Off the line the wheels turn faster than the car moves: wheelspin.
      const spinning = car.grounded && car.throttle > 0.5 && car.speed < 12 ? (12 - Math.max(0, car.speed)) * 1.6 : 0
      if (car.grounded) wheelAngle = (wheelAngle + ((car.speed + spinning) / CAR.wheelRadius) * dt) % (Math.PI * 2)
      for (const spinner of model.spin) spinner.rotation.x = wheelAngle

      // Body springs, for the picture only. Sideways speed (positive to the left) and turning
      // roll the body toward the outside; throttle lifts the nose, braking dips it.
      const cos = Math.cos(car.yaw)
      const sin = Math.sin(car.yaw)
      const lateral = car.vx * cos - car.vz * sin
      const turning = car.grounded ? car.steer * clamp(Math.abs(car.speed) / 25, 0, 1) : 0
      const rollTarget = car.grounded ? clamp(turning * 0.17 - lateral * 0.035, -0.2, 0.2) : 0
      const braking = car.brake > 0.05 && car.speed > 0.5 ? car.brake : 0
      // A cut to the start line is not a braking: forget the speed from before it.
      if (pop === 0 || dt <= 0) lastSpeed = car.speed
      const measured = dt > 0 ? clamp((car.speed - lastSpeed) / dt, -45, 45) : 0
      lastSpeed = car.speed
      accel += (measured - accel) * (1 - Math.exp(-14 * dt))
      // The nose lifts as the car pulls away and dives as it brakes.
      const pitchTarget = car.grounded ? clamp(accel * 0.012 + car.throttle * 0.02, -0.2, 0.17) : 0.03
      const k = 150
      const c = 13
      leanRollSpeed += ((rollTarget - leanRoll) * k - leanRollSpeed * c) * dt
      leanRoll += leanRollSpeed * dt
      leanPitchSpeed += ((pitchTarget - leanPitch) * k - leanPitchSpeed * c) * dt
      leanPitch += leanPitchSpeed * dt
      bounceSpeed += (-bounce * 220 - bounceSpeed * 14) * dt
      bounce += bounceSpeed * dt
      // Longer under acceleration and the boost, shorter under the brakes.
      const stretchTarget = car.grounded ? clamp(accel * 0.007, -0.09, 0.1) + (car.boosting ? 0.16 : 0) : 0.04
      stretchSpeed += ((stretchTarget - stretch) * 220 - stretchSpeed * 13) * dt
      stretch += stretchSpeed * dt
      squashYSpeed += (-squashY * 300 - squashYSpeed * 15) * dt
      squashY += squashYSpeed * dt
      squashXSpeed += (-squashX * 320 - squashXSpeed * 16) * dt
      squashX += squashXSpeed * dt
      const long = clamp(stretch, -0.14, 0.3)
      const flat = clamp(squashY, -0.12, 0.3)
      const thin = clamp(squashX, -0.1, 0.22)
      model.body.scale.set((1 - long * 0.3 + flat * 0.4) * (1 - thin), (1 - long * 0.45) * (1 - flat), (1 + long + flat * 0.3) * (1 + thin * 0.35))
      model.body.rotation.x = -leanPitch
      model.body.rotation.z = leanRoll
      // The lean turns the body about the axles' height, not the ground: the arches stay over the tyres.
      model.body.position.set(AXLE * Math.sin(leanRoll), clamp(bounce, -0.2, 0.12) + AXLE * (1 - Math.cos(leanRoll)), 0)
      // Each wheel goes where the leaning, stretched or squashed body puts its arch, never
      // above the road: an arch that dips presses its tyre a little into the road (unseen from
      // above) instead of the tyre showing through the arch's top.
      for (const wheel of model.wheels) {
        model.roll.toLocal({ x: wheel.x + Math.sign(wheel.x) * ARCH_OUT, y: ARCH_Y, z: wheel.z }, model.body, archAt)
        wheel.pivot.position.set(archAt.x - Math.sign(wheel.x) * ARCH_OUT, Math.min(CAR.wheelRadius, archAt.y - (ARCH_Y - CAR.wheelRadius)), archAt.z)
      }

      if (brakeGlow !== undefined) brakeGlow.strength = braking > 0 ? 3.2 : 0.25
      brakeOn = approach(brakeOn, braking > 0 ? 1 : 0, braking > 0 ? 30 : 12, dt)
      brakeLight.visible = brakeOn > 0.01
      brakeLight.intensity = brakeOn * 9
    }
  }
}

/** The ghost: shown at its pose when there is one, wheels spinning with how far it moved. */
export const createGhost = (parent: Container3D) => {
  const model = buildCar(ghostLook(), true)
  model.root.visible = false
  parent.addChild(model.root)
  let wheelAngle = 0
  let lastX = 0
  let lastZ = 0
  let had = false
  return {
    update(ghost: GhostPose | null, seconds: number) {
      if (ghost === null) {
        model.root.visible = false
        had = false
        return
      }
      model.root.visible = true
      pose(model, ghost.x, ghost.y, ghost.z, ghost.yaw, ghost.pitch, ghost.roll)
      if (had && seconds > 0) {
        const moved = (ghost.x - lastX) * Math.sin(ghost.yaw) + (ghost.z - lastZ) * Math.cos(ghost.yaw)
        // A jump in place (a new lap of the ghost) is not a wheel turn.
        if (Math.abs(moved) < 3) wheelAngle = (wheelAngle + moved / CAR.wheelRadius) % (Math.PI * 2)
      }
      for (const spinner of model.spin) spinner.rotation.x = wheelAngle
      lastX = ghost.x
      lastZ = ghost.z
      had = true
    }
  }
}

export type Car = ReturnType<typeof createCar>
export type Ghost = ReturnType<typeof createGhost>
