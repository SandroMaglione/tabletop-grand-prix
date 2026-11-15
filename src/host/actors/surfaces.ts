/**
 * What the car does to the ground it drives on: the ford, the meadow, the stony ground.
 *
 * Each frame every wheel is placed on the road (`world/patches.ts`, without allocating) and
 * asked which patch it is on, so everything here works per wheel:
 * - water: a splash as the car drives in (droplets and mist, more with speed), then spray
 *   from each wheel in the water: thrown out sideways from the fronts, a rooster tail from the
 *   rears; and wet tyre tracks after the pool (`wet.ts`) from each wheel that was in it;
 * - grass: clippings and torn blades thrown up and back from each wheel in it;
 * - stones: dust and gravel from each wheel on the rough ground, more and further with speed,
 *   and the body rattles on its springs: a kick each time a wheel finds a stone or a rut (more
 *   often and harder with speed), over a constant shiver.
 * A car that moved further in one frame than it can drive, or a tick that went backwards (a
 * restart, a replay from another session), is a jump in place: trails break, tyres dry, and
 * no splash is made for landing in the pool.
 */
import type { Container3D } from "@pixi/3d"
import { type RaceView, type SurfaceKind, surfaceAt, type TrackData } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { locateRoad, roadSpot } from "../world/patches.ts"
import type { Car } from "./car.ts"
import { WHEELS } from "./car.ts"
import type { Particles, Spawn } from "./particles.ts"
import { rotate, vec } from "./pose.ts"
import { createWetTracks } from "./wet.ts"

/**
 * Moved further than this in one frame: a jump in place, not driving. The page catches up at
 * most a quarter second of ticks in one frame (a tab coming back), so a fast car may honestly
 * cover more than this; the limit grows with its speed.
 */
const JUMP = 4
const jumpLimit = (speed: number): number => Math.max(JUMP, Math.abs(speed) * 0.3 + 1)

