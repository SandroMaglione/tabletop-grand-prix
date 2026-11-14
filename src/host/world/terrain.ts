/**
 * The slab of terrain the road is carved into.
 *
 * A fine grid whose height at each point comes from the road field: the terrain's top,
 * rising to the parapets beside raised road and falling away as embankments. Cells inside
 * a channel are left out; their ragged edge sits under the wall band the road module lays
 * on top. Where a run of road stops (a ramp's cliff, a landing's start, an abutment) the
 * grid points next to the cut line are moved onto it, so the terrain stops on that line and
 * the road's end face covers the step.
 *
 * Grass on top, packed earth wherever the surface is steep, and earth sides down to the table.
 */
import { palette } from "../palette.ts"
import { type MeshBuilder, mix, noise2, rgb, type Rgb, scale } from "./builder.ts"
import type { SlabBox } from "./dimensions.ts"
import { EMBANKMENT_SLOPE, type Field, type TerrainPoint, WALL_BAND } from "./field.ts"
import type { Pond } from "./pond.ts"

/** Grid spacing in metres. The wall band must be wider than the hole inset plus a cell's diagonal. */
export const TERRAIN_CELL = 0.3

const GRASS = rgb(palette.grass)
const GRASS_DARK = rgb(palette.grassDark)
const EARTH = rgb(palette.earth)
const EARTH_DARK = rgb(palette.earthDark)
const SHORE = rgb(palette.shore)

/** The grass colour at a point, shared with the wall band so the two match. */
export const grassAt = (x: number, z: number): Rgb => {
  const broad = noise2(x * 0.045 + 3.1, z * 0.045 - 7.2)
  const fine = noise2(x * 0.21, z * 0.21)
  return mix(GRASS, GRASS_DARK, broad * 0.75 + fine * 0.25 - 0.1)
}

