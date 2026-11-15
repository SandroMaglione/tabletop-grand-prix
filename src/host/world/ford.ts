/**
 * The ford: a pool of water lying across the road where the track says water.
 *
 * Three layers over the asphalt, all in road coordinates so they follow the road:
 * - a wet bed (`overlay.ts`): the road darkens under the water and stays damp a little way
 *   past the shoreline, fraying out with noise, so the pool has a soft edge;
 * - the water: an oval fan whose alpha rises from nothing at the shoreline, glossy, with the
 *   pond's ripple bit (`pond.ts`) bending its normals;
 * - rings the car makes: a second shader bit reads twelve ring sources (where, how old, how
 *   strong) from the material's data and adds their travelling crests to the surface normal
 *   and a pale crest colour. A wheel in the water drops a ring every few hundredths of a
 *   second while it moves, harder with speed, and driving in drops a big one: the wake and
 *   the splash spread over the pool on the GPU, with no geometry moving.
 * The splash and the spray themselves are particles, in the actors.
 */
import { Container3D, Geometry3D, Material3D, Mesh3D, type ShaderBit } from "@pixi/3d"
import { pointAt, type RaceView, type SurfacePatch, type TrackData } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { mix, noise2, rgb } from "./builder.ts"
import { buildOverlay } from "./overlay.ts"
import { halfWidthAt, locateRoad, patchDepth, patchesOf, roadSpot } from "./patches.ts"
import { rippleBit } from "./pond.ts"

/** Ring sources the water shader reads; the oldest is written over. */
const RINGS = 12
/** A ring's crest runs out at this many metres a second and is gone after `RING_LIFE` seconds. */
const RING_LIFE = 2.4
/** Seconds between rings from one wheel while it moves through the water. */
const RING_EVERY = 0.07
/** The water over the road, and the bed. */
const WATER_LIFT = 0.075
const BED_LIFT = 0.016
/** How far the damp bed reaches past the shoreline, metres. */
const DAMP_REACH = 1.4
/** Wheel contacts in the car's frame, as in `actors/car.ts`. */
const WHEEL_X = 0.54
const WHEEL_Z = 0.78

/** Each ring's crests: a band a few crests wide running out from its source, fading with age. */
const ringHeaderGpu = /* wgsl */ `
fn fordRing(p: vec2<f32>, ring: vec4<f32>) -> vec3<f32> {
  if (ring.w <= 0.0) { return vec3<f32>(0.0); }
  let off = p - ring.xy;
  let dist = length(off) + 0.0001;
  let x = dist - (0.1 + ring.z * 1.55);
  let env = exp(-x * x * 7.0) * ring.w * exp(-ring.z * 1.5) * smoothstep(0.0, 0.25, dist);
  let slope = cos(x * 12.0) * env * 2.4;
  return vec3<f32>(off / dist * slope, max(sin(x * 12.0 + 1.3), 0.0) * env);
}
`
const ringHeaderGl = /* glsl */ `
vec3 fordRing(vec2 p, vec4 ring) {
  if (ring.w <= 0.0) { return vec3(0.0); }
  vec2 off = p - ring.xy;
  float dist = length(off) + 0.0001;
  float x = dist - (0.1 + ring.z * 1.55);
  float env = exp(-x * x * 7.0) * ring.w * exp(-ring.z * 1.5) * smoothstep(0.0, 0.25, dist);
  float slope = cos(x * 12.0) * env * 2.4;
  return vec3(off / dist * slope, max(sin(x * 12.0 + 1.3), 0.0) * env);
}
`

const ringNames = Array.from({ length: RINGS }, (_, i) => `ring${i}`)
const sumRings = (prefix: string): string => ringNames.map((name) => `rings += fordRing(p, ${prefix}${name});`).join("\n        ")

