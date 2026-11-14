/**
 * Skid marks: dark strips left by sliding tyres, for the whole session.
 *
 * One dynamic mesh holds a ring of quads. Each wheel that slides on the ground lays a strip of
 * quads joined end to end; when the ring is full the oldest quad is written over. The strip sits
 * a few centimetres above the road along the car's own up, so it follows slopes and banks.
 * Strength rides in the vertex alpha, so a light slide leaves a faint mark.
 */
import { Geometry3D, Material3D, Mesh3D } from "@pixi/3d"
import type { Container3D } from "@pixi/3d"
import { srgbToLinear } from "@pixi/3d"
import type { CarView } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { WHEELS } from "./car.ts"
import { rotate, vec } from "./pose.ts"

/** Most quads kept; the oldest goes first. */
const QUADS = 4000
/** A new quad every this many metres of travel. */
const STEP = 0.3
const HALF_WIDTH = 0.11
const LIFT = 0.06
/** Below this slip nothing is left. */
const THRESHOLD = 0.3

interface Trail {
  active: boolean
  // Where the strip's last edge is, both sides.
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

export const createSkids = (parent: Container3D) => {
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
  const material = new Material3D({ baseColor: 0xffffff, vertexColors: true, alphaMode: "blend", roughness: 0.95, doubleSided: true })
  new Mesh3D({ geometry, material, castShadow: false, receiveShadow: true, parent, label: "skids" })
  // The geometry may keep its own copies; write to whatever it draws from.
  const drawn = geometry.positions instanceof Float32Array ? geometry.positions : positions
  const colorBuffer = geometry.attributes["aColor"]?.buffer
  const drawnColors = colorBuffer !== undefined && colorBuffer.data instanceof Float32Array ? colorBuffer.data : colors

  const [r, g, b] = [(palette.skid >> 16) & 255, (palette.skid >> 8) & 255, palette.skid & 255].map((c) => srgbToLinear(c / 255)) as [number, number, number]
  const trails: Array<Trail> = WHEELS.map(() => ({ active: false, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, cx: 0, cz: 0, alpha: 0 }))
  const centre = vec()
  const side = vec()
  const up = vec()
  let cursor = 0
  let changed = false

  const writeVertex = (vertex: number, x: number, y: number, z: number, alpha: number): void => {
    drawn[vertex * 3] = x
    drawn[vertex * 3 + 1] = y
    drawn[vertex * 3 + 2] = z
    drawnColors[vertex * 4] = r
    drawnColors[vertex * 4 + 1] = g
    drawnColors[vertex * 4 + 2] = b
    drawnColors[vertex * 4 + 3] = alpha
  }

  return {
    /** Breaks every strip, so the next mark does not join across a jump in place. */
    cut() {
      for (const trail of trails) trail.active = false
    },
    update(car: CarView) {
      const sliding = car.grounded ? (car.slip - THRESHOLD) / (1 - THRESHOLD) : 0
      rotate(car.yaw, car.pitch, car.roll, 0, 1, 0, up)
      rotate(car.yaw, car.pitch, car.roll, HALF_WIDTH, 0, 0, side)
      for (let w = 0; w < WHEELS.length; w++) {
        const trail = trails[w]
        const wheel = WHEELS[w]
        if (trail === undefined || wheel === undefined) continue
        // Rear tyres mark first; fronts only in a hard slide.
        const strength = w < 2 ? sliding * 1.6 - 0.6 : sliding
        if (strength <= 0) {
          trail.active = false
          continue
        }
        rotate(car.yaw, car.pitch, car.roll, wheel[0], 0, wheel[1], centre)
        const cx = car.x + centre.x + up.x * LIFT
        const cy = car.y + centre.y + up.y * LIFT
        const cz = car.z + centre.z + up.z * LIFT
        const alpha = Math.min(1, strength) * 0.6
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
          trail.alpha = 0
          continue
        }
        const dx = cx - trail.cx
        const dz = cz - trail.cz
        const distance = Math.hypot(dx, dz)
        if (distance > 4) {
          trail.active = false
          continue
        }
        if (distance < STEP) continue
        const v = cursor * 4
        cursor = (cursor + 1) % QUADS
        writeVertex(v, trail.lx, trail.ly, trail.lz, trail.alpha)
        writeVertex(v + 1, trail.rx, trail.ry, trail.rz, trail.alpha)
        trail.lx = cx + side.x
        trail.ly = cy + side.y
        trail.lz = cz + side.z
        trail.rx = cx - side.x
        trail.ry = cy - side.y
        trail.rz = cz - side.z
        trail.cx = cx
        trail.cz = cz
        trail.alpha = alpha
        writeVertex(v + 2, trail.lx, trail.ly, trail.lz, alpha)
        writeVertex(v + 3, trail.rx, trail.ry, trail.rz, alpha)
        changed = true
      }
      if (changed) {
        geometry.attributes["aPosition"]?.buffer.update()
        colorBuffer?.update()
        changed = false
      }
    }
  }
}

export type Skids = ReturnType<typeof createSkids>
