/**
 * A pond in the widest stretch of open infield: a shallow bowl pressed into the terrain,
 * a reedy sand shore, and a water surface whose ripples are a shader bit.
 *
 * The bowl is part of the terrain's height (the pond wraps the road field, so the terrain,
 * the scenery and the bowl all agree), and the water is one flat mesh a little below the
 * terrain's top whose edge runs under the bank. The ripples only bend the surface normal
 * in the fragment shader, so the mesh never moves and the sun's glint breaks up on it the
 * way it does on real water. The water is glossy where everything else is matte: it is the
 * one place the view's sky gradient shows as a reflection.
 *
 * Reeds stand in clumps along part of the shore: one `BatchedMesh3D` of tufts, each slot
 * with its own matrix and a sway phase in its instance data, swaying in a vertex shader
 * bit, so they cost one draw however many there are.
 */
import { BatchedMesh3D, Container3D, Geometry3D, Material3D, Matrix4, Mesh3D, RenderPassBit, type ShaderBit } from "@pixi/3d"
import type { TrackData } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { MeshBuilder, mix, noise2, rgb, seeded, type Vec3 } from "./builder.ts"
import type { SlabBox } from "./dimensions.ts"
import type { Field, TerrainPoint } from "./field.ts"

/** Grass kept between the pond's shore and the nearest road's wall band. */
const ROAD_GAP = 3.5
/** Biggest and smallest pond worth drawing (mean radius, metres). */
const MAX_RADIUS = 6.5
const MIN_RADIUS = 3
/** Depth of the bowl at its middle, and the water's level below the terrain's top. */
const DEPTH = 0.75
const WATER_DROP = 0.24

export interface Pond {
  readonly x: number
  readonly z: number
  /** The bowl's rim at angle `a` (radians around +Y from +X toward +Z). */
  rim(a: number): number
  /** How far down the bowl presses the terrain at a point, 0 outside. */
  dent(x: number, z: number): number
  /** 1 on the wet shore and in the bowl, fading to 0 on the grass around it. */
  shore(x: number, z: number): number
}

/** Finds room for a pond: the open point farthest from any road and the slab's edge. */
export const placePond = (field: Field, slab: SlabBox): Pond | null => {
  let best = { x: 0, z: 0, room: 0 }
  const probe: TerrainPoint = { h: 0, covered: false }
  for (let x = slab.minX + 4; x < slab.maxX - 4; x += 1) {
    for (let z = slab.minZ + 4; z < slab.maxZ - 4; z += 1) {
      const edge = Math.min(x - slab.minX, slab.maxX - x, z - slab.minZ, slab.maxZ - z) - 1
      const room = Math.min(field.clearance(x, z) - ROAD_GAP, edge)
      if (room <= best.room) continue
      const ground = field.heightAt(x, z, probe)
      if (ground.covered || Math.abs(ground.h - field.top) > 0.01) continue
      best = { x, z, room }
    }
  }
  // The rim reaches 1.25 times the mean radius at its widest lobe.
  const radius = Math.min(MAX_RADIUS, best.room / 1.25)
  if (radius < MIN_RADIUS) return null
  const { x, z } = best
  const rim = (a: number): number => radius * (1 + 0.16 * Math.sin(2 * a + 0.7) + 0.09 * Math.sin(3 * a + 2.1))
  const relative = (px: number, pz: number): number => Math.hypot(px - x, pz - z) / rim(Math.atan2(pz - z, px - x))
  return {
    x,
    z,
    rim,
    dent(px, pz) {
      const r = relative(px, pz)
      if (r >= 1) return 0
      const t = Math.min(1, Math.max(0, (1 - r) / 0.45))
      return DEPTH * t * t * (3 - 2 * t)
    },
    shore(px, pz) {
      const r = relative(px, pz)
      return Math.min(1, Math.max(0, (1.16 - r) / 0.3))
    }
  }
}

/** The road field with the pond's bowl pressed into it. */
export const withPond = (field: Field, pond: Pond | null): Field => {
  if (pond === null) return field
  return {
    ...field,
    heightAt(x, z, out) {
      const point = field.heightAt(x, z, out)
      const dent = pond.dent(x, z)
      if (dent > 0 && !point.covered) point.h = Math.min(point.h, field.top - dent)
      return point
    }
  }
}

/**
 * Ripples: a few slow waves of different lengths and directions, summed as slopes and
 * bent into the normal. Their crests drift with time, so the glint shimmers gently.
 */
