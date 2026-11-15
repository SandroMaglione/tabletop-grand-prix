/**
 * The stony ground: where the track says stones, the asphalt gives out and the road turns into
 * a rough track of packed dirt and gravel, with rocks the car bounces over.
 *
 * - Ground: one overlay (`overlay.ts`) laid over the asphalt with its own relief. Its colour
 *   mixes dark and pale dirt and grey gravel by noise at three sizes, speckled finely so it
 *   reads as grit; two pairs of ruts wander along it (lower and darker, worn clear of stones).
 *   At each end its edge is ragged and crumbles in islands, so the asphalt breaks up rather
 *   than stopping on a line.
 * - Stones: one `BatchedMesh3D` of a few lump shapes, each slot its own size and tone: stones
 *   of mixed sizes sunk to about half their height, gathered in clusters and kept out of the
 *   ruts, and loose pebbles everywhere, more round each rock.
 * - Rocks: the track's `bumps`, each a low, rounded boulder or slab half buried in the ground
 *   (a squashed ellipsoid centred below the surface, pushed about gently by noise seeded with
 *   its index), standing its bump's `height` out of the ground and as wide as the bump's own
 *   circle less the car's half width. Smooth normals, so the ink outline wraps it whole; a ring
 *   of scuffed dirt and pebbles round its foot.
 */
import { BatchedMesh3D, Container3D, Geometry3D, Material3D, Matrix4, Mesh3D, RenderPassBit, type ShaderBit } from "@pixi/3d"
import { type Bump, pointAt, type SurfacePatch, type TrackData } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { mix, noise2, rgb, type Rgb, scale, seeded, type Vec3 } from "./builder.ts"
import { buildOverlay } from "./overlay.ts"
import { halfWidthAt, locateRoad, patchDepth, patchesOf, roadSpot } from "./patches.ts"

/** How far past the patch's ends the rough ground frays onto the asphalt. */
const FRAY = 2
/** The car's half width, which a bump's radius includes. */
const CAR_HALF_WIDTH = 0.45
const GROUND_LIFT = 0.015
/** How far the rough ground stands over the asphalt in its middle, so its ruts and hollows stay above it. */
const GROUND_RISE = 0.06

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** A cheap hash in [0, 1) for fine speckle. */
const speckle = (s: number, d: number): number => {
  const h = Math.sin(s * 127.1 + d * 311.7) * 43758.5453
  return h - Math.floor(h)
}

/** The rough ground's ends, broken up: metres inside with noise at two sizes. */
const ragged = (track: TrackData, patch: SurfacePatch, s: number, d: number): number =>
  patchDepth(track, patch, s, d) + (noise2(s * 0.8 + 1.3, d * 0.8 + 5.1) - 0.5) * 2.2 + (noise2(s * 3.1 - 4, d * 3.1 + 2) - 0.5) * 0.9

/** The middle of each pair of ruts: lateral offsets that wander along the road. */
const rutLines = (s: number): readonly [number, number] => [-1.25 + Math.sin(s * 0.17 + 1) * 0.55, 1.15 + Math.sin(s * 0.13 + 4) * 0.5]

/** How deep in a rut (s, d) is: 1 in the bottom of a wheel's groove, 0 clear of it. Ruts come and go along the road. */
const rutAt = (s: number, d: number): number => {
  let deepest = 0
  rutLines(s).forEach((line, i) => {
    const worn = smooth(0.35, 0.6, noise2(s * 0.15 + i * 17, 3.3))
    for (const wheel of [-0.55, 0.55]) {
      const off = Math.abs(d - line - wheel)
      deepest = Math.max(deepest, (1 - smooth(0.04, 0.2, off)) * worn)
    }
  })
  return deepest
}

/** The ground's height over the asphalt at (s, d): humps, ruts, hollows round the rocks, none at the ragged ends. */
const groundHeight = (track: TrackData, patch: SurfacePatch, s: number, d: number, nearRock: number): number => {
  const hump = (noise2(s * 0.9 + 3, d * 0.9 - 1) - 0.5) * 0.05 + (noise2(s * 2.6, d * 2.6) - 0.5) * 0.02
  const scuff = smooth(0.4, 0, nearRock) * 0.015
  return (GROUND_RISE + hump - rutAt(s, d) * 0.03 - scuff) * smooth(-0.6, 0.6, ragged(track, patch, s, d))
}

