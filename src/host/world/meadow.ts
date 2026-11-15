/**
 * The meadow: long grass over the road where the track says grass grows.
 *
 * Seen from the camera a metre of road is about seventeen pixels, so the grass is drawn big:
 * clumps of a dozen blades as long as the car's wheels are high (0.8 to 1.1 m), each blade a
 * wide tapering ribbon that bows out of the clump's middle and twists a little along its
 * length. Blades are dark at the root and pale and yellow at the tip; every clump has its own
 * tone and dryness, and some carry a seed stem or a flower. Between the clumps lies dark turf
 * and soil (`overlay.ts`), with a soft shadow just past the patch's ragged edge, so the grass
 * stands on the road with some depth instead of being painted on it.
 *
 * All the clumps are one `BatchedMesh3D` of one clump shape, drawn in one call; each slot
 * scales and turns it and carries its tone, dryness, seed flag and place on the press map in
 * its instance data. A vertex shader bit bends every blade about its root, in world space:
 * - wind: two slow waves roll across the meadow and lean the blades by up to about thirty
 *   degrees at a crest; leaning blades show their paler sides, so each crest reads as a light
 *   band passing over the grass;
 * - the car: the press map is a small texture in road coordinates (centreline distance down,
 *   lateral offset across) holding, for every patch of ground a hand wide, which way its
 *   blades are bent and how far. Nothing in it is timed. Each frame the blades the car is
 *   touching are pushed to where the car puts them: flat and forward under the body, out and
 *   away along its flanks and round its nose, less the further they are from it. Every other
 *   blade is a spring: let go, it swings back up, past upright, and settles in about a second,
 *   so the grass closes behind the car as it would. The push also reaches past the car on the
 *   camera's side, so no blade in front of the car stands high enough to hide it.
 * The press map's per-frame work is one pass over its cells, and it is uploaded only while a
 * blade is bent.
 */
import { BatchedMesh3D, Container3D, Geometry3D, Material3D, Matrix4, RenderPassBit, type ShaderBit } from "@pixi/3d"
import { BufferImageSource, Texture } from "pixi.js"
import { pointAt, type RaceView, type SurfacePatch, type TrackData } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { CAMERA_YAW_DEG } from "../stage.ts"
import { mix, noise2, rgb, type Rgb, scale, seeded } from "./builder.ts"
import { buildOverlay } from "./overlay.ts"
import { locateRoad, patchDepth, patchesOf, roadSpot } from "./patches.ts"

/** How far past the patch's box the edge may fray, along the road and across it. */
const FRAY_ALONG = 1.6
const FRAY_ACROSS = 1.3
/** Spacing of the clumps' jittered grid, metres. */
const CLUMP_SPACING = 0.3
/** Blades in a clump, besides the seed stem. */
const BLADES = 9
/** Press map cell, metres, in road coordinates. */
const PRESS_CELL = 0.2
/** The car's body as the grass meets it, in its own frame: half width and half length, metres. */
const BODY_HALF_WIDTH = 0.72
const BODY_HALF_LENGTH = 1.3
/** Blades this far from the body still lean away from it, less with distance. */
const PUSH_REACH = 0.95
/** On the camera's side the push reaches this far past the car's middle. */
const PRESS_FRONT = 1.8
/** How fast a touched blade goes where the car puts it, 1/s. */
const PUSH_RATE = 22
/** A blade let go is a spring: its stiffness (1/s^2) and damping (1/s). It swings past upright once or twice and is still in about a second. */
const SPRING = 70
const DAMPING = 5
/** Turf lies this far over the asphalt. */
const TURF_LIFT = 0.02
/** Wind: lean at rest and at a crest (radians), wave speed (radians a second), wavelength factor (radians a metre). */
const WIND = [0.1, 0.52, 1.2, 0.4]
/** The way the wind blows, on the ground (unit). */
const WIND_DIRECTION = [0.82, 0.57, 0, 0]