export const rippleBit: ShaderBit = {
  name: "flyingLapRipples",
  bindings: { material: { ripple: "vec4<f32>" } },
  gpu: {
    fragment: {
      material: /* wgsl */ `{
        let p = input.vPosition.xz;
        let t = global.uTime * material.ripple.y;
        var slope = vec2<f32>(0.0);
        slope += vec2<f32>(0.80, 0.60) * cos(dot(p, vec2<f32>(0.80, 0.60)) * 2.1 + t * 1.3);
        slope += vec2<f32>(-0.45, 0.89) * cos(dot(p, vec2<f32>(-0.45, 0.89)) * 3.3 - t * 1.7) * 0.6;
        slope += vec2<f32>(0.97, -0.24) * cos(dot(p, vec2<f32>(0.97, -0.24)) * 5.2 + t * 2.3) * 0.35;
        slope += vec2<f32>(-0.70, -0.71) * cos(dot(p, vec2<f32>(-0.70, -0.71)) * 7.9 - t * 2.9) * 0.2;
        normal = normalize(vec3<f32>(-slope.x * material.ripple.x, 1.0, -slope.y * material.ripple.x));
        albedo = albedo * (1.0 + (slope.x + slope.y) * material.ripple.z);
      }`,
      lobePostLighting: /* wgsl */ `{
        let over = max(finalColor - vec3<f32>(material.ripple.w), vec3<f32>(0.0));
        finalColor = finalColor - over + over / (vec3<f32>(1.0) + over * 4.0);
      }`
    }
  },
  gl: {
    fragment: {
      material: /* glsl */ `{
        vec2 p = vPosition.xz;
        float t = uTime * material.ripple.y;
        vec2 slope = vec2(0.0);
        slope += vec2(0.80, 0.60) * cos(dot(p, vec2(0.80, 0.60)) * 2.1 + t * 1.3);
        slope += vec2(-0.45, 0.89) * cos(dot(p, vec2(-0.45, 0.89)) * 3.3 - t * 1.7) * 0.6;
        slope += vec2(0.97, -0.24) * cos(dot(p, vec2(0.97, -0.24)) * 5.2 + t * 2.3) * 0.35;
        slope += vec2(-0.70, -0.71) * cos(dot(p, vec2(-0.70, -0.71)) * 7.9 - t * 2.9) * 0.2;
        normal = normalize(vec3(-slope.x * material.ripple.x, 1.0, -slope.y * material.ripple.x));
        albedo = albedo * (1.0 + (slope.x + slope.y) * material.ripple.z);
      }`,
      lobePostLighting: /* glsl */ `{
        vec3 over = max(finalColor - vec3(material.ripple.w), vec3(0.0));
        finalColor = finalColor - over + over / (vec3(1.0) + over * 4.0);
      }`
    }
  }
}

/**
 * Ripple strength (normal tilt), speed, how much the waves shade the colour, and the
 * brightness (linear) above which the sun's glint is rolled off, so it sparkles softly
 * instead of flashing white.
 */
const RIPPLE = [0.16, 0.55, 0.05, 0.26]

/** The water surface: a fan of rings from the middle out past the shoreline, deep colour in the middle. */
export const buildWater = (pond: Pond, field: Field, _track: TrackData): Container3D => {
  const deep = rgb(palette.waterDeep)
  const shallow = rgb(palette.water)
  const rings = 10
  const spokes = 64
  const y = field.top - WATER_DROP
  const positions: Array<number> = [pond.x, y, pond.z]
  const colors: Array<number> = [...deep, 1]
  for (let ring = 1; ring <= rings; ring++) {
    // The outer ring reaches past the waterline (the bank covers it); colour by depth below.
    const k = (ring / rings) * 0.95
    for (let spoke = 0; spoke < spokes; spoke++) {
      const a = (spoke / spokes) * Math.PI * 2
      const r = pond.rim(a) * k
      const px = pond.x + Math.cos(a) * r
      const pz = pond.z + Math.sin(a) * r
      positions.push(px, y, pz)
      const depth = Math.min(1, Math.max(0, (pond.dent(px, pz) - WATER_DROP) / (DEPTH - WATER_DROP)))
      colors.push(...mix(shallow, deep, Math.sqrt(depth)), 1)
    }
  }
  const indices: Array<number> = []
  for (let spoke = 0; spoke < spokes; spoke++) {
    const next = (spoke + 1) % spokes
    indices.push(0, 1 + next, 1 + spoke)
    for (let ring = 1; ring < rings; ring++) {
      const a = 1 + (ring - 1) * spokes
      const b = 1 + ring * spokes
      indices.push(a + spoke, a + next, b + next, a + spoke, b + next, b + spoke)
    }
  }
  const count = positions.length / 3
  const normals = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1
  const geometry = new Geometry3D({
    positions: new Float32Array(positions),
    normals,
    colors: new Float32Array(colors),
    indices: new Uint16Array(indices)
  })
  const material = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.1, metallic: 0, extraBits: [rippleBit] })
  material.data.ripple = RIPPLE
  const root = new Container3D({ label: "pond" })
  root.addChild(new Mesh3D({ label: "water", geometry, material, castShadow: false, receiveShadow: true }))
  const reeds = buildReeds(pond, field)
  if (reeds !== null) root.addChild(reeds)
  return root
}