const ringsBit: ShaderBit = {
  name: "tabletopFordRings",
  bindings: { material: Object.fromEntries(ringNames.map((name) => [name, "vec4<f32>"])) },
  gpu: {
    header: ringHeaderGpu,
    fragment: {
      material: /* wgsl */ `{
        let p = input.vPosition.xz;
        var rings = vec3<f32>(0.0);
        ${sumRings("material.")}
        normal = normalize(normal + vec3<f32>(-rings.x, 0.0, -rings.y) * 0.6);
        let crest = clamp(rings.z, 0.0, 1.0);
        albedo = mix(albedo, vec3<f32>(0.86, 0.9, 0.9), crest * 0.38);
        alpha = max(alpha, crest * 0.6 * step(0.02, alpha));
      }`
    }
  },
  gl: {
    header: ringHeaderGl,
    fragment: {
      material: /* glsl */ `{
        vec2 p = vPosition.xz;
        vec3 rings = vec3(0.0);
        ${sumRings("material.")}
        normal = normalize(normal + vec3(-rings.x, 0.0, -rings.y) * 0.6);
        float crest = clamp(rings.z, 0.0, 1.0);
        albedo = mix(albedo, vec3(0.86, 0.9, 0.9), crest * 0.38);
        alpha = max(alpha, crest * 0.6 * step(0.02, alpha));
      }`
    }
  }
}

/** Ripple strength, speed, colour shading, glint roll-off (as the pond's), a little livelier for shallow water. */
const RIPPLE = [0.18, 0.75, 0.07, 0.34]

/** The shoreline's wobble around the oval, as a fraction of its size. */
const shoreline = (a: number): number => 1 + 0.035 * Math.sin(3 * a + 0.8) + 0.025 * Math.sin(5 * a + 2.3)

const buildWaterMesh = (track: TrackData, patch: SurfacePatch, material: Material3D): Mesh3D => {
  const semiS = (patch.sTo - patch.sFrom) / 2
  const semiD = (patch.dTo - patch.dFrom) / 2
  const midS = patch.sFrom + semiS
  const midD = patch.dFrom + semiD
  const shallow = rgb(palette.fordShallow)
  const deep = rgb(palette.fordDeep)
  const edge = rgb(palette.spray)
  const rings = 14
  const spokes = 72
  const positions: Array<number> = []
  const colors: Array<number> = []
  const place = (a: number, k: number): void => {
    const r = k * shoreline(a)
    const s = midS + Math.cos(a) * r * semiS
    const hw = halfWidthAt(track, s)
    const d = Math.min(hw - 0.01, Math.max(-hw + 0.01, midD + Math.sin(a) * r * semiD))
    const p = pointAt(track, s, d)
    positions.push(p.x, p.y + WATER_LIFT, p.z)
    // Metres to the shoreline: a crisp edge with a pale wet line along it, deeper colour inward.
    const depth = Math.max(0, patchDepth(track, patch, s, d) + (shoreline(a) - 1) * Math.min(semiS, semiD))
    const c = mix(mix(shallow, deep, Math.min(1, depth / 1.4) + (noise2(s * 0.8, d * 0.8) - 0.5) * 0.25), edge, Math.max(0, 1 - depth / 0.14) * 0.4)
    // Clearer in the shallows, so the dark bed shows through and the pool has depth.
    colors.push(c[0], c[1], c[2], Math.min(1, depth / 0.1) * (0.68 + 0.22 * Math.min(1, depth / 1.2)))
  }
  place(0, 0)
  for (let ring = 1; ring <= rings; ring++) {
    // Rings crowd toward the shore, where the alpha changes.
    const k = Math.sqrt(ring / rings)
    for (let spoke = 0; spoke < spokes; spoke++) place((spoke / spokes) * Math.PI * 2, k)
  }
  const indices: Array<number> = []
  for (let spoke = 0; spoke < spokes; spoke++) {
    const next = (spoke + 1) % spokes
    indices.push(0, 1 + spoke, 1 + next)
    for (let ring = 1; ring < rings; ring++) {
      const a = 1 + (ring - 1) * spokes
      const b = 1 + ring * spokes
      indices.push(a + spoke, b + spoke, b + next, a + spoke, b + next, a + next)
    }
  }
  const count = positions.length / 3
  const normals = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1
  const geometry = new Geometry3D({ positions: new Float32Array(positions), normals, colors: new Float32Array(colors), indices: new Uint16Array(indices) })
  return new Mesh3D({ label: "ford water", geometry, material, castShadow: false, receiveShadow: true })
}

export interface Ford {
  readonly root: Container3D
  update(view: RaceView, seconds: number): void
}