/** A unit icosphere: an icosahedron subdivided, as shared vertices and triangles. */
const icosphere = (subdivisions: number): { vertices: Array<[number, number, number]>; faces: Array<[number, number, number]> } => {
  const t = (1 + Math.sqrt(5)) / 2
  const vertices: Array<[number, number, number]> = []
  const add = (x: number, y: number, z: number): number => {
    const length = Math.hypot(x, y, z)
    vertices.push([x / length, y / length, z / length])
    return vertices.length - 1
  }
  for (const [x, y, z] of [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]] as const) add(x, y, z)
  let faces: Array<[number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ]
  for (let level = 0; level < subdivisions; level++) {
    const cache = new Map<string, number>()
    const middle = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      const found = cache.get(key)
      if (found !== undefined) return found
      const p = vertices[a]!
      const q = vertices[b]!
      const index = add(p[0] + q[0], p[1] + q[1], p[2] + q[2])
      cache.set(key, index)
      return index
    }
    faces = faces.flatMap(([a, b, c]) => {
      const ab = middle(a, b)
      const bc = middle(b, c)
      const ca = middle(c, a)
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]] as Array<[number, number, number]>
    })
  }
  return { vertices, faces }
}

/** Smooth normals (area weighted) for shared vertices, so the ink outline wraps the shape without cracks. */
const lumpGeometry = (points: ReadonlyArray<Vec3>, faces: ReadonlyArray<readonly [number, number, number]>, colours: ReadonlyArray<Rgb>): Geometry3D => {
  const normals = new Float32Array(points.length * 3)
  for (const [a, b, c] of faces) {
    const p = points[a]!
    const q = points[b]!
    const r = points[c]!
    const ux = q[0] - p[0]
    const uy = q[1] - p[1]
    const uz = q[2] - p[2]
    const vx = r[0] - p[0]
    const vy = r[1] - p[1]
    const vz = r[2] - p[2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    for (const i of [a, b, c]) {
      normals[i * 3] = normals[i * 3]! + nx
      normals[i * 3 + 1] = normals[i * 3 + 1]! + ny
      normals[i * 3 + 2] = normals[i * 3 + 2]! + nz
    }
  }
  for (let i = 0; i < points.length; i++) {
    const length = Math.hypot(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!) || 1
    normals[i * 3] = normals[i * 3]! / length
    normals[i * 3 + 1] = normals[i * 3 + 1]! / length
    normals[i * 3 + 2] = normals[i * 3 + 2]! / length
  }
  return new Geometry3D({
    positions: new Float32Array(points.flat()),
    normals,
    colors: new Float32Array(colours.flatMap((c) => [c[0], c[1], c[2], 1])),
    indices: new Uint16Array(faces.flat())
  })
}

/**
 * A rock for `bump`, in its own frame (origin on the ground under its centre): an ellipsoid
 * whose middle lies below the ground, so only a low dome stands out, `height` high and as wide
 * as the bump's own circle less the car's half width. Broad, gentle lobes keep it rounded;
 * every other rock is a flatter slab.
 */
const rockGeometry = (bump: Bump, seed: number): Geometry3D => {
  const random = seeded(0xb0d1 + seed * 7919)
  const { vertices, faces } = icosphere(2)
  const footprint = bump.radius - CAR_HALF_WIDTH
  const slab = seed % 2 === 1
  // Vertical semi-axis, and how far below the ground the middle lies: a slab's top is cut down
  // to 0.67 of its round height (below), so its ellipsoid is taller to stand as high.
  const tall = bump.height * (slab ? 3.7 : 1.55)
  const sunk = slab ? tall * 0.4 : tall - bump.height
  // Wide enough that the dome meets the ground at `footprint`.
  const wide = footprint / Math.sqrt(1 - (sunk / tall) ** 2)
  const stretch = 1 + (random() - 0.5) * 0.3
  const yaw = random() * Math.PI * 2
  const tiltX = (random() - 0.5) * 0.12
  const tiltZ = (random() - 0.5) * 0.12
  const lobes = Array.from({ length: 6 }, () => {
    const a = random() * Math.PI * 2
    const b = Math.acos(random() * 2 - 1)
    return { x: Math.sin(b) * Math.cos(a), y: Math.cos(b), z: Math.sin(b) * Math.sin(a), k: (random() - 0.45) * 0.22 }
  })
  const dark = rgb(palette.rockDark)
  const grey = rgb(palette.rock)
  const light = rgb(palette.rockLight)
  const lichen = rgb(palette.lichen)
  const dirt = rgb(palette.dirtDark)
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const points: Array<Vec3> = []
  const colours: Array<Rgb> = []
  for (const [x, y, z] of vertices) {
    let bump2 = 0
    for (const lobe of lobes) bump2 += lobe.k * Math.max(0, x * lobe.x + y * lobe.y + z * lobe.z) ** 2
    const k = 1 + bump2
    // A slab's top is flattened into a broad worn face.
    const top = slab && y > 0.45 ? 0.45 + (y - 0.45) * 0.4 : y
    const px = x * wide * k * stretch
    const pz = (z * wide * k) / stretch
    const py = Math.max(-sunk - 0.05, top * tall * k - sunk + px * tiltX + pz * tiltZ)
    points.push([px * c + pz * s, py, -px * s + pz * c])
    const above = py / bump.height
    const moss = Math.max(0, noise2(x * 2.3 + seed * 3.1, z * 2.3 - seed) * 1.8 - 1.1) * Math.max(0, y)
    const tone = mix(mix(dark, grey, smooth(-0.1, 0.5, above)), light, smooth(0.55, 1, above) * 0.8)
    colours.push(mix(mix(tone, lichen, moss), dirt, 1 - smooth(-0.05, 0.25, above)))
  }
  return lumpGeometry(points, faces, colours)
}

/** Each stone's tone is its slot's; the shapes are shared. */
const stoneBit: ShaderBit = {
  name: "tabletopStoneTone",
  bindings: { instance: { tone: "vec4<f32>" } },
  gpu: { fragment: { material: "albedo *= instance.tone.rgb;" } },
  gl: { fragment: { material: "albedo *= instance.tone.rgb;" } }
}

/** A lumpy stone, a unit wide, its base flat so it can be sunk; `detail` 0 for pebbles too small to show more. */
const stoneGeometry = (seed: number, detail: number): Geometry3D => {
  const random = seeded(0x9eb1 + seed)
  const { vertices, faces } = icosphere(detail)
  const points: Array<Vec3> = vertices.map(([x, y, z]) => {
    const k = 0.82 + random() * 0.36
    return [x * k * 0.5, Math.max(-0.1, y * k * 0.5), z * k * (0.4 + seed * 0.06)]
  })
  return lumpGeometry(
    points,
    faces,
    points.map(([, y]) => scale([1, 1, 1], 0.75 + 0.25 * smooth(-0.1, 0.4, y)))
  )
}

/** Where a rock is on the road. */
interface RockSpot {
  readonly bump: Bump
  readonly s: number
  readonly d: number
  readonly r: number
}

export const buildStones = (track: TrackData): Container3D => {
  const root = new Container3D({ label: "stony ground" })
  const patches = patchesOf(track, "stones")
  if (patches.length === 0) return root

  const spot = roadSpot()
  const rocks: Array<RockSpot> = track.bumps.map((bump) => {
    // Bumps lie in the stony patch; find each one's road coordinates near it.
    let best = { s: 0, distance: Infinity }
    for (let s = 0; s < track.length; s += 2) {
      const p = pointAt(track, s)
      const distance = Math.hypot(bump.x - p.x, bump.y - p.y, bump.z - p.z)
      if (distance < best.distance) best = { s, distance }
    }
    locateRoad(track, bump.x, bump.z, Math.round(best.s / track.spacing), spot)
    return { bump, s: spot.s, d: spot.d, r: bump.radius - CAR_HALF_WIDTH }
  })
  /** Metres from (s, d) to the nearest rock's edge. */
  const nearRock = (s: number, d: number): number => {
    let nearest = Infinity
    for (const rock of rocks) nearest = Math.min(nearest, Math.hypot(rock.s - s, rock.d - d) - rock.r)
    return nearest
  }

  const dirt = rgb(palette.dirt)
  const dirtDark = rgb(palette.dirtDark)
  const dirtLight = rgb(palette.dirtLight)
  const gravel = rgb(palette.gravel)
  for (const patch of patches) {
    root.addChild(
      buildOverlay(
        track,
        {
          sFrom: patch.sFrom - FRAY - 0.5,
          sTo: patch.sTo + FRAY + 0.5,
          dFrom: patch.dFrom,
          dTo: patch.dTo,
          cell: 0.15,
          lift: GROUND_LIFT,
          wall: 0.02,
          heightAt: (s, d) => groundHeight(track, patch, s, d, nearRock(s, d))
        },
        (s, d, out) => {
          const r = ragged(track, patch, s, d)
          const broad = noise2(s * 0.28 + 9, d * 0.28 - 4)
          const mid = noise2(s * 1.1 - 2, d * 1.1 + 6)
          const fine = speckle(s, d)
          let c = mix(dirt, gravel, smooth(0.35, 0.75, mid) * 0.8)
          c = mix(c, dirtDark, smooth(0.45, 0.8, broad) * 0.7)
          c = mix(c, dirtLight, smooth(0.6, 0.9, 1 - broad) * 0.5)
          // Grit: a fine speckle of lighter and darker grains.
          c = scale(c, 0.84 + fine * 0.3)
          c = mix(c, dirtDark, rutAt(s, d) * 0.35 + smooth(0.45, 0, nearRock(s, d)) * 0.5)
          // The crumbling rim where the asphalt breaks up is darkest.
          c = mix(c, dirtDark, (1 - smooth(0, 0.7, r)) * 0.5)
          out[0] = c[0]
          out[1] = c[1]
          out[2] = c[2]
          out[3] = smooth(-0.15, 0.15, r)
        },
        "rough ground",
        0.97
      )
    )
  }

  // Rocks: one material for all, each its own shape. Outlined like everything the car can hit.
  const rockMaterial = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.9, metallic: 0, passes: { outline: true } })
  rocks.forEach(({ bump, s, d }, index) => {
    const patch = patches.find((p) => s > p.sFrom - FRAY && s < p.sTo + FRAY)
    const ground = patch === undefined ? 0 : groundHeight(track, patch, s, d, 0)
    new Mesh3D({ label: "rock", geometry: rockGeometry(bump, index), material: rockMaterial, position: { x: bump.x, y: bump.y + ground, z: bump.z }, castShadow: true, receiveShadow: true, parent: root })
  })

  // Stones: sunk stones in clusters (not in the ruts, not under a rock), then loose pebbles.
  const random = seeded(0x9ebb)
  const spots: Array<{ x: number; y: number; z: number; size: number; flat: number; yaw: number; tone: number; warm: number }> = []
  for (const patch of patches) {
    const length = patch.sTo - patch.sFrom + 2 * FRAY
    const place = (count: number, sizeFrom: number, sizeTo: number, flat: number, sunk: number, cluster: boolean): void => {
      for (let k = 0; k < count; k++) {
        const s = patch.sFrom - FRAY + random() * length
        const hw = halfWidthAt(track, s) - 0.15
        const d = (random() * 2 - 1) * hw
        const inside = smooth(-0.4, 0.4, ragged(track, patch, s, d))
        if (random() > inside) continue
        if (cluster && random() > smooth(0.3, 0.65, noise2(s * 0.6 + 2, d * 0.6 - 7)) + 0.15) continue
        if (random() < rutAt(s, d) * 0.85) continue
        const size = sizeFrom + (sizeTo - sizeFrom) * random() ** 1.6
        const rock = nearRock(s, d)
        if (rock < size * 0.4) continue
        const p = pointAt(track, s, d)
        const ground = groundHeight(track, patch, s, d, rock)
        spots.push({ x: p.x, y: p.y + GROUND_LIFT + ground - size * sunk, z: p.z, size, flat: flat * (0.8 + random() * 0.4), yaw: random() * Math.PI * 2, tone: 0.55 + random() * 0.6, warm: (random() - 0.5) * 0.22 })
      }
    }
    place(Math.round(length * 14), 0.2, 0.55, 0.5, 0.18, true)
    place(Math.round(length * 30), 0.06, 0.16, 0.7, 0.12, false)
  }
  for (const { bump, r } of rocks) {
    const count = 14 + Math.floor(random() * 6)
    for (let k = 0; k < count; k++) {
      const a = random() * Math.PI * 2
      const out = r + 0.05 + random() ** 1.5 * 0.7
      const size = 0.06 + random() * 0.14
      spots.push({ x: bump.x + Math.cos(a) * out, y: bump.y + GROUND_LIFT + GROUND_RISE * 0.6 - size * 0.1, z: bump.z + Math.sin(a) * out, size, flat: 0.7, yaw: random() * Math.PI * 2, tone: 0.7 + random() * 0.4, warm: (random() - 0.5) * 0.2 })
    }
  }
  const stones3 = [0, 1].map((seed) => stoneGeometry(seed, 1))
  const pebbles = [2, 3].map((seed) => stoneGeometry(seed, 0))
  const stoneMaterial = new Material3D({ baseColor: palette.pebble, roughness: 0.88, metallic: 0, extraBits: [stoneBit] })
  const stones = new BatchedMesh3D({ label: "stones", size: spots.length, instanceData: { tone: { value: [1, 1, 1, 1], type: "vec4<f32>" } } })
  const matrix = new Matrix4()
  const size = new Matrix4()
  spots.forEach((spot, i) => {
    matrix.makeRotationY(spot.yaw).multiply(size.makeScale(spot.size, spot.size * spot.flat, spot.size))
    matrix.setPosition({ x: spot.x, y: spot.y, z: spot.z })
    stones.setGeometryAt(i, (spot.size > 0.18 ? stones3 : pebbles)[i % 2]!)
    stones.setMaterialAt(i, stoneMaterial)
    stones.setMatrixAt(i, matrix)
    stones.setPassesAt(i, spot.size > 0.3 ? RenderPassBit.OPAQUE | RenderPassBit.SHADOW : RenderPassBit.OPAQUE)
    stones.setInstanceDataAt(i, "tone", spot.tone * (1 + spot.warm), spot.tone, spot.tone * (1 - spot.warm), 1)
  })
  root.addChild(stones)
  return root
}