/** Reeds lean with the breeze: the higher up a blade, the further it moves. Its phase comes from the slot. */
const swayBit: ShaderBit = {
  name: "flyingLapReedSway",
  bindings: { instance: { sway: "vec4<f32>" } },
  gpu: {
    vertex: {
      beforeTransform: /* wgsl */ `{
        let bend = position.y * position.y * instance.sway.y;
        let t = global.uTime * 1.1 + instance.sway.x;
        position = vec4<f32>(position.x + sin(t) * bend, position.y, position.z + sin(t * 0.73 + 1.3) * bend * 0.6, 1.0);
      }`
    }
  },
  gl: {
    vertex: {
      beforeTransform: /* glsl */ `{
        float bend = position.y * position.y * instance.sway.y;
        float t = uTime * 1.1 + instance.sway.x;
        position = vec4(position.x + sin(t) * bend, position.y, position.z + sin(t * 0.73 + 1.3) * bend * 0.6, 1.0);
      }`
    }
  }
}

/** One tuft a metre tall: thin blades fanning out, and a seed head on the tallest. */
const tuftGeometry = (): Geometry3D => {
  const out = new MeshBuilder()
  const foot = rgb(palette.reedDark)
  const tip = rgb(palette.reed)
  const head = rgb(palette.trunk)
  const blades = 7
  for (let k = 0; k < blades; k++) {
    const a = (k / blades) * Math.PI * 2 + k * 0.4
    const lean = 0.08 + (k % 3) * 0.07
    const height = 0.65 + ((k * 37) % 7) * 0.06
    const dx = Math.cos(a)
    const dz = Math.sin(a)
    // Across the blade, horizontal.
    const sx = -dz * 0.035
    const sz = dx * 0.035
    const base: Vec3 = [dx * 0.04, 0, dz * 0.04]
    const top: Vec3 = [dx * (0.04 + lean), height, dz * (0.04 + lean)]
    out.flat([[base[0] - sx, 0, base[2] - sz], [base[0] + sx, 0, base[2] + sz], top], [dx, 0.3, dz], [foot, foot, tip])
  }
  // A cattail: a stalk and a brown seed head.
  const stalk: Vec3 = [0.02, 0.95, 0.01]
  out.flat([[-0.012, 0, 0], [0.012, 0, 0], stalk], [0, 0.2, 1], [foot, foot, tip])
  const sides = 6
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * Math.PI * 2
    const a1 = ((k + 1) / sides) * Math.PI * 2
    const at = (a: number, y: number): Vec3 => [stalk[0] + Math.cos(a) * 0.028, y, stalk[2] + Math.sin(a) * 0.028]
    const mid = (a0 + a1) / 2
    out.flat([at(a0, 0.8), at(a1, 0.8), at(a1, 0.93), at(a0, 0.93)], [Math.cos(mid), 0, Math.sin(mid)], head)
  }
  return out.geometry()
}

const buildReeds = (pond: Pond, field: Field): BatchedMesh3D | null => {
  const random = seeded(0x2eed)
  const spots: Array<{ x: number; z: number; yaw: number; size: number }> = []
  // Along the shore just inside the waterline, in two or three clumps where the noise is high.
  for (let k = 0; k < 220 && spots.length < 44; k++) {
    const a = random() * Math.PI * 2
    if (noise2(Math.cos(a) * 1.6 + 4.2, Math.sin(a) * 1.6 - 1.3) < 0.52) continue
    const r = pond.rim(a) * (0.8 + random() * 0.1)
    const x = pond.x + Math.cos(a) * r
    const z = pond.z + Math.sin(a) * r
    if (spots.some((other) => Math.hypot(other.x - x, other.z - z) < 0.32)) continue
    spots.push({ x, z, yaw: random() * Math.PI * 2, size: 0.95 + random() * 0.5 })
  }
  if (spots.length === 0) return null
  const geometry = tuftGeometry()
  const material = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.85, metallic: 0, doubleSided: true, extraBits: [swayBit] })
  const reeds = new BatchedMesh3D({ label: "reeds", size: spots.length, instanceData: { sway: { value: [0, 0, 0, 0], type: "vec4<f32>" } } })
  const matrix = new Matrix4()
  const scale = new Matrix4()
  const probe = { h: 0, covered: false }
  spots.forEach((spot, i) => {
    const ground = field.heightAt(spot.x, spot.z, probe).h
    matrix.makeRotationY(spot.yaw).multiply(scale.makeScale(spot.size, spot.size, spot.size))
    matrix.setPosition({ x: spot.x, y: ground - 0.03, z: spot.z })
    reeds.setGeometryAt(i, geometry)
    reeds.setMaterialAt(i, material)
    reeds.setMatrixAt(i, matrix)
    reeds.setPassesAt(i, RenderPassBit.OPAQUE)
    // Neighbours sway nearly together, as one gust crosses the clump.
    reeds.setInstanceDataAt(i, "sway", spot.x * 0.35 + spot.z * 0.2 + random() * 0.6, 0.05 / spot.size, 0, 0)
  })
  return reeds
}