/** The meadow's edge, frayed: metres inside the patch with noise, positive where grass grows. */
const ragged = (track: TrackData, patch: SurfacePatch, s: number, d: number): number =>
  patchDepth(track, patch, s, d) + (noise2(s * 1.1 + 3.7, d * 1.1 - 2.2) - 0.5) * 1.3 + (noise2(s * 3.7 - 9.1, d * 3.7 + 4.4) - 0.5) * 0.45

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Bends each blade about its clump's root, in world space. `uv.y` is how far along the blade
 * a vertex is (0 root, 1 tip), `uv.x` is 1 on the seed stem, which only slots with a seed
 * flag show; the slot's translation is the root.
 */
const grassBit: ShaderBit = {
  name: "tabletopLongGrass",
  bindings: {
    material: { wind: "vec4<f32>", windDirection: "vec4<f32>" },
    instance: { grass: "vec4<f32>", road: "vec4<f32>" }
  },
  textures: ["press"],
  interStage: { vGrass: "vec4<f32>", vTuft: "vec4<f32>" },
  gpu: {
    vertex: {
      afterTransform: /* wgsl */ `{
        let root = modelMatrix[3].xyz;
        let rel = worldPosition.xyz - root;
        let along = clamp(uv.y, 0.0, 1.0);
        let shown = 1.0 - uv.x * (1.0 - step(0.5, instance.road.z));
        let pushed = samplePressDirect(instance.road.xy).rg * 2.0 - vec2<f32>(1.0);
        let press = clamp(length(pushed), 0.0, 1.0);
        let away = pushed / max(length(pushed), 0.001);
        let wd = material.windDirection.xy;
        let across = dot(root.xz, vec2<f32>(-wd.y, wd.x));
        let travel = global.uTime * material.wind.z - dot(root.xz, wd) * material.wind.w;
        let swell = 0.5 + 0.5 * sin(travel + 0.8 * sin(across * 0.21 + global.uTime * 0.13));
        let ripple = 0.5 + 0.5 * sin(global.uTime * 2.1 - dot(root.xz, wd) * 1.3 + across * 0.6);
        let gust = clamp(swell * swell * 0.85 + ripple * 0.25, 0.0, 1.0);
        let flutter = sin(global.uTime * 3.1 + instance.grass.x * 6.0 + along * 2.0) * 0.05;
        let lean = ((material.wind.x + material.wind.y * gust) * instance.grass.y + flutter) * (1.0 - press);
        let turn = (lean + press * 1.45) * (0.3 + 0.7 * along);
        let dir = normalize(mix(wd, away, press) + vec2<f32>(0.0001));
        let bent = vec3<f32>(rel.x + dir.x * sin(turn) * rel.y, rel.y * cos(turn), rel.z + dir.y * sin(turn) * rel.y);
        worldPosition = vec4<f32>(root + bent * shown, 1.0);
        clipPosition = camera.uViewProjectionMatrix * worldPosition;
        output.vGrass = vec4<f32>(gust * (1.0 - press), press, along, uv.x);
        output.vTuft = vec4<f32>(instance.grass.zw, instance.road.zw);
      }`
    },
    fragment: {
      material: /* wgsl */ `{
        let along = input.vGrass.z;
        albedo = albedo * input.vTuft.x * mix(vec3<f32>(1.0), vec3<f32>(1.25, 1.12, 0.68), input.vTuft.y * (0.3 + 0.7 * along));
        albedo = mix(albedo, vec3<f32>(0.9, 0.86, 0.72), step(1.5, input.vTuft.z) * input.vGrass.w * step(0.8, along));
        albedo = albedo * ((0.82 + 0.18 * along) * vec3<f32>(1.0) + input.vGrass.x * along * vec3<f32>(0.85, 0.85, 0.6));
        albedo = albedo * mix(vec3<f32>(1.0), vec3<f32>(0.74, 0.78, 0.62), input.vGrass.y);
      }`
    }
  },
  gl: {
    vertex: {
      afterTransform: /* glsl */ `{
        vec3 root = modelMatrix[3].xyz;
        vec3 rel = worldPosition.xyz - root;
        float along = clamp(uv.y, 0.0, 1.0);
        float shown = 1.0 - uv.x * (1.0 - step(0.5, instance.road.z));
        vec2 pushed = samplePressDirect(instance.road.xy).rg * 2.0 - 1.0;
        float press = clamp(length(pushed), 0.0, 1.0);
        vec2 away = pushed / max(length(pushed), 0.001);
        vec2 wd = material.windDirection.xy;
        float across = dot(root.xz, vec2(-wd.y, wd.x));
        float travel = uTime * material.wind.z - dot(root.xz, wd) * material.wind.w;
        float swell = 0.5 + 0.5 * sin(travel + 0.8 * sin(across * 0.21 + uTime * 0.13));
        float ripple = 0.5 + 0.5 * sin(uTime * 2.1 - dot(root.xz, wd) * 1.3 + across * 0.6);
        float gust = clamp(swell * swell * 0.85 + ripple * 0.25, 0.0, 1.0);
        float flutter = sin(uTime * 3.1 + instance.grass.x * 6.0 + along * 2.0) * 0.05;
        float lean = ((material.wind.x + material.wind.y * gust) * instance.grass.y + flutter) * (1.0 - press);
        float turn = (lean + press * 1.45) * (0.3 + 0.7 * along);
        vec2 dir = normalize(mix(wd, away, press) + vec2(0.0001));
        vec3 bent = vec3(rel.x + dir.x * sin(turn) * rel.y, rel.y * cos(turn), rel.z + dir.y * sin(turn) * rel.y);
        worldPosition = vec4(root + bent * shown, 1.0);
        gl_Position = uViewProjectionMatrix * worldPosition;
        vGrass = vec4(gust * (1.0 - press), press, along, uv.x);
        vTuft = vec4(instance.grass.zw, instance.road.zw);
      }`
    },
    fragment: {
      material: /* glsl */ `{
        float along = vGrass.z;
        albedo = albedo * vTuft.x * mix(vec3(1.0), vec3(1.25, 1.12, 0.68), vTuft.y * (0.3 + 0.7 * along));
        albedo = mix(albedo, vec3(0.9, 0.86, 0.72), step(1.5, vTuft.z) * vGrass.w * step(0.8, along));
        albedo = albedo * ((0.82 + 0.18 * along) * vec3(1.0) + vGrass.x * along * vec3(0.85, 0.85, 0.6));
        albedo = albedo * mix(vec3(1.0), vec3(0.74, 0.78, 0.62), vGrass.y);
      }`
    }
  }
}

