/**
 * Geometry and textures the actors share, built in code.
 *
 * The ink outline (`OutlinePass`) pushes each vertex out along its normal, so a shape with split
 * normals on a hard edge (a plain cube) shows gaps at that edge. Every outlined shape here is a
 * rounded box whose normal is a function of the vertex's place on the surface: where two faces
 * meet, their vertices sit at the same point with the same normal, and the outline stays closed.
 */
import { Geometry3D, srgbToLinear } from "@pixi/3d"
import { CanvasSource, Texture } from "pixi.js"

/** Bends a rounded box after it is built: gets a point of the undeformed box and writes the new one into `out`. */
export type Deform = (x: number, y: number, z: number, out: { x: number; y: number; z: number }) => void

export interface RoundedBoxOptions {
  readonly width: number
  readonly height: number
  readonly depth: number
  /** Radius of the rounded edges and corners. */
  readonly radius: number
  /** Steps around each rounded edge. */
  readonly segments?: number
  readonly deform?: Deform
  /** Replaces the per-face UVs with a projection of the final point, for a pattern that runs across faces. */
  readonly project?: (x: number, y: number, z: number, out: { u: number; v: number }) => void
}

/**
 * A box with rounded edges and smooth normals, centred on the origin.
 *
 * Each face is a grid whose rows bunch up in the rounded bands and skip across the flat middle.
 * A grid point on the sharp box is pulled onto the rounded surface: the nearest point of the
 * inner box (the sharp box shrunk by `radius`) plus `radius` along the way to it. UVs run 0 to 1
 * across each face.
 */
export const roundedBox = (options: RoundedBoxOptions): Geometry3D => {
  const { width, height, depth, deform, project } = options
  const half = [width / 2, height / 2, depth / 2] as const
  const radius = Math.min(options.radius, half[0], half[1], half[2])
  const segments = Math.max(1, options.segments ?? 3)
  const inner = [half[0] - radius, half[1] - radius, half[2] - radius] as const

  // Grid stops along one axis: a rounded band at each end, one step over the flat middle.
  const stops = (axis: 0 | 1 | 2): Array<number> => {
    const h = half[axis]
    const values: Array<number> = []
    for (let i = 0; i <= segments; i++) values.push(-h + (radius * i) / segments)
    for (let i = 0; i <= segments; i++) values.push(h - radius + (radius * i) / segments)
    // Drop the doubled stop when the flat middle has no length.
    return values.filter((value, i) => i === 0 || Math.abs(value - (values[i - 1] ?? Number.NaN)) > 1e-6)
  }

  // Each face: its normal axis and sign, and two in-plane axes with u x v pointing out.
  const faces: ReadonlyArray<readonly [0 | 1 | 2, 1 | -1, 0 | 1 | 2, 0 | 1 | 2]> = [
    [0, 1, 1, 2],
    [0, -1, 2, 1],
    [1, 1, 2, 0],
    [1, -1, 0, 2],
    [2, 1, 0, 1],
    [2, -1, 1, 0]
  ]
  const positions: Array<number> = []
  const normals: Array<number> = []
  const uvs: Array<number> = []
  const indices: Array<number> = []
  const point = [0, 0, 0]
  const moved = { x: 0, y: 0, z: 0 }
  const uv = { u: 0, v: 0 }
  for (const [axis, sign, u, v] of faces) {
    const us = stops(u)
    const vs = stops(v)
    const base = positions.length / 3
    for (let j = 0; j < vs.length; j++) {
      for (let i = 0; i < us.length; i++) {
        point[axis] = sign * half[axis]
        point[u] = us[i] ?? 0
        point[v] = vs[j] ?? 0
        const px = point[0] ?? 0
        const py = point[1] ?? 0
        const pz = point[2] ?? 0
        const cx = Math.max(-inner[0], Math.min(inner[0], px))
        const cy = Math.max(-inner[1], Math.min(inner[1], py))
        const cz = Math.max(-inner[2], Math.min(inner[2], pz))
        let nx = px - cx
        let ny = py - cy
        let nz = pz - cz
        const length = Math.hypot(nx, ny, nz)
        if (length < 1e-9) {
          nx = axis === 0 ? sign : 0
          ny = axis === 1 ? sign : 0
          nz = axis === 2 ? sign : 0
        } else {
          nx /= length
          ny /= length
          nz /= length
        }
        let x = cx + nx * radius
        let y = cy + ny * radius
        let z = cz + nz * radius
        if (deform !== undefined) {
          deform(x, y, z, moved)
          x = moved.x
          y = moved.y
          z = moved.z
        }
        positions.push(x, y, z)
        normals.push(nx, ny, nz)
        if (project !== undefined) {
          project(x, y, z, uv)
          uvs.push(uv.u, uv.v)
        } else {
          uvs.push(((point[u] ?? 0) + half[u]) / (2 * half[u]), 1 - ((point[v] ?? 0) + half[v]) / (2 * half[v]))
        }
      }
    }
    const row = us.length
    for (let j = 0; j < vs.length - 1; j++) {
      for (let i = 0; i < us.length - 1; i++) {
        const a = base + j * row + i
        const b = a + 1
        const c = a + row + 1
        const d = a + row
        indices.push(a, b, c, a, c, d)
      }
    }
  }
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices)
  })
}

