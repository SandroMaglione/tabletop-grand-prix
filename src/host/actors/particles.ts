/**
 * Smoke, dust, sparks and flame, as hand-driven particles.
 *
 * One `ParticleContainer3D` per blend: `soft` (normal blending: smoke, dust, puffs) and `glow`
 * (additive: sparks, boost flame, pad flash). The motion is simulated here in flat typed arrays,
 * stepped from the frame's own `seconds` and uploaded once a frame, so effects follow the game's
 * clock (and a paused or slowed page) rather than `Ticker.shared`, and nothing is allocated per
 * particle. A full pool overwrites its oldest particle.
 */
import { ParticleContainer3D } from "@pixi/3d"
import type { Container3D } from "@pixi/3d"
import type { Texture } from "pixi.js"

export interface Spawn {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Seconds. */
  life: number
  /** World-space diameter at birth and at death. */
  size: number
  sizeEnd: number
  alpha: number
  color: number
  /** Velocity lost per second, as a fraction. */
  drag: number
  /** Downward pull, metres per second squared; negative rises. */
  gravity: number
}

/** A scratch spawn record to fill and pass to `emit`, so callers allocate nothing. */
export const spawnRecord = (): Spawn => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 0.5, sizeEnd: 1, alpha: 1, color: 0xffffff, drag: 0, gravity: 0 })

export interface ParticlePool {
  emit(spawn: Spawn): void
  step(seconds: number): void
  clear(): void
}

const FLOATS = 14

const createPool = (parent: Container3D, texture: Texture, capacity: number, blendMode: "normal" | "add"): ParticlePool => {
  const container = new ParticleContainer3D({ texture, capacity, blendMode, billboard: "spherical", parent })
  // Per slot: x y z vx vy vz age life size sizeEnd alpha drag gravity spin.
  const state = new Float32Array(capacity * FLOATS)
  const colors = new Uint32Array(capacity)
  const alive = new Uint8Array(capacity)
  let next = 0
  let live = 0
  let dirty = false
  return {
    emit(p) {
      const i = next
      next = (next + 1) % capacity
      if (alive[i] === 0) live++
      alive[i] = 1
      const o = i * FLOATS
      state[o] = p.x
      state[o + 1] = p.y
      state[o + 2] = p.z
      state[o + 3] = p.vx
      state[o + 4] = p.vy
      state[o + 5] = p.vz
      state[o + 6] = 0
      state[o + 7] = Math.max(0.01, p.life)
      state[o + 8] = p.size
      state[o + 9] = p.sizeEnd
      state[o + 10] = p.alpha
      state[o + 11] = p.drag
      state[o + 12] = p.gravity
      state[o + 13] = (i * 2.399) % (Math.PI * 2)
      colors[i] = p.color
    },
    step(seconds) {
      if (live === 0 && !dirty) return
      const dt = Math.min(seconds, 0.05)
      for (let i = 0; i < capacity; i++) {
        if (alive[i] === 0) continue
        const o = i * FLOATS
        const age = (state[o + 6] ?? 0) + dt
        const life = state[o + 7] ?? 1
        if (age >= life) {
          alive[i] = 0
          live--
          container.setParticleAt(i, 0, -1000, 0, 0)
          continue
        }
        state[o + 6] = age
        const keep = Math.max(0, 1 - (state[o + 11] ?? 0) * dt)
        const vx = (state[o + 3] ?? 0) * keep
        const vy = ((state[o + 4] ?? 0) - (state[o + 12] ?? 0) * dt) * keep
        const vz = (state[o + 5] ?? 0) * keep
        state[o + 3] = vx
        state[o + 4] = vy
        state[o + 5] = vz
        const x = (state[o] ?? 0) + vx * dt
        const y = (state[o + 1] ?? 0) + vy * dt
        const z = (state[o + 2] ?? 0) + vz * dt
        state[o] = x
        state[o + 1] = y
        state[o + 2] = z
        const t = age / life
        const size = (state[o + 8] ?? 0) + ((state[o + 9] ?? 0) - (state[o + 8] ?? 0)) * t
        // Quick fade-in, slow fade-out.
        const fade = Math.min(1, t * 8) * (1 - t) * (1 - t)
        container.setParticleAt(i, x, y, z, size, state[o + 13] ?? 0, colors[i] ?? 0xffffff, (state[o + 10] ?? 1) * fade)
      }
      container.upload()
      dirty = live > 0
    },
    clear() {
      alive.fill(0)
      live = 0
      container.clear()
      container.upload()
    }
  }
}

export interface Particles {
  readonly soft: ParticlePool
  readonly glow: ParticlePool
  step(seconds: number): void
}

export const createParticles = (parent: Container3D, texture: Texture): Particles => {
  const soft = createPool(parent, texture, 700, "normal")
  const glow = createPool(parent, texture, 500, "add")
  return {
    soft,
    glow,
    step(seconds) {
      soft.step(seconds)
      glow.step(seconds)
    }
  }
}