/**
 * One clump, a metre tall in its own units (the slot scales it): `BLADES` ribbons bowing out
 * of the middle, each tapering to a point and twisting a little, and one thin seed stem with
 * a head, taller than the rest.
 */
const clumpGeometry = (): Geometry3D => {
  const random = seeded(0xc1a9)
  const root = rgb(palette.bladeRoot)
  const mid = rgb(palette.bladeMid)
  const tip = rgb(palette.bladeTip)
  const seed = rgb(palette.seedHead)
  const positions: Array<number> = []
  const normals: Array<number> = []
  const uvs: Array<number> = []
  const colors: Array<number> = []
  const indices: Array<number> = []
  const vertex = (x: number, y: number, z: number, nx: number, nz: number, c: Rgb, stem: number, along: number): number => {
    const length = Math.hypot(nx, 1, nz)
    positions.push(x, y, z)
    normals.push(nx / length, 1 / length, nz / length)
    uvs.push(stem, along)
    colors.push(c[0], c[1], c[2], 1)
    return positions.length / 3 - 1
  }
  /** A ribbon from the root out along (dx, dz): `rows` pairs of vertices and a pointed tip. */
  const ribbon = (dx: number, dz: number, out: number, bow: number, height: number, width: number, twist: number, stem: number, colour: (t: number) => Rgb): void => {
    const rows = 3
    const pairs: Array<[number, number]> = []
    for (let r = 0; r < rows; r++) {
      const t = r / rows
      // The blade bows out more toward its tip, and droops a touch.
      const reach = out + bow * t ** 1.7
      const y = height * (t - 0.1 * t * t)
      // Across the blade, horizontal and turning along it.
      const a = Math.atan2(dz, dx) + Math.PI / 2 + twist * t
      const w = width * (1 - t ** 1.4 * 0.85)
      const cx = dx * reach
      const cz = dz * reach
      const c = colour(t)
      pairs.push([
        vertex(cx - Math.cos(a) * w, y, cz - Math.sin(a) * w, dx * 0.35, dz * 0.35, c, stem, t),
        vertex(cx + Math.cos(a) * w, y, cz + Math.sin(a) * w, dx * 0.35, dz * 0.35, c, stem, t)
      ])
    }
    const top = vertex(dx * (out + bow), height * 0.9, dz * (out + bow), dx * 0.5, dz * 0.5, colour(1), stem, 1)
    for (let r = 0; r + 1 < rows; r++) {
      const [a, b] = pairs[r]!
      const [c, d] = pairs[r + 1]!
      indices.push(a, b, d, a, d, c)
    }
    const [a, b] = pairs[rows - 1]!
    indices.push(a, b, top)
  }
  const shade = (t: number): Rgb => (t < 0.5 ? mix(root, mid, t * 2) : mix(mid, tip, (t - 0.5) * 2))
  for (let k = 0; k < BLADES; k++) {
    const a = (k / BLADES) * Math.PI * 2 + (random() - 0.5) * 0.5
    // Inner blades stand up, outer ones bow out further.
    const outer = k % 3 !== 0
    ribbon(Math.cos(a), Math.sin(a), 0.02 + random() * 0.05, outer ? 0.32 + random() * 0.2 : 0.12 + random() * 0.1, outer ? 0.8 + random() * 0.12 : 0.92 + random() * 0.08, 0.06 + random() * 0.015, (random() - 0.5) * 1.4, 0, shade)
  }
  // The seed stem: thin, tall, its head pale.
  const a = random() * Math.PI * 2
  ribbon(Math.cos(a), Math.sin(a), 0.01, 0.16, 1.2, 0.018, 0.3, 1, (t) => (t < 0.72 ? mix(root, mid, t) : seed))
  // The head: a wider spindle round the top of the stem.
  const hx = Math.cos(a)
  const hz = Math.sin(a)
  const base = positions.length / 3
  const reachAt = (t: number): number => 0.01 + 0.16 * t ** 1.7
  for (const [t, w] of [[0.74, 0], [0.84, 0.05], [0.95, 0.035], [1.02, 0]] as const) {
    const r = reachAt(Math.min(1, t))
    vertex(hx * r - hz * w, 1.2 * (t - 0.1 * t * t), hz * r + hx * w, hx * 0.3, hz * 0.3, scale(seed, 1.05), 1, Math.min(1, t))
    vertex(hx * r + hz * w, 1.2 * (t - 0.1 * t * t), hz * r - hx * w, hx * 0.3, hz * 0.3, scale(seed, 0.9), 1, Math.min(1, t))
  }
  for (let r = 0; r < 3; r++) {
    const v = base + r * 2
    indices.push(v, v + 1, v + 3, v, v + 3, v + 2)
  }
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    colors: new Float32Array(colors),
    indices: new Uint16Array(indices)
  })
}