/**
 * A flat chevron lying in XZ, pointing +Z, normal +Y: two arms meeting at a tip. `width` is
 * across, `length` from the arms' ends to the tip, `thickness` is how wide each arm is.
 */
export const chevron = (width: number, length: number, thickness: number): Geometry3D => {
  const w = width / 2
  const back = -length / 2
  const tip = length / 2
  // Outer edge, then the inner edge `thickness` behind it along Z.
  const positions = new Float32Array([
    -w, 0, back,
    0, 0, tip,
    w, 0, back,
    -w, 0, back - thickness,
    0, 0, tip - thickness,
    w, 0, back - thickness
  ])
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0])
  const indices = new Uint16Array([0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2])
  return new Geometry3D({ positions, normals, indices })
}

const canvas = (size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } => {
  const element = document.createElement("canvas")
  element.width = size
  element.height = size
  const context = element.getContext("2d")
  if (context === null) throw new Error("No 2D canvas")
  return { canvas: element, context }
}

/** A texture from a canvas, with mipmaps so fine patterns stay calm when the camera is far. */
const mipmapped = (element: HTMLCanvasElement, repeat: boolean): Texture => {
  const source = new CanvasSource({ resource: element, autoGenerateMipmaps: true, addressMode: repeat ? "repeat" : "clamp-to-edge" })
  source.style.mipmapFilter = "linear"
  source.style.maxAnisotropy = 8
  source.style.update()
  return new Texture({ source })
}

const css = (hex: number): string => `#${hex.toString(16).padStart(6, "0")}`

/** One face of a wooden crate: planks, a frame and a diagonal brace. */
export const crateTexture = (light: number, dark: number): Texture => {
  const size = 128
  const { canvas: element, context } = canvas(size)
  context.fillStyle = css(light)
  context.fillRect(0, 0, size, size)
  // Plank seams.
  context.strokeStyle = css(dark)
  context.globalAlpha = 0.55
  context.lineWidth = 3
  for (let i = 1; i < 4; i++) {
    context.beginPath()
    context.moveTo(0, (i * size) / 4)
    context.lineTo(size, (i * size) / 4)
    context.stroke()
  }
  context.globalAlpha = 1
  // Diagonal brace.
  context.fillStyle = css(dark)
  context.save()
  context.translate(size / 2, size / 2)
  context.rotate(-Math.PI / 4)
  context.fillRect(-size * 0.75, -9, size * 1.5, 18)
  context.restore()
  // Frame.
  const frame = 18
  context.fillRect(0, 0, size, frame)
  context.fillRect(0, size - frame, size, frame)
  context.fillRect(0, 0, frame, size)
  context.fillRect(size - frame, 0, frame, size)
  return mipmapped(element, false)
}

/** Diagonal warning stripes, for the gate arm. Tiles across U. */
export const stripeTexture = (a: number, b: number): Texture => {
  const size = 64
  const { canvas: element, context } = canvas(size)
  context.fillStyle = css(a)
  context.fillRect(0, 0, size, size)
  context.fillStyle = css(b)
  for (let i = -1; i < 2; i++) {
    context.beginPath()
    context.moveTo(i * size, size)
    context.lineTo(i * size + size / 2, size)
    context.lineTo(i * size + size, 0)
    context.lineTo(i * size + size / 2, 0)
    context.closePath()
    context.fill()
  }
  return mipmapped(element, true)
}

/** A soft round puff for every particle: a solid core that fades at the rim. */
export const puffTexture = (): Texture => {
  const size = 64
  const { canvas: element, context } = canvas(size)
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, "rgba(255,255,255,1)")
  gradient.addColorStop(0.55, "rgba(255,255,255,0.85)")
  gradient.addColorStop(1, "rgba(255,255,255,0)")
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
  return Texture.from(element)
}

/** One ring of a lathe profile: radius, height and the sRGB colour of the surface there. */
export type LatheRing = readonly [radius: number, y: number, color: number]

/**
 * A surface of revolution around +Y with smooth normals and vertex colours, for cones, drums,
 * posts and hinges.
 *
 * `profile` runs from the bottom centre to the top centre. Each ring's normal is the average of
 * the two profile segments that meet there, so the surface is closed and smooth for the outline;
 * put two rings close together for a crisp rim. Two rings at the same place with different
 * colours give a hard colour band with no seam in the shape. The seam at u = 0 and u = 1 shares
 * positions and normals.
 */