export const buildFord = (track: TrackData): Ford => {
  const root = new Container3D({ label: "ford" })
  const patches = patchesOf(track, "water")
  // The fan's winding follows the road's direction, which may run either way round: draw both faces.
  const material = new Material3D({ baseColor: 0xffffff, vertexColors: true, alphaMode: "blend", roughness: 0.08, metallic: 0, doubleSided: true, extraBits: [rippleBit, ringsBit] })
  material.data.ripple = RIPPLE
  const rings: Array<Float32Array> = ringNames.map((name) => {
    material.data[name] = [0, 0, 0, 0]
    return material.data[name] as Float32Array
  })
  const bed = rgb(palette.fordBed)
  for (const patch of patches) {
    const hw = halfWidthAt(track, (patch.sFrom + patch.sTo) / 2)
    root.addChild(
      buildOverlay(
        track,
        { sFrom: patch.sFrom - DAMP_REACH - 0.6, sTo: patch.sTo + DAMP_REACH + 0.6, dFrom: Math.max(-hw, patch.dFrom - DAMP_REACH - 0.6), dTo: Math.min(hw, patch.dTo + DAMP_REACH + 0.6), cell: 0.2, lift: BED_LIFT },
        (s, d, out) => {
          const depth = patchDepth(track, patch, s, d) + (noise2(s * 1.6 + 2, d * 1.6 - 7) - 0.5) * 0.7
          out[0] = bed[0]
          out[1] = bed[1]
          out[2] = bed[2]
          // Under the water the road is dark and wet; past the shore it dries out over a metre or so.
          out[3] = depth > 0 ? 0.75 : Math.max(0, 0.6 * (1 + depth / DAMP_REACH))
        },
        "ford bed",
        0.35
      )
    )
    root.addChild(buildWaterMesh(track, patch, material))
  }

  const spot = roadSpot()
  const wheelClock = new Float32Array(4)
  let cursor = 0
  let changed = false
  let wasIn = false
  let lastX = 0
  let lastZ = 0
  let hasLast = false

  const inWater = (x: number, z: number, hint: number): boolean => {
    locateRoad(track, x, z, hint, spot)
    for (const patch of patches) if (patchDepth(track, patch, spot.s, spot.d) > 0) return true
    return false
  }
  const drop = (x: number, z: number, strength: number): void => {
    const ring = rings[cursor]!
    cursor = (cursor + 1) % RINGS
    ring[0] = x
    ring[1] = z
    ring[2] = 0
    ring[3] = strength
    changed = true
  }

  return {
    root,
    update(view, seconds) {
      if (patches.length === 0) return
      const dt = Math.min(Math.max(seconds, 0), 0.1)
      for (const ring of rings) {
        if (ring[3] === 0) continue
        ring[2] = ring[2]! + dt
        if (ring[2]! > RING_LIFE) ring[3] = 0
        changed = true
      }
      const car = view.car
      // A jump in place (a restart, a replay) is not a drive into the water.
      const jumped = hasLast && Math.hypot(car.x - lastX, car.z - lastZ) > Math.max(4, Math.abs(car.speed) * 0.3 + 1)
      lastX = car.x
      lastZ = car.z
      hasLast = true
      const inside = car.grounded && car.surface === "water"
      if (inside && !wasIn && !jumped) drop(car.x, car.z, 1.6 + Math.min(1, Math.abs(car.speed) / 20))
      wasIn = inside
      const speed = Math.abs(car.speed)
      if (car.grounded && speed > 0.8) {
        const hint = Math.round(car.s / track.spacing)
        const fx = Math.sin(car.yaw)
        const fz = Math.cos(car.yaw)
        for (let w = 0; w < 4; w++) {
          const side = w % 2 === 0 ? WHEEL_X : -WHEEL_X
          const along = w < 2 ? WHEEL_Z : -WHEEL_Z
          const x = car.x + fz * side + fx * along
          const z = car.z - fx * side + fz * along
          if (!inWater(x, z, hint)) {
            wheelClock[w] = 0
            continue
          }
          wheelClock[w] = wheelClock[w]! + dt
          if (wheelClock[w]! < RING_EVERY * (w < 2 ? 1 : 1.6)) continue
          wheelClock[w] = 0
          drop(x, z, 0.25 + Math.min(1, speed / 22) * 0.75)
        }
      }
      if (changed) material.update()
      changed = false
    }
  }
}
