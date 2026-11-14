/**
 * One-shot particle effects shared by every hit: a flash, a ring of dust, sparks and chips.
 * Each writes into the one scratch spawn record, so none of them allocates.
 */
import { palette } from "../palette.ts"
import type { Particles, Spawn } from "./particles.ts"

export const createFx = (particles: Particles, spawn: Spawn, rand: () => number) => {
  /** A short bright flash where something was hit. */
  const flash = (x: number, y: number, z: number, size: number, color: number): void => {
    spawn.x = x
    spawn.y = y
    spawn.z = z
    spawn.vx = 0
    spawn.vy = 0
    spawn.vz = 0
    spawn.life = 0.12
    spawn.size = size
    spawn.sizeEnd = size * 2.2
    spawn.alpha = 0.9
    spawn.color = color
    spawn.drag = 0
    spawn.gravity = 0
    particles.glow.emit(spawn)
  }

  /** A ring of puffs on the ground: landing dust, the reset puff, a shove. */
  const groundBurst = (x: number, y: number, z: number, count: number, speed: number, size: number, color: number, alpha: number): void => {
    for (let n = 0; n < count; n++) {
      const a = rand() * Math.PI * 2
      const v = speed * (0.25 + rand() * 0.9)
      const r = rand() * 0.9
      spawn.x = x + Math.cos(a) * r
      spawn.y = y + 0.15 + rand() * 0.3
      spawn.z = z + Math.sin(a) * r
      spawn.vx = Math.cos(a) * v
      spawn.vy = 0.4 + rand() * 0.8
      spawn.vz = Math.sin(a) * v
      spawn.life = 0.8 + rand() * 0.6
      spawn.size = size * (0.7 + rand() * 0.5)
      spawn.sizeEnd = size * 2.4
      spawn.alpha = alpha
      spawn.color = color
      spawn.drag = 3
      spawn.gravity = -0.4
      particles.soft.emit(spawn)
    }
  }

  const sparks = (x: number, y: number, z: number, count: number, vx: number, vz: number): void => {
    for (let n = 0; n < count; n++) {
      spawn.x = x
      spawn.y = y
      spawn.z = z
      spawn.vx = vx * 0.5 + (rand() - 0.5) * 8
      spawn.vy = 2 + rand() * 4
      spawn.vz = vz * 0.5 + (rand() - 0.5) * 8
      spawn.life = 0.25 + rand() * 0.3
      spawn.size = 0.16 + rand() * 0.1
      spawn.sizeEnd = 0.04
      spawn.alpha = 1
      spawn.color = palette.spark
      spawn.drag = 1.5
      spawn.gravity = 16
      particles.glow.emit(spawn)
    }
  }

  /**
   * Small hard bits knocked off a surface (splinters, paint, concrete grit): thrown up and along
   * `(dx, dz)`, they fall and fade. Nothing big ever breaks off.
   */
  const chips = (x: number, y: number, z: number, count: number, dx: number, dz: number, speed: number, size: number, color: number): void => {
    for (let n = 0; n < count; n++) {
      spawn.x = x + (rand() - 0.5) * 0.3
      spawn.y = y + rand() * 0.3
      spawn.z = z + (rand() - 0.5) * 0.3
      spawn.vx = dx * speed * (0.4 + rand() * 0.8) + (rand() - 0.5) * speed
      spawn.vy = 2 + rand() * 3
      spawn.vz = dz * speed * (0.4 + rand() * 0.8) + (rand() - 0.5) * speed
      spawn.life = 0.45 + rand() * 0.35
      spawn.size = size * (0.7 + rand() * 0.6)
      spawn.sizeEnd = size * 0.6
      spawn.alpha = 1
      spawn.color = color
      spawn.drag = 0.8
      spawn.gravity = 15
      particles.soft.emit(spawn)
    }
  }

  return { flash, groundBurst, sparks, chips }
}

export type Fx = ReturnType<typeof createFx>