export const lathe = (profile: ReadonlyArray<LatheRing>, segments: number = 24): Geometry3D => {
  const rings = profile.length
  const ringNormals: Array<number> = []
  for (let i = 0; i < rings; i++) {
    // The segments either side, skipping a doubled ring (a colour band) to find real neighbours.
    let a = i - 1
    while (a >= 0 && same(profile[a], profile[i])) a--
    let b = i + 1
    while (b < rings && same(profile[b], profile[i])) b++
    const here = profile[i] ?? [0, 0, 0]
    let nr = 0
    let ny = 0
    for (const other of [a, b]) {
      const ring = profile[other]
      if (ring === undefined) continue
      const dr = (other > i ? ring[0] - here[0] : here[0] - ring[0])
      const dy = (other > i ? ring[1] - here[1] : here[1] - ring[1])
      const length = Math.hypot(dr, dy)
      if (length < 1e-9) continue
      // Outward normal of a segment going up the profile: (dy, -dr).
      nr += dy / length
      ny += -dr / length
    }
    const length = Math.hypot(nr, ny)
    ringNormals.push(length > 1e-9 ? nr / length : 0, length > 1e-9 ? ny / length : i === 0 ? -1 : 1)
  }
  const positions: Array<number> = []
  const normals: Array<number> = []
  const uvs: Array<number> = []
  const colors: Array<number> = []
  const indices: Array<number> = []
  for (let i = 0; i < rings; i++) {
    const [r, y, color] = profile[i] ?? [0, 0, 0]
    const nr = ringNormals[i * 2] ?? 0
    const ny = ringNormals[i * 2 + 1] ?? 0
    const red = srgbToLinear(((color >> 16) & 255) / 255)
    const green = srgbToLinear(((color >> 8) & 255) / 255)
    const blue = srgbToLinear((color & 255) / 255)
    for (let j = 0; j <= segments; j++) {
      const a = (j / segments) * Math.PI * 2
      const c = Math.cos(a)
      const s = Math.sin(a)
      positions.push(r * s, y, r * c)
      normals.push(nr * s, ny, nr * c)
      uvs.push(j / segments, i / (rings - 1))
      colors.push(red, green, blue, 1)
    }
  }
  const row = segments + 1
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j
      const b = a + 1
      const c = a + row + 1
      const d = a + row
      // Counter-clockwise seen from outside: up the profile is +v, around is +u.
      indices.push(a, b, c, a, c, d)
    }
  }
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    colors: new Float32Array(colors),
    indices: new Uint16Array(indices)
  })
}

const same = (a: LatheRing | undefined, b: LatheRing | undefined): boolean =>
  a !== undefined && b !== undefined && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6

/**
 * The heavy ball's skin, wrapped on a `SphereGeometry`: six gores in two colours and a pale band
 * round the middle, so every turn of a roll shows from above.
 */
export const ballTexture = (a: number, b: number, band: number): Texture => {
  const width = 256
  const height = 128
  const element = document.createElement("canvas")
  element.width = width
  element.height = height
  const context = element.getContext("2d")
  if (context === null) throw new Error("No 2D canvas")
  const gores = 6
  for (let i = 0; i < gores; i++) {
    context.fillStyle = css(i % 2 === 0 ? a : b)
    context.fillRect((i * width) / gores, 0, width / gores + 1, height)
  }
  context.fillStyle = css(band)
  context.fillRect(0, height * 0.455, width, height * 0.09)
  // Small caps over the poles, where the gores pinch together.
  context.fillRect(0, 0, width, height * 0.07)
  context.fillRect(0, height * 0.93, width, height * 0.07)
  return mipmapped(element, true)
}

/** Diagonal barrier stripes for a door board: one period across U, tiles both ways. */
export const barrierTexture = (a: number, b: number): Texture => {
  const size = 64
  const { canvas: element, context } = canvas(size)
  context.fillStyle = css(a)
  context.fillRect(0, 0, size, size)
  context.fillStyle = css(b)
  for (let i = -1; i < 2; i++) {
    context.beginPath()
    context.moveTo(i * size, size)
    context.lineTo(i * size + size / 2, size)
    context.lineTo(i * size + size, 0)
    context.lineTo(i * size + size / 2, 0)
    context.closePath()
    context.fill()
  }
  // A thin dark frame along the top and bottom edges.
  context.fillStyle = "rgba(0,0,0,0.28)"
  context.fillRect(0, 0, size, 4)
  context.fillRect(0, size - 4, size, 4)
  return mipmapped(element, true)
}