/** The press map over one patch, in road coordinates: rows along the road, columns across it. */
interface PressMap {
  readonly sFrom: number
  readonly dFrom: number
  readonly columns: number
  readonly rows: number
  /** Each cell's middle on the ground. */
  readonly x: Float32Array
  readonly z: Float32Array
  /** Which way each cell's blades are bent, on the ground; the length is how far (0 upright, 1 flat). */
  readonly bendX: Float32Array
  readonly bendZ: Float32Array
  /** How fast that is changing, for a blade swinging back. */
  readonly speedX: Float32Array
  readonly speedZ: Float32Array
  readonly bytes: Uint8Array
  readonly source: BufferImageSource
}

export interface Meadow {
  readonly root: Container3D
  update(view: RaceView, seconds: number): void
}

const buildPatch = (track: TrackData, patch: SurfacePatch, root: Container3D): ((view: RaceView, seconds: number) => void) => {
  const sFrom = patch.sFrom - FRAY_ALONG
  const sTo = patch.sTo + FRAY_ALONG
  const dFrom = patch.dFrom - FRAY_ACROSS
  const dTo = patch.dTo + FRAY_ACROSS
  /** Grass never grows closer to a wall than this. */
  const wall = 0.05

  // Turf and soil under the grass, fraying out at the edge, with a soft shadow just past it.
  const turf = rgb(palette.turf)
  const turfDark = rgb(palette.turfDark)
  const soil = rgb(palette.turfSoil)
  const shadow = rgb(palette.grassShadow)
  root.addChild(
    buildOverlay(
      track,
      { sFrom: sFrom - 0.6, sTo: sTo + 0.6, dFrom: dFrom - 0.6, dTo, cell: 0.2, lift: TURF_LIFT, wall },
      (s, d, out) => {
        const r = ragged(track, patch, s, d)
        const ground = mix(mix(turf, turfDark, noise2(s * 0.7, d * 0.7) * 0.8 + noise2(s * 2.9, d * 2.9) * 0.4), soil, 0.35 + 0.65 * (1 - smooth(-0.1, 0.6, r)))
        const inside = smooth(-0.45, 0.05, r)
        const c = mix(shadow, ground, inside)
        out[0] = c[0]
        out[1] = c[1]
        out[2] = c[2]
        out[3] = inside * 0.97 + (1 - inside) * 0.32 * smooth(-1.1, -0.35, r)
      },
      "turf",
      0.95
    )
  )

  // The press map: whole cells over the patch's box, frayed edge included.
  const columns = Math.ceil((dTo - dFrom) / PRESS_CELL)
  const rows = Math.ceil((sTo - sFrom) / PRESS_CELL)
  const count = columns * rows
  const bytes = new Uint8Array(count * 4)
  for (let k = 0; k < count; k++) {
    bytes[k * 4] = 128
    bytes[k * 4 + 1] = 128
    bytes[k * 4 + 3] = 255
  }
  const source = new BufferImageSource({ resource: bytes, width: columns, height: rows, format: "rgba8unorm", alphaMode: "no-premultiply-alpha", scaleMode: "linear" })
  const press: PressMap = {
    sFrom,
    dFrom,
    columns,
    rows,
    x: new Float32Array(count),
    z: new Float32Array(count),
    bendX: new Float32Array(count),
    bendZ: new Float32Array(count),
    speedX: new Float32Array(count),
    speedZ: new Float32Array(count),
    bytes,
    source
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const p = pointAt(track, sFrom + (row + 0.5) * PRESS_CELL, dFrom + (column + 0.5) * PRESS_CELL)
      press.x[row * columns + column] = p.x
      press.z[row * columns + column] = p.z
    }
  }

  // Clumps on a jittered grid, thinner in places so the soil shows, shorter toward the frayed edge.
  const random = seeded(0x6a55 + Math.round(patch.sFrom))
  const material = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.78, metallic: 0, doubleSided: true, extraBits: [grassBit], textures: { press: new Texture({ source }) } })
  material.data.wind = WIND
  material.data.windDirection = WIND_DIRECTION
  const spots: Array<{ x: number; y: number; z: number; u: number; v: number; yaw: number; height: number; width: number; phase: number; sway: number; tone: number; dry: number; seed: number }> = []
  for (let s = sFrom; s < sTo; s += CLUMP_SPACING) {
    for (let d = dFrom; d < dTo; d += CLUMP_SPACING) {
      const ts = s + (random() - 0.5) * CLUMP_SPACING
      const td = d + (random() - 0.5) * CLUMP_SPACING
      const r = ragged(track, patch, ts, td)
      const thin = 0.55 + 0.45 * smooth(0.25, 0.65, noise2(ts * 0.45 + 7, td * 0.45 - 3))
      if (random() > smooth(-0.35, 0.45, r) * thin) continue
      const p = pointAt(track, ts, td)
      // Past the walls, or (beyond a wide bend's road) off the road: nothing grows.
      const hint = Math.round(ts / track.spacing)
      const at = locateRoad(track, p.x, p.z, hint, roadSpot())
      if (Math.abs(at.d) > (track.samples[at.index]?.halfWidth ?? 0) - wall - 0.1) continue
      const grown = 0.62 + 0.38 * smooth(-0.2, 1, r)
      const lush = noise2(ts * 0.35 + 11, td * 0.35)
      const dry = Math.max(0, noise2(ts * 0.5 - 5, td * 0.5 + 8) * 1.6 - 0.65) + random() * 0.15
      const seed = random()
      spots.push({
        x: p.x,
        y: p.y + TURF_LIFT,
        z: p.z,
        u: (td - dFrom) / (columns * PRESS_CELL),
        v: (ts - sFrom) / (rows * PRESS_CELL),
        yaw: random() * Math.PI * 2,
        height: (0.88 + random() * 0.18 + lush * 0.12) * grown,
        width: 0.9 + random() * 0.45,
        phase: random() * 6.28,
        sway: 0.75 + random() * 0.5,
        tone: 0.78 + random() * 0.3 + lush * 0.16,
        dry: Math.min(1, dry),
        // Seed stems where the grass is dry, flowers where it is lush.
        seed: seed < 0.16 + dry * 0.3 ? 1 : seed > 0.94 - lush * 0.05 ? 2 : 0
      })
    }
  }

  const geometry = clumpGeometry()
  const clumps = new BatchedMesh3D({
    label: "meadow clumps",
    size: spots.length,
    instanceData: { grass: { value: [0, 1, 1, 0], type: "vec4<f32>" }, road: { value: [0, 0, 0, 0], type: "vec4<f32>" } }
  })
  const matrix = new Matrix4()
  const size = new Matrix4()
  spots.forEach((spot, i) => {
    matrix.makeRotationY(spot.yaw).multiply(size.makeScale(spot.width, spot.height, spot.width))
    matrix.setPosition({ x: spot.x, y: spot.y, z: spot.z })
    clumps.setGeometryAt(i, geometry)
    clumps.setMaterialAt(i, material)
    clumps.setMatrixAt(i, matrix)
    clumps.setPassesAt(i, RenderPassBit.OPAQUE)
    clumps.setInstanceDataAt(i, "grass", spot.phase, spot.sway, spot.tone, spot.dry)
    clumps.setInstanceDataAt(i, "road", spot.u, spot.v, spot.seed, 0)
  })
  root.addChild(clumps)

  // Toward the camera, on the ground.
  const camX = Math.sin((CAMERA_YAW_DEG * Math.PI) / 180)
  const camZ = Math.cos((CAMERA_YAW_DEG * Math.PI) / 180)
  const spot = roadSpot()
  const { bendX, bendZ, speedX, speedZ, x: cellX, z: cellZ } = press
  /** Where the car puts the blades it touches this frame; the cells it touches are marked with the frame's number. */
  const putX = new Float32Array(count)
  const putZ = new Float32Array(count)
  const touched = new Uint32Array(count)
  let frame = 0
  let moving = false

  return (view, seconds) => {
    // Steps longer than a thirtieth of a second would overshoot the spring.
    const dt = Math.min(Math.max(seconds, 0), 1 / 30)
    const car = view.car
    frame++
    // The blades the car touches, and where it puts them.
    const reach = Math.max(BODY_HALF_LENGTH + PUSH_REACH, PRESS_FRONT) + 0.5
    let touching = false
    if (car.grounded && car.s > sFrom - reach && car.s < sTo + reach) {
      locateRoad(track, car.x, car.z, Math.round(car.s / track.spacing), spot)
      const fx = Math.sin(car.yaw)
      const fz = Math.cos(car.yaw)
      const lx = fz
      const lz = -fx
      // A faster car lays the grass further forward.
      const drive = Math.min(1, Math.abs(car.speed) / 12) * Math.sign(car.speed || 1)
      const row0 = Math.max(0, Math.floor((spot.s - reach - sFrom) / PRESS_CELL))
      const row1 = Math.min(rows - 1, Math.ceil((spot.s + reach - sFrom) / PRESS_CELL))
      const col0 = Math.max(0, Math.floor((spot.d - reach - dFrom) / PRESS_CELL))
      const col1 = Math.min(columns - 1, Math.ceil((spot.d + reach - dFrom) / PRESS_CELL))
      for (let row = row0; row <= row1; row++) {
        for (let column = col0; column <= col1; column++) {
          const k = row * columns + column
          const px = cellX[k]! - car.x
          const pz = cellZ[k]! - car.z
          const u = px * lx + pz * lz
          const v = px * fx + pz * fz
          // How far outside the body the blade's root is, and which way that is.
          const outU = Math.max(0, Math.abs(u) - BODY_HALF_WIDTH) * Math.sign(u)
          const outV = Math.max(0, Math.abs(v) - BODY_HALF_LENGTH) * Math.sign(v)
          const gap = Math.hypot(outU, outV)
          let amount = 1 - smooth(0, PUSH_REACH, gap)
          let ax: number
          let az: number
          if (gap === 0) {
            // Under the body: laid forward, a little out from the middle.
            const out = (u / BODY_HALF_WIDTH) * 0.5
            ax = lx * out + fx * drive
            az = lz * out + fz * drive
            if (drive === 0) {
              ax = lx * Math.sign(u || 1)
              az = lz * Math.sign(u || 1)
            }
          } else {
            // Beside it or ahead: away from the body, swept along with it.
            ax = (lx * outU + fx * outV) / gap + fx * drive * 0.6
            az = (lz * outU + fz * outV) / gap + fz * drive * 0.6
          }
          // In front of the car as the camera sees it: blades there would stand over the body.
          const toward = px * camX + pz * camZ
          const side = Math.abs(px * camZ - pz * camX)
          const front = toward > 0 ? 0.9 * (1 - smooth(1.1, PRESS_FRONT, toward)) * (1 - smooth(0.8, 1.2, side)) : 0
          if (front > amount) {
            amount = front
            ax = px
            az = pz
          }
          if (amount < 0.02) continue
          const length = Math.hypot(ax, az) || 1
          putX[k] = (ax / length) * amount
          putZ[k] = (az / length) * amount
          touched[k] = frame
          touching = true
        }
      }
    }
    if (!touching && !moving) return
    // Touched blades follow the car; the rest are springs on their way back to upright.
    const follow = 1 - Math.exp(-PUSH_RATE * dt)
    moving = false
    for (let k = 0; k < count; k++) {
      let bx = bendX[k]!
      let bz = bendZ[k]!
      if (touched[k] === frame) {
        bx += (putX[k]! - bx) * follow
        bz += (putZ[k]! - bz) * follow
        speedX[k] = 0
        speedZ[k] = 0
      } else {
        let vx = speedX[k]!
        let vz = speedZ[k]!
        if (bx === 0 && bz === 0 && vx === 0 && vz === 0) continue
        vx += (-SPRING * bx - DAMPING * vx) * dt
        vz += (-SPRING * bz - DAMPING * vz) * dt
        bx += vx * dt
        bz += vz * dt
        if (Math.abs(bx) + Math.abs(bz) < 0.004 && Math.abs(vx) + Math.abs(vz) < 0.03) {
          bx = 0
          bz = 0
          vx = 0
          vz = 0
        }
        speedX[k] = vx
        speedZ[k] = vz
      }
      bendX[k] = bx
      bendZ[k] = bz
      if (bx !== 0 || bz !== 0) moving = true
      bytes[k * 4] = Math.round(Math.max(-1, Math.min(1, bx)) * 127 + 128)
      bytes[k * 4 + 1] = Math.round(Math.max(-1, Math.min(1, bz)) * 127 + 128)
    }
    source.update()
  }
}

export const buildMeadow = (track: TrackData): Meadow => {
  const root = new Container3D({ label: "meadow" })
  const updates = patchesOf(track, "grass").map((patch) => buildPatch(track, patch, root))
  return {
    root,
    update(view, seconds) {
      for (const update of updates) update(view, seconds)
    }
  }
}