export const createSurfaceFx = (parent: Container3D, track: TrackData, car: Car, particles: Particles, spawn: Spawn, rand: () => number) => {
  const wet = createWetTracks(parent)
  const spot = roadSpot()
  const point = vec()
  const on: Array<SurfaceKind | null> = WHEELS.map(() => null)
  const inWater: Array<boolean> = WHEELS.map(() => false)
  const clocks = new Float32Array(WHEELS.length)
  let lastSurface: SurfaceKind | "road" = "road"
  /** Counts up to the next wheel that finds a stone on the rough ground. */
  let rattleClock = 0
  let lastX = 0
  let lastZ = 0
  let lastTick = -1

  const emit = (soft: boolean): void => {
    if (soft) particles.soft.emit(spawn)
    else particles.glow.emit(spawn)
  }

  /** Driving into the pool: a crown of droplets and a low mist, bigger with speed. */
  const splash = (view: RaceView): void => {
    const c = view.car
    const speed = Math.abs(c.speed)
    const strength = Math.min(1, 0.3 + speed / 22)
    const fx = Math.sin(c.yaw)
    const fz = Math.cos(c.yaw)
    const drops = Math.round(18 + strength * 34)
    for (let n = 0; n < drops; n++) {
      const a = rand() * Math.PI * 2
      const out = 1.2 + rand() * 3 * strength
      spawn.x = c.x + Math.cos(a) * 0.6 + fx * 0.8
      spawn.y = c.y + 0.15
      spawn.z = c.z + Math.sin(a) * 0.6 + fz * 0.8
      spawn.vx = Math.cos(a) * out + c.vx * 0.35
      spawn.vy = 2.5 + rand() * 4 * strength
      spawn.vz = Math.sin(a) * out + c.vz * 0.35
      spawn.life = 0.5 + rand() * 0.45
      spawn.size = 0.12 + rand() * 0.12
      spawn.sizeEnd = 0.05
      spawn.alpha = 0.95
      spawn.color = palette.spray
      spawn.drag = 0.6
      spawn.gravity = 13
      emit(true)
    }
    for (let n = 0; n < 8; n++) {
      const a = rand() * Math.PI * 2
      spawn.x = c.x + Math.cos(a) * 0.8
      spawn.y = c.y + 0.3
      spawn.z = c.z + Math.sin(a) * 0.8
      spawn.vx = Math.cos(a) * 1.4 + c.vx * 0.2
      spawn.vy = 0.6 + rand() * 0.6
      spawn.vz = Math.sin(a) * 1.4 + c.vz * 0.2
      spawn.life = 0.8 + rand() * 0.4
      spawn.size = 0.6
      spawn.sizeEnd = 1.8 + strength
      spawn.alpha = 0.3 + strength * 0.2
      spawn.color = palette.spray
      spawn.drag = 2.5
      spawn.gravity = -0.3
      emit(true)
    }
  }

  return {
    /** Breaks every trail: the car pops in at the line. */
    cut() {
      wet.cut()
      lastSurface = "road"
    },
    update(view: RaceView, seconds: number) {
      const c = view.car
      const jumped = (lastTick >= 0 && view.tick < lastTick) || Math.hypot(c.x - lastX, c.z - lastZ) > jumpLimit(c.speed)
      lastTick = view.tick
      lastX = c.x
      lastZ = c.z
      if (jumped) {
        wet.cut()
        lastSurface = c.surface
      }
      const hint = Math.round(c.s / track.spacing)
      for (let w = 0; w < WHEELS.length; w++) {
        const wheel = WHEELS[w]!
        rotate(c.yaw, c.pitch, c.roll, wheel[0], 0, wheel[1], point)
        locateRoad(track, c.x + point.x, c.z + point.z, hint, spot)
        on[w] = c.grounded ? surfaceAt(track, spot.s, spot.d) : null
        inWater[w] = on[w] === "water"
      }
      wet.update(c, inWater, seconds)

      if (c.grounded && c.surface === "water" && lastSurface !== "water" && !jumped) splash(view)
      lastSurface = c.surface

      const speed = Math.abs(c.speed)
      const pace = Math.min(1, speed / 25)
      const fx = Math.sin(c.yaw)
      const fz = Math.cos(c.yaw)
      // Left of the car is (cos yaw, -sin yaw).
      const lx = fz
      const lz = -fx
      for (let w = 0; w < WHEELS.length; w++) {
        const kind = on[w]
        if (kind === null || speed < 1) {
          clocks[w] = 0
          continue
        }
        const wheel = WHEELS[w]!
        const front = wheel[1] > 0
        const outward = wheel[0] > 0 ? 1 : -1
        const rate = kind === "water" ? 14 + speed * 3.2 : kind === "grass" ? speed * 1.8 : speed * 1.9
        clocks[w] = clocks[w]! + seconds * rate
        while (clocks[w]! >= 1) {
          clocks[w] = clocks[w]! - 1
          rotate(c.yaw, c.pitch, c.roll, wheel[0] + outward * 0.12, 0.1, wheel[1], point)
          spawn.x = c.x + point.x
          spawn.y = c.y + point.y
          spawn.z = c.z + point.z
          const back = (0.15 + rand() * 0.25) * speed
          if (kind === "water") {
            // Fronts fan out to the side (the wake); rears throw a tail up behind.
            const sideways = front ? 1.4 + pace * 3 + rand() * 1.5 : 0.4 + rand() * 1.2
            const lift = front ? 1 + pace * 2.2 + rand() : 1.6 + pace * 3.5 + rand() * 1.5
            spawn.vx = lx * outward * sideways - fx * (front ? back * 0.3 : back * 0.6) + c.vx * 0.25
            spawn.vy = lift
            spawn.vz = lz * outward * sideways - fz * (front ? back * 0.3 : back * 0.6) + c.vz * 0.25
            spawn.life = 0.35 + rand() * 0.35
            spawn.size = 0.1 + rand() * 0.1 + pace * 0.06
            spawn.sizeEnd = 0.04
            spawn.alpha = 0.9
            spawn.color = palette.spray
            spawn.drag = 0.8
            spawn.gravity = 12
          } else if (kind === "grass") {
            const pick = rand()
            spawn.vx = -fx * back * 0.5 + lx * outward * (rand() - 0.2) * 1.5 + c.vx * 0.2
            spawn.vy = 1.5 + rand() * 2.5 * (0.4 + pace)
            spawn.vz = -fz * back * 0.5 + lz * outward * (rand() - 0.2) * 1.5 + c.vz * 0.2
            spawn.life = 0.7 + rand() * 0.5
            spawn.size = 0.2 + rand() * 0.12
            spawn.sizeEnd = 0.14
            spawn.alpha = 1
            spawn.color = pick < 0.45 ? palette.clipping : pick < 0.8 ? palette.bladeMid : palette.bladeTip
            spawn.drag = 1.8
            spawn.gravity = 7
          } else if (rand() < 0.5) {
            // Rough ground: a trailing cloud of dust from the rears, a little from the fronts...
            spawn.vx = -fx * back * 0.25 + (rand() - 0.5) * 1.4 + c.vx * 0.1
            spawn.vy = 0.5 + rand() * 0.7
            spawn.vz = -fz * back * 0.25 + (rand() - 0.5) * 1.4 + c.vz * 0.1
            spawn.life = 0.9 + rand() * 0.6
            spawn.size = (front ? 0.3 : 0.45) + pace * 0.35
            spawn.sizeEnd = 1.4 + pace * 1.1
            spawn.alpha = (front ? 0.14 : 0.24) + pace * 0.2
            spawn.color = palette.stoneDust
            spawn.drag = 2.4
            spawn.gravity = -0.3
          } else {
            // ...or gravel flung back and out from under the tyre.
            spawn.vx = -fx * back * 0.7 + lx * outward * rand() * 2 + c.vx * 0.15
            spawn.vy = 1.4 + rand() * (2 + pace * 2)
            spawn.vz = -fz * back * 0.7 + lz * outward * rand() * 2 + c.vz * 0.15
            spawn.life = 0.35 + rand() * 0.3
            spawn.size = 0.08 + rand() * 0.07
            spawn.sizeEnd = 0.06
            spawn.alpha = 1
            spawn.color = rand() < 0.5 ? palette.dirtDark : palette.pebble
            spawn.drag = 1
            spawn.gravity = 15
          }
          emit(true)
        }
      }

      // The body rattles over the rough ground, harder with speed (picture only): a constant
      // shiver, and a kick each time a wheel finds a stone.
      if (c.grounded && c.surface === "stones" && speed > 1) {
        const k = 0.35 + pace * 0.65
        car.jolt((rand() - 0.5) * 1.4 * k, (rand() - 0.5) * 2.4 * k, (rand() - 0.5) * 2 * k)
        rattleClock += seconds * (3 + speed * 0.45)
        while (rattleClock >= 1) {
          rattleClock -= 0.6 + rand() * 0.8
          const side = rand() < 0.5 ? 1 : -1
          car.jolt((0.8 + rand() * 1.2) * k * 2.2, side * (2 + rand() * 3) * k, (1.5 + rand() * 2.5) * k)
        }
      } else {
        rattleClock = 0
      }
    }
  }
}

export type SurfaceFx = ReturnType<typeof createSurfaceFx>
