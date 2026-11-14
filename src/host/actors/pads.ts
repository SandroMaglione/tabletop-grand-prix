/**
 * Boost pads: a dark plate on the road with three glowing chevrons that chase toward the
 * direction of travel. A pad flashes, and throws a ring of sparks, when the car takes it.
 */
import { Container3D, Material3D, Mesh3D, PlaneGeometry } from "@pixi/3d"
import type { TrackData } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import type { Particles, Spawn } from "./particles.ts"
import { random } from "./pose.ts"
import { chevron } from "./shapes.ts"

const CHEVRONS = 3
const LIFT = 0.035

export const createPads = (parent: Container3D, track: TrackData, particles: Particles, spawn: Spawn) => {
  const plateGeometry = new PlaneGeometry({ width: 1, height: 1 })
  // One material per chevron place, shared by every pad, so the chase is three writes a frame.
  const chevronMaterials = Array.from({ length: CHEVRONS }, () => new Material3D({ baseColor: palette.boost, roughness: 0.4, doubleSided: true, emissive: { color: palette.boost, strength: 0.5 } }))
  const pads = track.boosts.map((pad) => {
    const root = new Container3D({ position: { x: pad.x, y: pad.y, z: pad.z }, rotation: { x: 0, y: pad.yaw, z: 0 }, parent, label: "boost" })
    const tilt = new Container3D({ rotation: { x: -pad.pitch, y: 0, z: 0 }, parent: root })
    const plateMaterial = new Material3D({ baseColor: palette.boostPlate, roughness: 0.6, emissive: { color: palette.boost, strength: 0 } })
    new Mesh3D({
      geometry: plateGeometry,
      material: plateMaterial,
      position: { x: 0, y: LIFT, z: 0 },
      rotation: { x: -Math.PI / 2, y: 0, z: 0 },
      scale: { x: pad.width, y: pad.length, z: 1 },
      castShadow: false,
      receiveShadow: true,
      parent: tilt
    })
    const shape = chevron(pad.width * 0.7, Math.min(pad.length / CHEVRONS, pad.width * 0.45), Math.min(0.45, pad.length / (CHEVRONS * 3)))
    for (let k = 0; k < CHEVRONS; k++) {
      const material = chevronMaterials[k]
      if (material === undefined) continue
      new Mesh3D({ geometry: shape, material, position: { x: 0, y: LIFT * 2, z: (pad.length * (k + 0.5)) / CHEVRONS - pad.length / 2 }, castShadow: false, receiveShadow: true, parent: tilt })
    }
    return { pad, plateMaterial, flash: 0 }
  })
  const rand = random(5)
  let time = 0
  return {
    /** The car took pad `index`. */
    flash(index: number) {
      const entry = pads[index]
      if (entry === undefined) return
      entry.flash = 1
      const { pad } = entry
      // Speed lines: streaks rising off the whole plate and racing ahead along the pad.
      for (let n = 0; n < 30; n++) {
        const forward = (rand() - 0.5) * pad.length
        const across = (rand() - 0.5) * pad.width
        const fx = Math.sin(pad.yaw)
        const fz = Math.cos(pad.yaw)
        const ahead = 6 + rand() * 8
        spawn.x = pad.x + fx * forward + Math.cos(pad.yaw) * across
        spawn.y = pad.y + 0.1 + rand() * 0.3
        spawn.z = pad.z + fz * forward - Math.sin(pad.yaw) * across
        spawn.vx = fx * ahead
        spawn.vy = 0.5 + rand() * 1.5
        spawn.vz = fz * ahead
        spawn.life = 0.3 + rand() * 0.2
        spawn.size = 0.35 + rand() * 0.2
        spawn.sizeEnd = 0.08
        spawn.alpha = 0.9
        spawn.color = n % 4 === 0 ? palette.flame : palette.boost
        spawn.drag = 3
        spawn.gravity = 0
        particles.glow.emit(spawn)
      }
    },
    update(seconds: number) {
      time += seconds
      for (let k = 0; k < CHEVRONS; k++) {
        const material = chevronMaterials[k]
        if (material?.emissive === undefined) continue
        const wave = Math.max(0, Math.sin(time * 7 - k * 1.3))
        material.emissive.strength = 0.35 + wave * wave * 1.1
      }
      for (const entry of pads) {
        if (entry.flash <= 0) continue
        entry.flash = Math.max(0, entry.flash - seconds * 2.5)
        if (entry.plateMaterial.emissive !== undefined) entry.plateMaterial.emissive.strength = entry.flash * 1.6
      }
    }
  }
}

export type Pads = ReturnType<typeof createPads>