/** Earth for a face by how steep it is (1 flat, 0 vertical) and its height below the terrain top. */
export const earthAt = (upness: number, depth: number): Rgb => mix(mix(EARTH, EARTH_DARK, 0.25 - upness * 0.4), EARTH_DARK, depth * 0.35)

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Builds the terrain top and the slab's sides into `out`. */
export const buildTerrain = (field: Field, slab: SlabBox, out: MeshBuilder, pond: Pond | null = null): void => {
  const nx = Math.ceil((slab.maxX - slab.minX) / TERRAIN_CELL) + 1
  const nz = Math.ceil((slab.maxZ - slab.minZ) / TERRAIN_CELL) + 1
  const stepX = (slab.maxX - slab.minX) / (nx - 1)
  const stepZ = (slab.maxZ - slab.minZ) / (nz - 1)
  const total = nx * nz
  const px = new Float32Array(total)
  const pz = new Float32Array(total)
  const snapped = new Uint8Array(total)
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      px[iz * nx + ix] = slab.minX + ix * stepX
      pz[iz * nx + ix] = slab.minZ + iz * stepZ
    }
  }

  // Move the grid points next to each cut line onto it.
  for (const end of field.ends) {
    const section = field.sections[end.section]!
    const rise = Math.max(field.topLeft[end.section]!, field.topRight[end.section]!) - field.top
    const reach = section.hw + WALL_BAND + Math.max(0, rise) / EMBANKMENT_SLOPE + TERRAIN_CELL
    // Lateral axis of the line: perpendicular to the outward direction.
    const ax = -end.nz
    const az = end.nx
    const ix0 = Math.max(0, Math.floor((section.x - reach - slab.minX) / stepX))
    const ix1 = Math.min(nx - 1, Math.ceil((section.x + reach - slab.minX) / stepX))
    const iz0 = Math.max(0, Math.floor((section.z - reach - slab.minZ) / stepZ))
    const iz1 = Math.min(nz - 1, Math.ceil((section.z + reach - slab.minZ) / stepZ))
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const v = iz * nx + ix
        const rx = px[v]! - section.x
        const rz = pz[v]! - section.z
        const across = rx * end.nx + rz * end.nz
        const along = rx * ax + rz * az
        if (Math.abs(across) > TERRAIN_CELL * 0.5 || Math.abs(along) > reach) continue
        px[v] = px[v]! - end.nx * across
        pz[v] = pz[v]! - end.nz * across
        snapped[v] = 1
      }
    }
  }

  // Heights. A point on a cut line takes the lower side and is never covered, so the hole
  // stops on the line and the terrain in front of a cliff stays flat.
  const heights = new Float32Array(total)
  const covered = new Uint8Array(total)
  const a: TerrainPoint = { h: 0, covered: false }
  const b: TerrainPoint = { h: 0, covered: false }
  for (let v = 0; v < total; v++) {
    const x = px[v]!
    const z = pz[v]!
    if (snapped[v] === 0) {
      field.heightAt(x, z, a)
      heights[v] = a.h
      covered[v] = a.covered ? 1 : 0
      continue
    }
    let lowest = Number.POSITIVE_INFINITY
    let allCovered = true
    let any = false
    for (const end of field.ends) {
      const section = field.sections[end.section]!
      const across = (x - section.x) * end.nx + (z - section.z) * end.nz
      if (Math.abs(across) > 0.01 || Math.hypot(x - section.x, z - section.z) > 30) continue
      any = true
      field.heightAt(x + end.nx * 0.03, z + end.nz * 0.03, a)
      field.heightAt(x - end.nx * 0.03, z - end.nz * 0.03, b)
      lowest = Math.min(lowest, a.covered ? b.h : b.covered ? a.h : Math.min(a.h, b.h))
      if (!(a.covered && b.covered)) allCovered = false
    }
    if (!any) {
      field.heightAt(x, z, a)
      lowest = a.h
      allCovered = a.covered
    }
    heights[v] = lowest
    covered[v] = allCovered ? 1 : 0
  }

  // Triangles, skipping any that touch a covered point. Each cell is split along the
  // diagonal with the smaller height change, which keeps slopes clean.
  const indices: Array<number> = []
  const faceNormals = new Float32Array(total * 3)
  const pushTriangle = (i: number, j: number, k: number): void => {
    indices.push(i, j, k)
    const ux = px[j]! - px[i]!
    const uy = heights[j]! - heights[i]!
    const uz = pz[j]! - pz[i]!
    const vx = px[k]! - px[i]!
    const vy = heights[k]! - heights[i]!
    const vz = pz[k]! - pz[i]!
    const gx = uy * vz - uz * vy
    const gy = uz * vx - ux * vz
    const gz = ux * vy - uy * vx
    for (const w of [i, j, k]) {
      faceNormals[w * 3] = faceNormals[w * 3]! + gx
      faceNormals[w * 3 + 1] = faceNormals[w * 3 + 1]! + gy
      faceNormals[w * 3 + 2] = faceNormals[w * 3 + 2]! + gz
    }
  }
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const p = iz * nx + ix
      const q = p + 1
      const r = p + nx
      const s = r + 1
      const pc = covered[p] === 1
      const qc = covered[q] === 1
      const rc = covered[r] === 1
      const sc = covered[s] === 1
      const mainDiagonal = Math.abs(heights[p]! - heights[s]!) <= Math.abs(heights[q]! - heights[r]!)
      if (mainDiagonal) {
        if (!pc && !rc && !sc) pushTriangle(p, r, s)
        if (!pc && !sc && !qc) pushTriangle(p, s, q)
      } else {
        if (!pc && !rc && !qc) pushTriangle(p, r, q)
        if (!qc && !rc && !sc) pushTriangle(q, r, s)
      }
    }
  }

  // Ambient occlusion from the height grid: in eight directions, how high the ground rises
  // within a couple of metres, as the sine of the horizon angle.
  const occlusion = new Float32Array(total).fill(1)
  const reach = [2, 4, 7]
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1]
  ] as const
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const v = iz * nx + ix
      if (covered[v] === 1) continue
      const h = heights[v]!
      let sum = 0
      for (const [dx, dz] of directions) {
        let horizon = 0
        for (const k of reach) {
          const jx = ix + dx * k
          const jz = iz + dz * k
          if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue
          const rise = heights[jz * nx + jx]! - h
          if (rise <= 0) continue
          const distance = k * TERRAIN_CELL * Math.hypot(dx, dz)
          horizon = Math.max(horizon, rise / Math.hypot(rise, distance))
        }
        sum += horizon
      }
      occlusion[v] = 1 - 0.55 * (sum / directions.length)
    }
  }

  const positions = new Float32Array(total * 3)
  const normals = new Float32Array(total * 3)
  const colors = new Float32Array(total * 3)
  for (let v = 0; v < total; v++) {
    const x = px[v]!
    const z = pz[v]!
    const h = heights[v]!
    positions[v * 3] = x
    positions[v * 3 + 1] = h
    positions[v * 3 + 2] = z
    let gx = faceNormals[v * 3]!
    let gy = faceNormals[v * 3 + 1]!
    let gz = faceNormals[v * 3 + 2]!
    const length = Math.hypot(gx, gy, gz)
    if (length === 0) {
      gx = 0
      gy = 1
      gz = 0
    } else {
      gx /= length
      gy /= length
      gz /= length
    }
    normals[v * 3] = gx
    normals[v * 3 + 1] = gy
    normals[v * 3 + 2] = gz
    // Grass where it is flat, packed earth where it is steep, darkened where the ground
    // around rises over it (the foot of an embankment): baked ambient occlusion.
    const earthiness = smooth(0.93, 0.8, gy)
    const ground = mix(grassAt(x, z), earthAt(gy, 0), earthiness)
    // A pale, wet sand shore around the pond, a little darker toward the water.
    const wet = pond === null ? 0 : pond.shore(x, z)
    const shore = wet > 0 ? mix(ground, mix(SHORE, EARTH_DARK, smooth(0.55, 1, wet) * 0.35), smooth(0, 0.5, wet)) : ground
    const colour = scale(shore, occlusion[v]!)
    colors[v * 3] = colour[0]
    colors[v * 3 + 1] = colour[1]
    colors[v * 3 + 2] = colour[2]
  }
  out.append(positions, normals, colors, indices)

  // The slab's four sides, from the terrain's edge down to the table.
  const side = (vertices: ReadonlyArray<number>, outward: readonly [number, number, number]): void => {
    for (let i = 0; i + 1 < vertices.length; i++) {
      const p = vertices[i]!
      const q = vertices[i + 1]!
      const top = (w: number): readonly [number, number, number] => [px[w]!, heights[w]!, pz[w]!]
      const bottom = (w: number): readonly [number, number, number] => [px[w]!, slab.bottom, pz[w]!]
      const upper = earthAt(0, 0)
      const lower = earthAt(0, 1)
      const a0 = out.vertex(top(p), outward, upper)
      const a1 = out.vertex(top(q), outward, upper)
      const b1 = out.vertex(bottom(q), outward, lower)
      const b0 = out.vertex(bottom(p), outward, lower)
      out.quad(a0, a1, b1, b0)
    }
  }
  const row = (iz: number): Array<number> => Array.from({ length: nx }, (_, ix) => iz * nx + ix)
  const column = (ix: number): Array<number> => Array.from({ length: nz }, (_, iz) => iz * nx + ix)
  side(row(0), [0, 0, -1])
  side(row(nz - 1), [0, 0, 1])
  side(column(0), [-1, 0, 0])
  side(column(nx - 1), [1, 0, 0])
}
