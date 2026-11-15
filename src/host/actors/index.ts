/**
 * Everything that moves: the car, the ghost, the props on the road and what happens when they
 * are hit, bollards, swing doors, boost pads, particles, skid marks and the under-bridge ring,
 * and what the car does to the ford, the meadow and the stony ground (`surfaces.ts`), where a
 * rock that throws the car (`bump`) knocks up dust, grit and chips and kicks the nose up.
 *
 * Reads `RaceView` once a frame and each `RaceEvent` as it comes; never touches the simulation.
 * Everything is built up front and pooled, so the per-frame path allocates almost nothing (the
 * one exception is `locateBelow`, which returns a fresh hit object; see `marker.ts`).
 */
import { Container3D, Mesh3D, Material3D, ConeGeometry } from "@pixi/3d"
import type { PropKind, RaceEvent, RaceView, TrackData } from "../../sim/index.ts"
import type { Actors, GhostPose, Stage } from "../contract.ts"
import { palette } from "../palette.ts"
import { createBollards } from "./bollards.ts"
import { createCar, createGhost } from "./car.ts"
import { createDoors } from "./doors.ts"
import { createFx } from "./fx.ts"
import { createHitLights } from "./lights.ts"
import { createMarker } from "./marker.ts"
import { createPads } from "./pads.ts"
import { createParticles, spawnRecord } from "./particles.ts"
import type { Spawn } from "./particles.ts"
import { random, rotate, vec } from "./pose.ts"
import { createProps } from "./props.ts"
import { puffTexture } from "./shapes.ts"
import { createSkids } from "./skids.ts"
import { createSurfaceFx } from "./surfaces.ts"

/** How a hit on each kind of thing feels: a cone is a tick, a ball a thud, a bollard a crack. */
interface Feel {
  /** Kick to the car's body per unit of strength. */
  readonly knock: number
  readonly dust: number
  readonly dustColor: number
  readonly chips: number
  readonly chipColor: number
  readonly chipColor2: number
  readonly chipSize: number
  readonly sparks: number
  /** How bright the hit light blinks per unit of strength. */
  readonly light: number
  /** How big the hit's flash is: 1 for paint and metal, less for dull stone. */
  readonly flash: number
  /** Impact, m/s, that counts as full strength. */
  readonly full: number
}

const FEEL: Record<PropKind | "bollard" | "door", Feel> = {
  cone: { knock: 0.12, dust: 2, dustColor: palette.dust, chips: 0, chipColor: palette.cone, chipColor2: palette.cone, chipSize: 0.06, sparks: 0, light: 0.15, flash: 1, full: 12 },
  crate: { knock: 0.6, dust: 6, dustColor: palette.dust, chips: 7, chipColor: palette.crateDark, chipColor2: palette.crate, chipSize: 0.11, sparks: 0, light: 0.5, flash: 1, full: 12 },
  barrel: { knock: 0.65, dust: 3, dustColor: palette.dust, chips: 2, chipColor: palette.barrelHoop, chipColor2: palette.barrel, chipSize: 0.07, sparks: 5, light: 0.6, flash: 1, full: 12 },
  ball: { knock: 1.15, dust: 10, dustColor: palette.dust, chips: 0, chipColor: palette.ballA, chipColor2: palette.ballB, chipSize: 0.06, sparks: 0, light: 0.55, flash: 1, full: 10 },
  bollard: { knock: 1.05, dust: 4, dustColor: palette.concrete, chips: 7, chipColor: palette.concreteDark, chipColor2: palette.hazardYellow, chipSize: 0.08, sparks: 4, light: 0.8, flash: 1, full: 12 },
  door: { knock: 0.5, dust: 3, dustColor: palette.dust, chips: 5, chipColor: palette.doorRed, chipColor2: palette.doorWhite, chipSize: 0.07, sparks: 0, light: 0.45, flash: 1, full: 12 }
}

