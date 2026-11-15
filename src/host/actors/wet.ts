/**
 * Wet tyre tracks: the film of water a wheel leaves on the road after it has been through the ford.
 *
 * Built like the skid marks (`skids.ts`): one dynamic mesh holding a ring of quads, each wheel
 * laying a strip of quads joined end to end. A wheel that leaves the water is fully wet and
 * dries as it rolls, so its strip fades out along the next `DRY_DISTANCE` metres; every quad
 * also remembers when it was laid and dries away on the road over several seconds, its alpha
 * rewritten each frame while any are left. Each wheel keeps its own wetness, so a car with
 * only its right wheels in the pool leaves two tracks. The marks are the water's own pale
 * colour, not a darker road: dark on dark asphalt they could hardly be seen from the camera's
 * height, and a wet road seen from above shows the sky.
 */
import { Geometry3D, Material3D, Mesh3D, srgbToLinear } from "@pixi/3d"
import type { Container3D } from "@pixi/3d"
import type { CarView } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { WHEELS } from "./car.ts"
import { rotate, vec } from "./pose.ts"

/** Most quads kept; the oldest goes first. */
const QUADS = 1600
/** A new quad every this many metres of travel. */
const STEP = 0.35
const HALF_WIDTH = 0.24
const LIFT = 0.055
/** Metres of road a tyre needs to dry. */
const DRY_DISTANCE = 28
/** A mark holds for `HOLD` seconds, then dries away over `DRY` more. */
const HOLD = 6
const DRY = 7
/** How solid a fresh mark is. */
const STRENGTH = 0.62

interface Trail {
  active: boolean
  /** 1 just out of the water, 0 dry. */
  wet: number
  lx: number
  ly: number
  lz: number
  rx: number
  ry: number
  rz: number
  cx: number
  cz: number
  alpha: number
}

