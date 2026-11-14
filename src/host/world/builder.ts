/**
 * Collects triangles with normals and vertex colours into one `Geometry3D`, so the
 * static world draws in a handful of meshes.
 *
 * Triangles are wound from their vertex normals: whatever order the caller gives, the
 * front face ends up on the side the normals point to.
 */
import { Geometry3D, srgbToLinear } from "@pixi/3d"

export type Vec3 = readonly [number, number, number]
/** A colour in linear light, ready for vertex colours. */
export type Rgb = readonly [number, number, number]

/** An sRGB hex colour (as in the palette) in linear light. */
export const rgb = (hex: number): Rgb => [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)]

export const mix = (a: Rgb, b: Rgb, t: number): Rgb => {
  const k = Math.min(1, Math.max(0, t))
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

export const scale = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k]

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2])
  return length === 0 ? [0, 1, 0] : [a[0] / length, a[1] / length, a[2] / length]
}

export class MeshBuilder {
  private readonly positions: Array<number> = []
  private readonly normals: Array<number> = []
  private readonly colors: Array<number> = []
  private readonly indices: Array<number> = []

  get vertexCount(): number {
    return this.positions.length / 3
  }

  vertex(p: Vec3, n: Vec3, c: Rgb): number {
    this.positions.push(p[0], p[1], p[2])
    this.normals.push(n[0], n[1], n[2])
    this.colors.push(c[0], c[1], c[2], 1)
    return this.positions.length / 3 - 1
  }

  /** One triangle of existing vertices, turned to face the way its vertex normals point. */
  triangle(a: number, b: number, c: number): void {
    const p = this.positions
    const n = this.normals
    const ux = p[b * 3]! - p[a * 3]!
    const uy = p[b * 3 + 1]! - p[a * 3 + 1]!
    const uz = p[b * 3 + 2]! - p[a * 3 + 2]!
    const vx = p[c * 3]! - p[a * 3]!
    const vy = p[c * 3 + 1]! - p[a * 3 + 1]!
    const vz = p[c * 3 + 2]! - p[a * 3 + 2]!
    const gx = uy * vz - uz * vy
    const gy = uz * vx - ux * vz
    const gz = ux * vy - uy * vx
    const mx = n[a * 3]! + n[b * 3]! + n[c * 3]!
    const my = n[a * 3 + 1]! + n[b * 3 + 1]! + n[c * 3 + 1]!
    const mz = n[a * 3 + 2]! + n[b * 3 + 2]! + n[c * 3 + 2]!
    if (gx * mx + gy * my + gz * mz >= 0) this.indices.push(a, b, c)
    else this.indices.push(a, c, b)
  }

  /** Four existing vertices in order around the edge. */
  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c)
    this.triangle(a, c, d)
  }

  /** A flat polygon with its own vertices, facing `normal`. Convex, points in order around the edge. */
  face(points: ReadonlyArray<Vec3>, normal: Vec3, colour: Rgb | ReadonlyArray<Rgb>): void {
    const first = this.vertexCount
    // One colour is a tuple of numbers; a list has a colour per point.
    const single = typeof colour[0] === "number"
    points.forEach((point, i) => {
      const list = colour as ReadonlyArray<Rgb>
      const c = single ? (colour as Rgb) : (list[i] ?? list[0]!)
      this.vertex(point, normal, c)
    })
    for (let i = 1; i + 1 < points.length; i++) this.triangle(first, first + i, first + i + 1)
  }

  /** A flat polygon whose normal comes from its own points, turned toward `toward`. */
  flat(points: ReadonlyArray<Vec3>, toward: Vec3, colour: Rgb | ReadonlyArray<Rgb>): void {
    const [a, b, c] = points
    if (a === undefined || b === undefined || c === undefined) return
    let normal = normalize(cross(sub(b, a), sub(c, a)))
    if (dot(normal, toward) < 0) normal = mul(normal, -1)
    this.face(points, normal, colour)
  }

  /** Adds raw arrays (positions, normals, linear RGB colours, indices) from a geometry built elsewhere. */
  append(positions: ArrayLike<number>, normals: ArrayLike<number>, colors: ArrayLike<number>, indices: ArrayLike<number>): void {
    const base = this.vertexCount
    for (let i = 0; i < positions.length; i++) this.positions.push(positions[i]!)
    for (let i = 0; i < normals.length; i++) this.normals.push(normals[i]!)
    for (let i = 0; i < colors.length; i += 3) this.colors.push(colors[i]!, colors[i + 1]!, colors[i + 2]!, 1)
    for (let i = 0; i < indices.length; i++) this.indices.push(indices[i]! + base)
  }

  geometry(): Geometry3D {
    const count = this.vertexCount
    return new Geometry3D({
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      colors: new Float32Array(this.colors),
      indices: count > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices)
    })
  }
}

/** Smooth value noise in [0, 1], for colour variation that does not repeat visibly. */
export const noise2 = (x: number, z: number): number => {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz)
  const b = hash2(ix + 1, iz)
  const c = hash2(ix, iz + 1)
  const d = hash2(ix + 1, iz + 1)
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz
}

const hash2 = (x: number, z: number): number => {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

/** A small seeded random generator, so the scenery is the same on every load. */
export const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