export const createActors = (stage: Stage, track: TrackData): Actors => {
  const layer = new Container3D({ label: "actors", parent: stage.world })
  const particles = createParticles(layer, puffTexture())
  const spawn: Spawn = spawnRecord()
  const skids = createSkids(layer)
  const pads = createPads(layer, track, particles, spawn)
  const props = createProps(layer, track.props)
  const bollards = createBollards(layer, track.bollards)
  const doors = createDoors(layer, track.doors)
  const hitLights = createHitLights(layer)
  const ghost = createGhost(layer)
  const car = createCar(layer)
  const marker = createMarker(stage, track)
  const rand = random(11)
  const fx = createFx(particles, spawn, rand)
  const { flash, groundBurst, sparks } = fx
  const surfaces = createSurfaceFx(layer, track, car, particles, spawn, rand)

  // A short flame out of the back while boosting: an unlit cone that flickers, plus glow particles.
  const flameMaterial = new Material3D({ baseColor: palette.flame, alphaMode: "blend", alpha: 0.75, emissive: { color: palette.boost, strength: 1.5 } })
  const flame = new Mesh3D({
    geometry: new ConeGeometry({ radius: 0.16, height: 0.9, radialSegments: 12 }),
    material: flameMaterial,
    position: { x: 0, y: 0.32, z: -1.6 },
    // The cone points +Y; tip it back along -Z.
    rotation: { x: -Math.PI / 2, y: 0, z: 0 },
    castShadow: false,
    receiveShadow: false,
    visible: false,
    parent: car.model.body
  })

  const point = vec()
  const up = vec()
  let lastAttempt = -1
  let smokeClock = 0
  let flameClock = 0
  let flameOn = 0
  let launchClock = 0
  let streakClock = 0

  /**
   * What a hit looks like at (x, y, z): dust, chips, sparks, a flash, a blink of light, and,
   * when the car did it, a kick to the car's body toward the side it was hit on.
   */
  const strike = (feel: Feel, impact: number, x: number, y: number, z: number, view: RaceView, byCar: boolean): void => {
    const strength = Math.min(1, impact / feel.full)
    if (!byCar && strength < 0.15) return
    const scale = byCar ? 1 : 0.5
    const c = view.car
    const speed = Math.hypot(c.vx, c.vz)
    const dx = byCar && speed > 0.5 ? c.vx / speed : 0
    const dz = byCar && speed > 0.5 ? c.vz / speed : 0
    const dust = Math.round((1 + feel.dust * (0.4 + strength)) * scale)
    groundBurst(x, y, z, dust, 1 + strength * 2.5, 0.35 + strength * 0.35, feel.dustColor, 0.3 + strength * 0.3)
    const chips = Math.round(feel.chips * (0.3 + strength) * scale)
    if (chips > 0) {
      fx.chips(x, y + 0.3, z, Math.ceil(chips / 2), dx, dz, 2 + strength * 4, feel.chipSize, feel.chipColor)
      fx.chips(x, y + 0.3, z, Math.floor(chips / 2), dx, dz, 2 + strength * 4, feel.chipSize, feel.chipColor2)
    }
    const sparkCount = Math.round(feel.sparks * strength * scale)
    if (sparkCount > 0) sparks(x, y + 0.4, z, sparkCount, c.vx * 0.4, c.vz * 0.4)
    flash(x, y + 0.5, z, (0.35 + strength * 0.7) * scale * feel.flash, palette.spark)
    if (feel.light * strength * scale > 0.08) hitLights.blink(x, y, z, feel.light * strength * scale)
    if (byCar) {
      // Left of the car is (cos yaw, -sin yaw): a hit on the left rolls the body to the right.
      const left = (x - c.x) * Math.cos(c.yaw) - (z - c.z) * Math.sin(c.yaw)
      const side = left > 0.15 ? 1 : left < -0.15 ? -1 : rand() < 0.5 ? 1 : -1
      car.knock(side * feel.knock * (0.25 + strength))
      if (feel === FEEL.ball) car.land(impact * 0.35)
    }
  }

  /**
   * The car thrown off a rock at (x, y, z): a dull knock where the tyre struck (a low cloud of
   * dust, grit and stone chips thrown on ahead, a small dim flash), and the nose kicks up.
   */
  const rockKnock = (x: number, y: number, z: number, speed: number, view: RaceView): void => {
    const strength = Math.min(1, Math.max(0, (speed - 6) / 18))
    const c = view.car
    const moving = Math.hypot(c.vx, c.vz)
    const dx = moving > 0.5 ? c.vx / moving : 0
    const dz = moving > 0.5 ? c.vz / moving : 0
    groundBurst(x + dx * 0.4, y, z + dz * 0.4, Math.round(14 + strength * 16), 1.8 + strength * 2.8, 0.55 + strength * 0.35, palette.stoneDust, 0.55 + strength * 0.25)
    fx.chips(x, y + 0.25, z, Math.round(5 + strength * 6), dx, dz, 3 + strength * 5, 0.18, palette.rockLight)
    fx.chips(x, y + 0.2, z, Math.round(6 + strength * 8), dx, dz, 2.5 + strength * 4, 0.11, palette.dirtDark)
    fx.chips(x, y + 0.2, z, Math.round(4 + strength * 5), dx, dz, 2 + strength * 4, 0.14, palette.rock)
    flash(x, y + 0.35, z, 0.35 + strength * 0.35, palette.stoneDust)
    car.hop(strength)
  }

  /** Everything back where it stood: props, bollards, doors, lights. */
  const restore = (): void => {
    props.reset()
    bollards.reset()
    doors.reset()
    hitLights.reset()
  }

  /** The car pops in at the start line: a scale-in, fresh skid strips, a little puff. */
  const popIn = (view: RaceView): void => {
    car.popIn()
    skids.cut()
    surfaces.cut()
    restore()
    groundBurst(view.car.x, view.car.y, view.car.z, 10, 1.6, 0.5, palette.smoke, 0.5)
  }

  return {
    handle(event: RaceEvent, view: RaceView) {
      switch (event.kind) {
        case "land": {
          const strength = Math.min(1, event.impact / 10)
          groundBurst(event.x, event.y, event.z, Math.round(6 + strength * 16), 2 + strength * 4, 0.5 + strength * 0.5, palette.dust, 0.35 + strength * 0.35)
          car.land(event.impact)
          break
        }
        case "wall": {
          const strength = Math.min(1, event.impact / 10)
          sparks(event.x, event.y + 0.4, event.z, Math.round(4 + strength * 14), view.car.vx, view.car.vz)
          groundBurst(event.x, event.y, event.z, Math.round(2 + strength * 5), 1.2, 0.4, palette.dust, 0.45)
          car.knock((event.side === "left" ? 1 : -1) * (0.4 + strength * 1.2))
          flash(event.x, event.y + 0.5, event.z, 0.7 + strength * 0.9, palette.spark)
          if (strength > 0.2) hitLights.blink(event.x, event.y, event.z, strength * 0.6)
          break
        }
        case "boost": {
          pads.flash(event.index)
          car.surge()
          // A ring of light thrown back off the pad.
          const fx = Math.sin(view.car.yaw)
          const fz = Math.cos(view.car.yaw)
          for (let n = 0; n < 18; n++) {
            const side = (n / 17 - 0.5) * 2
            spawn.x = view.car.x - fz * side * 0.9
            spawn.y = view.car.y + 0.25
            spawn.z = view.car.z + fx * side * 0.9
            spawn.vx = -fx * (6 + rand() * 6) - fz * side * 5
            spawn.vy = 0.6 + rand() * 1.5
            spawn.vz = -fz * (6 + rand() * 6) + fx * side * 5
            spawn.life = 0.3 + rand() * 0.2
            spawn.size = 0.5
            spawn.sizeEnd = 0.1
            spawn.alpha = 0.9
            spawn.color = rand() < 0.4 ? palette.flame : palette.boost
            spawn.drag = 2.5
            spawn.gravity = 0
            particles.glow.emit(spawn)
          }
          break
        }
        case "reset":
          // A puff where the car went off, then the car pops in at the line.
          groundBurst(event.x, event.y, event.z, 18, 3, 0.9, palette.smoke, 0.7)
          popIn(view)
          lastAttempt = view.lap.attempt
          break
        case "prop": {
          const kind = props.hit(event.index, event.impact, view.car.x, view.car.z, view)
          strike(FEEL[kind ?? event.prop], event.impact, event.x, event.y, event.z, view, true)
          break
        }
        case "knock": {
          const kind = props.knock(event.index, event.impact, event.x, event.z, view)
          strike(FEEL[kind ?? event.prop], event.impact, event.x, event.y, event.z, view, false)
          break
        }
        case "bollard":
          bollards.hit(event.index, event.impact, view.car.x, view.car.z)
          strike(FEEL.bollard, event.impact, event.x, event.y, event.z, view, true)
          break
        case "bump":
          rockKnock(event.x, event.y, event.z, event.speed, view)
          break
        case "door":
          doors.hit(event.index, event.impact, view.car.vx, view.car.vz)
          strike(FEEL.door, event.impact, event.x, event.y, event.z, view, true)
          break
        case "takeoff":
          // Dust thrown off the lip.
          groundBurst(event.x, event.y - 0.3, event.z, 8, 2.5, 0.45, palette.dust, 0.4)
          break
        case "start":
        case "checkpoint":
        case "finish":
          break
      }
    },

    update(view: RaceView, ghostPose: GhostPose | null, seconds: number) {
      const dt = Math.min(Math.max(seconds, 0), 0.05)
      if (view.lap.attempt !== lastAttempt) {
        lastAttempt = view.lap.attempt
        popIn(view)
      }
      const c = view.car
      car.update(c, dt)
      ghost.update(ghostPose, dt)
      skids.update(c)
      surfaces.update(view, dt)

      // Pulling away: the rear wheels spin and throw dust and grit back until the car is moving.
      const launch = c.grounded && c.throttle > 0.5 && c.speed >= 0 && c.speed < 13 ? (1 - c.speed / 13) * c.throttle : 0
      if (launch > 0) {
        launchClock += dt * (18 + launch * 50)
        const fx = Math.sin(c.yaw)
        const fz = Math.cos(c.yaw)
        while (launchClock >= 1) {
          launchClock -= 1
          rotate(c.yaw, c.pitch, c.roll, rand() < 0.5 ? 0.55 : -0.55, 0.12, -0.9, point)
          const grit = rand() < 0.35
          spawn.x = c.x + point.x
          spawn.y = c.y + point.y
          spawn.z = c.z + point.z
          spawn.vx = -fx * (grit ? 7 + rand() * 5 : 2 + rand() * 2) + (rand() - 0.5) * 1.5
          spawn.vy = grit ? 2 + rand() * 2.5 : 0.5 + rand() * 0.7
          spawn.vz = -fz * (grit ? 7 + rand() * 5 : 2 + rand() * 2) + (rand() - 0.5) * 1.5
          spawn.life = grit ? 0.35 + rand() * 0.2 : 0.7 + rand() * 0.5
          spawn.size = grit ? 0.14 : 0.4 + launch * 0.3
          spawn.sizeEnd = grit ? 0.08 : 1.6 + launch * 0.8
          spawn.alpha = grit ? 0.9 : 0.25 + launch * 0.3
          spawn.color = grit ? palette.earthDark : palette.smoke
          spawn.drag = grit ? 1 : 2.4
          spawn.gravity = grit ? 14 : -0.4
          particles.soft.emit(spawn)
        }
      } else {
        launchClock = 0
      }

      // At speed, pale streaks trail off the car's corners; more of them, and blue, on boost.
      const fast = Math.max(0, (Math.abs(c.speed) - 22) / 9)
      if (fast > 0) {
        streakClock += dt * (10 + fast * 45 + (c.boosting ? 40 : 0))
        while (streakClock >= 1) {
          streakClock -= 1
          rotate(c.yaw, c.pitch, c.roll, rand() < 0.5 ? 0.62 : -0.62, 0.25 + rand() * 0.45, -1 + rand() * 0.4, point)
          spawn.x = c.x + point.x
          spawn.y = c.y + point.y
          spawn.z = c.z + point.z
          spawn.vx = c.vx * 0.25
          spawn.vy = 0
          spawn.vz = c.vz * 0.25
          spawn.life = 0.16 + rand() * 0.14
          spawn.size = 0.22
          spawn.sizeEnd = 0.05
          spawn.alpha = c.boosting ? 0.75 : 0.3 + fast * 0.25
          spawn.color = c.boosting ? palette.boost : palette.smoke
          spawn.drag = 0
          spawn.gravity = 0
          if (c.boosting) particles.glow.emit(spawn)
          else particles.soft.emit(spawn)
        }
      } else {
        streakClock = 0
      }

      // Tyre smoke from the rear wheels while sliding on the ground.
      const smoke = c.grounded ? Math.max(0, (c.slip - 0.28) / 0.72) : 0
      if (smoke > 0) {
        smokeClock += dt * (10 + smoke * 40)
        rotate(c.yaw, c.pitch, c.roll, 0, 1, 0, up)
        while (smokeClock >= 1) {
          smokeClock -= 1
          const side = rand() < 0.5 ? 0.55 : -0.55
          rotate(c.yaw, c.pitch, c.roll, side, 0.15, -0.8, point)
          spawn.x = c.x + point.x
          spawn.y = c.y + point.y
          spawn.z = c.z + point.z
          spawn.vx = c.vx * 0.15 + (rand() - 0.5) * 1.2 + up.x
          spawn.vy = 0.5 + rand() * 0.6
          spawn.vz = c.vz * 0.15 + (rand() - 0.5) * 1.2 + up.z
          spawn.life = 0.9 + rand() * 0.6
          spawn.size = 0.45 + smoke * 0.3
          spawn.sizeEnd = 1.8 + smoke * 0.8
          spawn.alpha = 0.3 + smoke * 0.35
          spawn.color = palette.smoke
          spawn.drag = 2.2
          spawn.gravity = -0.5
          particles.soft.emit(spawn)
        }
      } else {
        smokeClock = 0
      }

      // Boost flame: the cone flickers in, glow particles stream out behind.
      flameOn = Math.max(0, Math.min(1, flameOn + (c.boosting ? dt * 10 : -dt * 6)))
      flame.visible = flameOn > 0
      if (flameOn > 0) {
        const flicker = 0.8 + rand() * 0.4
        flame.scale.set(flameOn * 0.9, flameOn * flicker * 1.1, flameOn * 0.9)
        flame.position.z = -1.2 - 0.45 * flameOn * flicker
      }
      if (c.boosting) {
        flameClock += dt * 60
        while (flameClock >= 1) {
          flameClock -= 1
          rotate(c.yaw, c.pitch, c.roll, (rand() - 0.5) * 0.3, 0.32, -1.5, point)
          const fx = Math.sin(c.yaw)
          const fz = Math.cos(c.yaw)
          spawn.x = c.x + point.x
          spawn.y = c.y + point.y
          spawn.z = c.z + point.z
          spawn.vx = c.vx * 0.6 - fx * 5 + (rand() - 0.5)
          spawn.vy = (rand() - 0.2) * 0.8
          spawn.vz = c.vz * 0.6 - fz * 5 + (rand() - 0.5)
          spawn.life = 0.22 + rand() * 0.12
          spawn.size = 0.55
          spawn.sizeEnd = 0.12
          spawn.alpha = 0.8
          spawn.color = rand() < 0.35 ? palette.flame : palette.boost
          spawn.drag = 2
          spawn.gravity = 0
          particles.glow.emit(spawn)
        }
      } else {
        flameClock = 0
      }

      props.update(view, dt)
      bollards.update(dt)
      doors.update(view.doors, dt)
      hitLights.update(dt)
      pads.update(dt)
      particles.step(dt)
      marker.update(c, dt)
    }
  }
}