export const createWetTracks = (parent: Container3D) => {
  const positions = new Float32Array(QUADS * 4 * 3)
  const normals = new Float32Array(QUADS * 4 * 3)
  const colors = new Float32Array(QUADS * 4 * 4)
  const indices = new Uint16Array(QUADS * 6)
  for (let q = 0; q < QUADS; q++) {
    const v = q * 4
    indices.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], q * 6)
    for (let k = 0; k < 4; k++) normals[(v + k) * 3 + 1] = 1
  }
  const geometry = new Geometry3D({ positions, normals, colors, indices, dynamic: true, quantizeNormals: false })
  const material = new Material3D({ baseColor: 0xffffff, vertexColors: true, alphaMode: "blend", roughness: 0.75, doubleSided: true })
  new Mesh3D({ geometry, material, castShadow: false, receiveShadow: true, parent, label: "wet tracks" })
  // The geometry may keep its own copies; write to whatever it draws from.
  const drawn = geometry.positions instanceof Float32Array ? geometry.positions : positions
  const colorBuffer = geometry.attributes["aColor"]?.buffer
  const drawnColors = colorBuffer !== undefined && colorBuffer.data instanceof Float32Array ? colorBuffer.data : colors
  const [r, g, b] = [(palette.wetTrack >> 16) & 255, (palette.wetTrack >> 8) & 255, palette.wetTrack & 255].map((c) => srgbToLinear(c / 255)) as [number, number, number]
  for (let v = 0; v < QUADS * 4; v++) {
    drawnColors[v * 4] = r
    drawnColors[v * 4 + 1] = g
    drawnColors[v * 4 + 2] = b
  }

  /** Per quad: when it was laid (-1: free) and its two ends' alphas when fresh. */
  const born = new Float32Array(QUADS).fill(-1)
  const startAlpha = new Float32Array(QUADS)
  const endAlpha = new Float32Array(QUADS)
  const trails: Array<Trail> = WHEELS.map(() => ({ active: false, wet: 0, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, cx: 0, cz: 0, alpha: 0 }))
  const centre = vec()
  const side = vec()
  const up = vec()
  let cursor = 0
  let live = 0
  let clock = 0
  let moved = false

  const place = (vertex: number, x: number, y: number, z: number): void => {
    drawn[vertex * 3] = x
    drawn[vertex * 3 + 1] = y
    drawn[vertex * 3 + 2] = z
  }

  return {
    /** Breaks every strip and dries every tyre: the car jumped in place. */
    cut() {
      for (const trail of trails) {
        trail.active = false
        trail.wet = 0
      }
    },
    /** `wheelIn[w]` is true while wheel `w` (in `WHEELS` order) is in the water. */
    update(car: CarView, wheelIn: ReadonlyArray<boolean>, seconds: number) {
      clock += seconds
      rotate(car.yaw, car.pitch, car.roll, 0, 1, 0, up)
      rotate(car.yaw, car.pitch, car.roll, HALF_WIDTH, 0, 0, side)
      for (let w = 0; w < WHEELS.length; w++) {
        const trail = trails[w]
        const wheel = WHEELS[w]
        if (trail === undefined || wheel === undefined) continue
        if (wheelIn[w] === true) {
          trail.wet = 1
          trail.active = false
          continue
        }
        if (trail.wet <= 0 || !car.grounded) {
          trail.active = false
          continue
        }
        rotate(car.yaw, car.pitch, car.roll, wheel[0], 0, wheel[1], centre)
        const cx = car.x + centre.x + up.x * LIFT
        const cy = car.y + centre.y + up.y * LIFT
        const cz = car.z + centre.z + up.z * LIFT
        // Fades in over the first quad, so the strip does not start on a hard edge at the shore.
        const alpha = STRENGTH * Math.pow(trail.wet, 0.6)
        if (!trail.active) {
          trail.active = true
          trail.lx = cx + side.x
          trail.ly = cy + side.y
          trail.lz = cz + side.z
          trail.rx = cx - side.x
          trail.ry = cy - side.y
          trail.rz = cz - side.z
          trail.cx = cx
          trail.cz = cz
          trail.alpha = alpha * 0.3
          continue
        }
        const distance = Math.hypot(cx - trail.cx, cz - trail.cz)
        if (distance > 4) {
          trail.active = false
          continue
        }
        if (distance < STEP) continue
        trail.wet = Math.max(0, trail.wet - distance / DRY_DISTANCE)
        const q = cursor
        cursor = (cursor + 1) % QUADS
        if (born[q]! < 0) live++
        born[q] = clock
        startAlpha[q] = trail.alpha
        endAlpha[q] = alpha
        const v = q * 4
        place(v, trail.lx, trail.ly, trail.lz)
        place(v + 1, trail.rx, trail.ry, trail.rz)
        trail.lx = cx + side.x
        trail.ly = cy + side.y
        trail.lz = cz + side.z
        trail.rx = cx - side.x
        trail.ry = cy - side.y
        trail.rz = cz - side.z
        trail.cx = cx
        trail.cz = cz
        trail.alpha = alpha
        place(v + 2, trail.lx, trail.ly, trail.lz)
        place(v + 3, trail.rx, trail.ry, trail.rz)
        moved = true
      }
      if (live === 0) return
      // Every mark dries on the road: hold, then fade.
      for (let q = 0; q < QUADS; q++) {
        const at = born[q]!
        if (at < 0) continue
        const age = clock - at
        const left = age < HOLD ? 1 : Math.max(0, 1 - (age - HOLD) / DRY)
        if (left === 0) {
          born[q] = -1
          live--
        }
        const a = startAlpha[q]! * left
        const e = endAlpha[q]! * left
        const v = q * 4
        drawnColors[v * 4 + 3] = a
        drawnColors[(v + 1) * 4 + 3] = a
        drawnColors[(v + 2) * 4 + 3] = e
        drawnColors[(v + 3) * 4 + 3] = e
      }
      colorBuffer?.update()
      if (moved) {
        geometry.attributes["aPosition"]?.buffer.update()
        moved = false
      }
    }
  }
}

export type WetTracks = ReturnType<typeof createWetTracks>
