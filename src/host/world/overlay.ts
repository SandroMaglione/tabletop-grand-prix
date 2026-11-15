/**
 * A skin laid a few centimetres over the road in road coordinates: the meadow's turf, the
 * ford's wet bed, the stony ground's dirt and gravel.
 *
 * A grid of cells over a box of centreline distance and lateral offset, every grid point
 * placed with `pointAt` (so the skin follows bends, slopes and banks) and coloured by the
 * caller, alpha included. A cell is drawn when any of its corners shows, so a ragged edge is
 * a soft fade across the last cell rather than a staircase. Drawn with a blended material
 * over the opaque asphalt.
 *
 * Two options: `wall` keeps every row that far inside the road's walls, so a box wider than
 * the road at some point never runs into them; `heightAt` raises each point by its own amount
 * (ruts and humps), and the normals tilt with the slope of it, so the light picks out the relief.
 */
import { Geometry3D, Material3D, Mesh3D } from "@pixi/3d"
import { pointAt, type TrackData } from "../../sim/index.ts"
import { halfWidthAt } from "./patches.ts"

/** Linear RGBA written by the caller; alpha 0 hides the point. */
export type Rgba = [number, number, number, number]

export interface OverlayBox {
  readonly sFrom: number
  readonly sTo: number
  readonly dFrom: number
  readonly dTo: number
  /** Cell size in metres. */
  readonly cell: number
  /** Height over the road surface. */
  readonly lift: number
  /** Keep every row this many metres inside the walls. */
  readonly wall?: number
  /** Metres added to `lift` at a point. */
  readonly heightAt?: (s: number, d: number) => number
}

export const buildOverlay = (track: TrackData, box: OverlayBox, colourAt: (s: number, d: number, out: Rgba) => void, label: string, roughness: number): Mesh3D => {
  const heightAt = box.heightAt
  const columns = Math.max(1, Math.ceil((box.dTo - box.dFrom) / box.cell))
  const rows = Math.max(1, Math.ceil((box.sTo - box.sFrom) / box.cell))
  const count = (rows + 1) * (columns + 1)
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const colors = new Float32Array(count * 4)
  const colour: Rgba = [0, 0, 0, 0]
  for (let row = 0; row <= rows; row++) {
    const s = box.sFrom + ((box.sTo - box.sFrom) * row) / rows
    const inside = box.wall === undefined ? Infinity : halfWidthAt(track, s) - box.wall
    const dFrom = Math.max(box.dFrom, -inside)
    const dTo = Math.min(box.dTo, inside)
    for (let column = 0; column <= columns; column++) {
      const d = dFrom + ((dTo - dFrom) * column) / columns
      const p = pointAt(track, s, d)
      // Up of the surface: forward (with pitch) crossed with left (with bank).
      const cp = Math.cos(p.pitch)
      const fx = Math.sin(p.yaw) * cp
      const fy = Math.sin(p.pitch)
      const fz = Math.cos(p.yaw) * cp
      const lx = Math.cos(p.yaw)
      const ly = Math.tan(p.bank)
      const lz = -Math.sin(p.yaw)
      let nx = fy * lz - fz * ly
      let ny = fz * lx - fx * lz
      let nz = fx * ly - fy * lx
      let nl = Math.hypot(nx, ny, nz) || 1
      nx /= nl
      ny /= nl
      nz /= nl
      const v = row * (columns + 1) + column
      let lift = box.lift
      let tx = nx
      let ty = ny
      let tz = nz
      if (heightAt !== undefined) {
        const h = heightAt(s, d)
        lift += h
        // Tilt the normal against the slope, along the road (forward) and across it (left).
        const e = 0.05
        const along = (heightAt(s + e, d) - h) / e
        const across = (heightAt(s, d + e) - h) / e
        tx -= fx * along + lx * across
        ty -= fy * along
        tz -= fz * along + lz * across
        nl = Math.hypot(tx, ty, tz) || 1
        tx /= nl
        ty /= nl
        tz /= nl
      }
      positions[v * 3] = p.x + nx * lift
      positions[v * 3 + 1] = p.y + ny * lift
      positions[v * 3 + 2] = p.z + nz * lift
      normals[v * 3] = tx
      normals[v * 3 + 1] = ty
      normals[v * 3 + 2] = tz
      colourAt(s, d, colour)
      colors.set(colour, v * 4)
    }
  }
  const indices: Array<number> = []
  const shows = (v: number): boolean => (colors[v * 4 + 3] ?? 0) > 0.003
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column
      const b = a + 1
      const c = a + columns + 1
      const d = c + 1
      if (!shows(a) && !shows(b) && !shows(c) && !shows(d)) continue
      // Rows run forward and columns run left, so (a, c, d) turns counter-clockwise seen from above.
      indices.push(a, c, d, a, d, b)
    }
  }
  const geometry = new Geometry3D({
    positions,
    normals,
    colors,
    indices: count > 65535 ? new Uint32Array(indices) : new Uint16Array(indices)
  })
  const material = new Material3D({ baseColor: 0xffffff, vertexColors: true, alphaMode: "blend", roughness, metallic: 0 })
  return new Mesh3D({ label, geometry, material, castShadow: false, receiveShadow: true })
}
