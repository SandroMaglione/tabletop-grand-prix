/**
 * The road and everything built along it, from the track's samples:
 * - the asphalt ribbon;
 * - on cut road, the two wall faces from the road up to the terrain (earth where the road
 *   is in a channel, concrete where it runs on a raised mass) and the wall band on top;
 * - the end face wherever a run of cut road stops: a ramp's cliff, a landing's first face,
 *   a bridge abutment, the far wall of a channel;
 * - bridge decks with parapets, and pillars that keep off the road below;
 * - painted lines, the start/finish band, checkpoint lines and kerbs, in their own mesh.
 */
import { pointAt, type TrackData } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { type MeshBuilder, mix, noise2, rgb, type Rgb, scale, type Vec3 } from "./builder.ts"
import { BRIDGE_DEPTH, BRIDGE_PARAPET, EMBANKMENT_SLOPE, type Field, type Section, WALL_BAND } from "./field.ts"
import { earthAt, grassAt } from "./terrain.ts"

const ASPHALT = rgb(palette.asphalt)
const ASPHALT_LIGHT = rgb(palette.asphaltLight)
const CONCRETE = rgb(palette.concrete)
const CONCRETE_DARK = rgb(palette.concreteDark)
const LINE = rgb(palette.line)
const INK = rgb(palette.ink)
const KERB_RED = rgb(palette.kerbRed)
const KERB_WHITE = rgb(palette.kerbWhite)
const EARTH = rgb(palette.earth)
const EARTH_DARK = rgb(palette.earthDark)
const LIP = rgb(palette.grassLip)

/** How far the wall band floats over the terrain under it, so the two never fight. */
const BAND_LIFT = 0.022
/** Paint and kerbs over the asphalt. */
const PAINT_LIFT = 0.012
const KERB_LIFT = 0.035
const KERB_WIDTH = 0.85
const KERB_BLOCK = 1.0
/** A corner tighter than this radius gets kerbs on its inside. */
const KERB_RADIUS = 34
const LINE_WIDTH = 0.14
const EDGE_LINE_INSET = 0.32
const DASH = 3
const DASH_GAP = 3.5
const PILLAR_SPACING = 7
const PILLAR_SIZE = 0.95
/** How far an abutment reaches under its deck. */
const ABUTMENT = 1.1
/** Baked ambient occlusion beside walls: how dark at the foot of a full wall, and how far it reaches. */
const AO_STRENGTH = 0.32
const AO_REACH = 0.5

const wrap = (i: number, n: number): number => ((i % n) + n) % n

const at = (section: Section, d: number, lift: number = 0): Vec3 => [section.x + section.lx * d, section.y + d * section.tanBank + lift, section.z + section.lz * d]
const atHeight = (section: Section, d: number, y: number): Vec3 => [section.x + section.lx * d, y, section.z + section.lz * d]

/** How much a wall top stands above the terrain's top: 0 a channel edge, 1 a built parapet. */
const builtness = (field: Field, wallTop: number): number => Math.min(1, Math.max(0, (wallTop - field.top - 0.05) / 0.3))

export const buildRoad = (field: Field, track: TrackData, built: MeshBuilder, paint: MeshBuilder): void => {
  const { sections, kinds } = field
  const count = sections.length
  const kindAt = (i: number) => kinds[wrap(i, count)]!
  const section = (i: number): Section => sections[wrap(i, count)]!

  // Asphalt, on every segment with a surface. The ribbon is split into lanes across its
  // width so the light can fall off toward the walls: baked ambient occlusion, darker the
  // closer and taller the wall (the view's SSAO does not work with an orthographic camera).
  const lanes = (hw: number): Array<number> => {
    const steps = [0, 0.18, 0.45, 0.9, 1.6]
    const right = steps.filter((d) => d < hw).map((d) => -hw + d)
    return [...right, 0, ...right.map((d) => -d).reverse()]
  }
  const occlusion = (s: Section, d: number): number => {
    const riseLeft = Math.max(0, field.topLeft[s.index]! - s.edgeLeft)
    const riseRight = Math.max(0, field.topRight[s.index]! - s.edgeRight)
    const fromLeft = s.hw - d
    const fromRight = s.hw + d
    const occ = AO_STRENGTH * (Math.min(1, riseLeft / 0.7) * Math.exp(-fromLeft / AO_REACH) + Math.min(1, riseRight / 0.7) * Math.exp(-fromRight / AO_REACH))
    return 1 - Math.min(0.6, occ)
  }
  const shade = (s: Section, d: number): Rgb => scale(mix(ASPHALT, ASPHALT_LIGHT, noise2(s.sample.s * 0.08, d * 0.15) * 0.55), occlusion(s, d))
  for (let i = 0; i < count; i++) {
    if (kinds[i] === "gap") continue
    const a = section(i)
    const b = section(i + 1)
    const da = lanes(a.hw)
    const db = lanes(b.hw)
    let previous: [number, number] | null = null
    for (let k = 0; k < da.length; k++) {
      const u = da[k]!
      const v = db[k] ?? u
      const pa = built.vertex(at(a, u), a.normal, shade(a, u))
      const pb = built.vertex(at(b, v), b.normal, shade(b, v))
      if (previous !== null) built.quad(previous[0], pa, pb, previous[1])
      previous = [pa, pb]
    }
  }

  // Cut road: wall faces and the band on top.
  for (let i = 0; i < count; i++) {
    if (kinds[i] !== "cut") continue
    const a = section(i)
    const b = section(i + 1)
    for (const side of [1, -1] as const) {
      const topA = side === 1 ? field.topLeft[a.index]! : field.topRight[a.index]!
      const topB = side === 1 ? field.topLeft[b.index]! : field.topRight[b.index]!
      const edgeA = side === 1 ? a.edgeLeft : a.edgeRight
      const edgeB = side === 1 ? b.edgeLeft : b.edgeRight
      const inward = (s: Section): Vec3 => [-s.lx * side, 0, -s.lz * side]
      // Packed earth in a channel, darker toward the road; concrete on a raised parapet.
      const faceColour = (top: number, low: boolean): Rgb => scale(mix(low ? EARTH_DARK : EARTH, low ? CONCRETE_DARK : CONCRETE, builtness(field, top)), low ? 0.82 : 1)
      if (topA - edgeA > 0.005 || topB - edgeB > 0.005) {
        const p0 = built.vertex(atHeight(a, a.hw * side, edgeA), inward(a), faceColour(topA, true))
        const p1 = built.vertex(atHeight(b, b.hw * side, edgeB), inward(b), faceColour(topB, true))
        const p2 = built.vertex(atHeight(b, b.hw * side, topB), inward(b), faceColour(topB, false))
        const p3 = built.vertex(atHeight(a, a.hw * side, topA), inward(a), faceColour(topA, false))
        built.quad(p0, p1, p2, p3)
      }
      // The lip of a channel catches the light a little; on a parapet it is concrete.
      const bandColour = (s: Section, d: number, top: number): Rgb => {
        const p = atHeight(s, d, top)
        return mix(mix(grassAt(p[0], p[2]), LIP, 0.45), CONCRETE, builtness(field, top))
      }
      const up: Vec3 = [0, 1, 0]
      const innerA = a.hw * side
      const innerB = b.hw * side
      const outerA = (a.hw + WALL_BAND) * side
      const outerB = (b.hw + WALL_BAND) * side
      const q0 = built.vertex(atHeight(a, innerA, topA + BAND_LIFT), up, bandColour(a, innerA, topA))
      const q1 = built.vertex(atHeight(b, innerB, topB + BAND_LIFT), up, bandColour(b, innerB, topB))
      const q2 = built.vertex(atHeight(b, outerB, topB + BAND_LIFT), up, bandColour(b, outerB, topB))
      const q3 = built.vertex(atHeight(a, outerA, topA + BAND_LIFT), up, bandColour(a, outerA, topA))
      built.quad(q0, q1, q2, q3)
    }
  }

  // End faces where a run of cut road stops.
  for (const end of field.ends) buildEndFace(field, section(end.section), end.nx, end.nz, built)

  // Bridges: deck, parapets, underside, and their own end faces.
  for (let i = 0; i < count; i++) {
    if (kinds[i] !== "bridge") continue
    buildBridgeSegment(field, section(i), section(i + 1), built)
    if (kindAt(i - 1) !== "bridge") buildBridgeEnd(field, section(i), -1, built)
    if (kindAt(i + 1) !== "bridge") buildBridgeEnd(field, section(i + 1), 1, built)
    // Where the deck rests on a solid run, a concrete abutment under it closes the space
    // between the deck and the embankment's end.
    if (kindAt(i - 1) === "cut") buildAbutment(field, section(i), 1, built)
    if (kindAt(i + 1) === "cut") buildAbutment(field, section(i + 1), -1, built)
  }
  buildPillars(field, track, built)

  buildPaint(field, track, paint)
}

/** Breakpoints of a cross-section and its top height at each, from the left wing to the right. */
const crossSection = (field: Field, s: Section, base: number): Array<{ u: number; y: number; road: boolean }> => {
  const topL = field.topLeft[s.index]!
  const topR = field.topRight[s.index]!
  const wingL = s.hw + WALL_BAND + Math.max(0, topL - base) / EMBANKMENT_SLOPE
  const wingR = s.hw + WALL_BAND + Math.max(0, topR - base) / EMBANKMENT_SLOPE
  return [
    { u: -wingR, y: base, road: false },
    { u: -(s.hw + WALL_BAND), y: topR, road: false },
    { u: -s.hw, y: topR, road: false },
    { u: -s.hw, y: s.edgeRight, road: true },
    { u: s.hw, y: s.edgeLeft, road: true },
    { u: s.hw, y: topL, road: false },
    { u: s.hw + WALL_BAND, y: topL, road: false },
    { u: wingL, y: base, road: false }
  ]
}

/**
 * The face across a cut line. Above the terrain outside, it faces out (a cliff under a
 * ramp's end, an abutment); below it, it faces into the road (the far wall of a channel
 * that starts or stops).
 */
const buildEndFace = (field: Field, s: Section, nx: number, nz: number, built: MeshBuilder): void => {
  const outside = field.heightAt(s.x + nx * 0.6, s.z + nz * 0.6, { h: 0, covered: false })
  const base = outside.covered ? field.top : outside.h
  const points = crossSection(field, s, base)
  const outward: Vec3 = [nx, 0, nz]
  const inward: Vec3 = [-nx, 0, -nz]
  const builtSide = builtness(field, Math.max(field.topLeft[s.index]!, field.topRight[s.index]!))
  for (let k = 0; k + 1 < points.length; k++) {
    const p = points[k]!
    const q = points[k + 1]!
    if (q.u - p.u < 1e-4) continue
    // Split the span where its top crosses the base, so each part lies wholly above or below.
    const spans: Array<[number, number, number, number]> = []
    if ((p.y - base) * (q.y - base) < 0) {
      const t = (base - p.y) / (q.y - p.y)
      const um = p.u + (q.u - p.u) * t
      spans.push([p.u, p.y, um, base], [um, base, q.u, q.y])
    } else spans.push([p.u, p.y, q.u, q.y])
    for (const [u0, y0, u1, y1] of spans) {
      const above = y0 + y1 > 2 * base
      if (Math.abs(y0 - base) < 1e-3 && Math.abs(y1 - base) < 1e-3) continue
      const colour = (y: number): Rgb => {
        if (!above) return earthAt(0, Math.min(1, (base - y) / 1.5))
        if (p.road || (Math.abs(u0) <= s.hw + WALL_BAND + 1e-3 && Math.abs(u1) <= s.hw + WALL_BAND + 1e-3)) return mix(earthAt(0, 0.4), CONCRETE_DARK, builtSide)
        return earthAt(0.2, Math.min(1, (y - base) / 3) * 0.3)
      }
      built.face(
        [atHeight(s, u0, base), atHeight(s, u1, base), atHeight(s, u1, y1), atHeight(s, u0, y0)],
        above ? outward : inward,
        [colour(base), colour(base), colour(y1), colour(y0)]
      )
    }
  }
}

const buildBridgeSegment = (field: Field, a: Section, b: Section, built: MeshBuilder): void => {
  for (const side of [1, -1] as const) {
    const topA = side === 1 ? field.topLeft[a.index]! : field.topRight[a.index]!
    const topB = side === 1 ? field.topLeft[b.index]! : field.topRight[b.index]!
    const edgeA = side === 1 ? a.edgeLeft : a.edgeRight
    const edgeB = side === 1 ? b.edgeLeft : b.edgeRight
    const bottomA = Math.min(a.edgeLeft, a.edgeRight) - BRIDGE_DEPTH
    const bottomB = Math.min(b.edgeLeft, b.edgeRight) - BRIDGE_DEPTH
    const inner = (s: Section): number => s.hw * side
    const outer = (s: Section): number => (s.hw + BRIDGE_PARAPET) * side
    const inward = (s: Section): Vec3 => [-s.lx * side, 0, -s.lz * side]
    const outwardOf = (s: Section): Vec3 => [s.lx * side, 0, s.lz * side]
    // Inner face of the parapet.
    built.quad(
      built.vertex(atHeight(a, inner(a), edgeA), inward(a), CONCRETE_DARK),
      built.vertex(atHeight(b, inner(b), edgeB), inward(b), CONCRETE_DARK),
      built.vertex(atHeight(b, inner(b), topB), inward(b), CONCRETE),
      built.vertex(atHeight(a, inner(a), topA), inward(a), CONCRETE)
    )
    // Top of the parapet.
    const up: Vec3 = [0, 1, 0]
    built.quad(
      built.vertex(atHeight(a, inner(a), topA), up, CONCRETE),
      built.vertex(atHeight(b, inner(b), topB), up, CONCRETE),
      built.vertex(atHeight(b, outer(b), topB), up, CONCRETE),
      built.vertex(atHeight(a, outer(a), topA), up, CONCRETE)
    )
    // Outer face, from the parapet's top down to the deck's underside.
    built.quad(
      built.vertex(atHeight(a, outer(a), topA), outwardOf(a), CONCRETE),
      built.vertex(atHeight(b, outer(b), topB), outwardOf(b), CONCRETE),
      built.vertex(atHeight(b, outer(b), bottomB), outwardOf(b), CONCRETE_DARK),
      built.vertex(atHeight(a, outer(a), bottomA), outwardOf(a), CONCRETE_DARK)
    )
    // Underside, half of it per side.
    const down: Vec3 = [0, -1, 0]
    built.quad(
      built.vertex(atHeight(a, 0, bottomA), down, CONCRETE_DARK),
      built.vertex(atHeight(b, 0, bottomB), down, CONCRETE_DARK),
      built.vertex(atHeight(b, outer(b), bottomB), down, CONCRETE_DARK),
      built.vertex(atHeight(a, outer(a), bottomA), down, CONCRETE_DARK)
    )
  }
}

/** Closes a bridge deck's end where it meets something that is not a bridge. */
const buildBridgeEnd = (field: Field, s: Section, outward: 1 | -1, built: MeshBuilder): void => {
  const normal: Vec3 = [s.fx * outward, 0, s.fz * outward]
  const bottom = Math.min(s.edgeLeft, s.edgeRight) - BRIDGE_DEPTH
  const topL = field.topLeft[s.index]!
  const topR = field.topRight[s.index]!
  const outer = s.hw + BRIDGE_PARAPET
  const spans: Array<[number, number, number, number]> = [
    [-outer, topR, -s.hw, topR],
    [-s.hw, s.edgeRight, s.hw, s.edgeLeft],
    [s.hw, topL, outer, topL]
  ]
  for (const [u0, y0, u1, y1] of spans) {
    built.face([atHeight(s, u0, bottom), atHeight(s, u1, bottom), atHeight(s, u1, y1), atHeight(s, u0, y0)], normal, CONCRETE_DARK)
  }
}

/** A block under the end of a deck, from the ground up to the deck, reaching `ABUTMENT` into the span. */
const buildAbutment = (field: Field, s: Section, into: 1 | -1, built: MeshBuilder): void => {
  const top = Math.min(s.edgeLeft, s.edgeRight) - BRIDGE_DEPTH - 0.004
  const half = s.hw + WALL_BAND
  const fx = s.fx * into * ABUTMENT
  const fz = s.fz * into * ABUTMENT
  const probe = { h: 0, covered: false }
  let ground = Number.POSITIVE_INFINITY
  for (const u of [-half, 0, half]) {
    for (const k of [0.3, 1]) {
      const p = field.heightAt(s.x + s.lx * u + fx * k, s.z + s.lz * u + fz * k, probe)
      if (!p.covered) ground = Math.min(ground, p.h)
    }
  }
  if (!Number.isFinite(ground)) ground = field.top
  ground -= 0.05
  if (top - ground < 0.2) return
  const corner = (u: number, k: number, y: number): Vec3 => [s.x + s.lx * u + fx * k, y, s.z + s.lz * u + fz * k]
  for (const side of [1, -1] as const) {
    const u = half * side
    built.face([corner(u, 0, ground), corner(u, 1, ground), corner(u, 1, top), corner(u, 0, top)], [s.lx * side, 0, s.lz * side], [CONCRETE_DARK, CONCRETE_DARK, CONCRETE, CONCRETE])
  }
  built.face([corner(-half, 1, ground), corner(half, 1, ground), corner(half, 1, top), corner(-half, 1, top)], [s.fx * into, 0, s.fz * into], [CONCRETE_DARK, CONCRETE_DARK, CONCRETE_DARK, CONCRETE_DARK])
}

/** Pillars under each bridge run, every few metres, never on the road below. */
const buildPillars = (field: Field, track: TrackData, built: MeshBuilder): void => {
  const { sections, kinds } = field
  const count = sections.length
  const probe = { h: 0, covered: false }
  let i = 0
  while (i < count) {
    if (kinds[i] !== "bridge" || kinds[wrap(i - 1, count)] === "bridge") {
      i++
      continue
    }
    let j = i
    while (kinds[wrap(j, count)] === "bridge" && j - i < count) j++
    const sFrom = sections[i]!.sample.s
    const length = (j - i) * track.spacing
    const pillars = Math.max(1, Math.floor((length - 2) / PILLAR_SPACING))
    for (let k = 0; k < pillars; k++) {
      const s = sFrom + (length * (k + 0.5)) / pillars
      const centre = sections[wrap(Math.round(s / track.spacing), count)]!
      const bottom = Math.min(centre.edgeLeft, centre.edgeRight) - BRIDGE_DEPTH
      for (const d of [0, centre.hw - 0.9, -(centre.hw - 0.9)]) {
        const x = centre.x + centre.lx * d
        const z = centre.z + centre.lz * d
        if (field.groundClearance(x, z) < PILLAR_SIZE * 0.75) continue
        const ground = field.heightAt(x, z, probe)
        if (ground.covered || bottom - ground.h < 0.4) continue
        buildBox(built, x, ground.h - 0.05, z, centre.sample.yaw, PILLAR_SIZE, bottom - ground.h + 0.05, PILLAR_SIZE, CONCRETE, CONCRETE_DARK)
        break
      }
    }
    i = j
  }
}

/** A box standing on (x, y, z), turned by `yaw`. Sides fade to `lower` at the bottom. */
export const buildBox = (built: MeshBuilder, x: number, y: number, z: number, yaw: number, width: number, height: number, depth: number, upper: Rgb, lower: Rgb): void => {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const corner = (u: number, v: number, h: number): Vec3 => [x + u * c + v * s, y + h, z - u * s + v * c]
  const w = width / 2
  const d = depth / 2
  const ring: Array<[number, number]> = [
    [-w, -d],
    [w, -d],
    [w, d],
    [-w, d]
  ]
  for (let k = 0; k < 4; k++) {
    const [u0, v0] = ring[k]!
    const [u1, v1] = ring[(k + 1) % 4]!
    const mu = (u0 + u1) / 2
    const mv = (v0 + v1) / 2
    const toward: Vec3 = [mu * c + mv * s, 0, -mu * s + mv * c]
    built.flat([corner(u0, v0, 0), corner(u1, v1, 0), corner(u1, v1, height), corner(u0, v0, height)], toward, [lower, lower, upper, upper])
  }
  built.flat(
    ring.map(([u, v]) => corner(u, v, height)),
    [0, 1, 0],
    upper
  )
}

/** Painted lines, the start/finish band, checkpoint lines and kerbs. */
const buildPaint = (field: Field, track: TrackData, paint: MeshBuilder): void => {
  const { sections, kinds } = field
  const count = sections.length
  const spacing = track.spacing
  const surfaceAt = (s: number): boolean => {
    const i = wrap(Math.floor(s / spacing), count)
    return kinds[i] !== "gap"
  }

  /** Half width at any distance, eased between samples the way the asphalt's edges are. */
  const hwAt = (s: number): number => {
    const position = s / spacing
    const i = Math.floor(position)
    const t = position - i
    const a = sections[wrap(i, count)]!.hw
    return a + (sections[wrap(i + 1, count)]!.hw - a) * t
  }
  /**
   * A strip of paint from `s0` to `s1` between lateral offsets `d0` and `d1`, in steps of a
   * sample or less. An offset may be a function of the distance, for paint that follows the
   * road's edge where the width changes.
   */
  type Offset = number | ((s: number) => number)
  const strip = (s0: number, s1: number, d0: Offset, d1: Offset, colour: Rgb, lift: number): void => {
    const steps = Math.max(1, Math.ceil((s1 - s0) / spacing - 1e-6))
    let previous: [number, number] | null = null
    for (let k = 0; k <= steps; k++) {
      const s = s0 + ((s1 - s0) * k) / steps
      const left = pointAt(track, s, typeof d1 === "number" ? d1 : d1(s))
      const right = pointAt(track, s, typeof d0 === "number" ? d0 : d0(s))
      const normal = sections[wrap(Math.round(s / spacing), count)]!.normal
      const a = paint.vertex([right.x, right.y + lift, right.z], normal, colour)
      const b = paint.vertex([left.x, left.y + lift, left.z], normal, colour)
      if (previous !== null) paint.quad(previous[0], previous[1], b, a)
      previous = [a, b]
    }
  }

  // Curvature, smoothed over a few samples: positive turns left.
  const curvature = sections.map((_, i) => {
    let total = 0
    const reach = 4
    for (let k = -reach; k < reach; k++) {
      const a = sections[wrap(i + k, count)]!.sample.yaw
      const b = sections[wrap(i + k + 1, count)]!.sample.yaw
      let delta = (b - a) % (Math.PI * 2)
      if (delta > Math.PI) delta -= Math.PI * 2
      if (delta < -Math.PI) delta += Math.PI * 2
      total += delta
    }
    return total / (2 * reach * spacing)
  })
  // Kerb runs: inside of corners tighter than KERB_RADIUS, grown a little at both ends.
  const kerbSide = new Int8Array(count)
  curvature.forEach((k, i) => {
    if (Math.abs(k) > 1 / KERB_RADIUS && kinds[i] !== "gap") kerbSide[i] = k > 0 ? 1 : -1
  })
  const grown = Int8Array.from(kerbSide)
  const grow = Math.round(2 / spacing)
  kerbSide.forEach((side, i) => {
    if (side === 0) return
    for (let k = -grow; k <= grow; k++) {
      const j = wrap(i + k, count)
      if (grown[j] === 0 && kinds[j] !== "gap") grown[j] = side
    }
  })

  for (let i = 0; i < count; i++) {
    const side = grown[i]!
    if (side === 0) continue
    const s0 = i * spacing
    const block = Math.floor(s0 / KERB_BLOCK)
    const colour = block % 2 === 0 ? KERB_RED : KERB_WHITE
    if (side === 1) strip(s0, s0 + spacing, (s) => hwAt(s) - KERB_WIDTH, hwAt, colour, KERB_LIFT)
    else strip(s0, s0 + spacing, (s) => -hwAt(s), (s) => -hwAt(s) + KERB_WIDTH, colour, KERB_LIFT)
  }

  // Edge lines, except where a kerb takes their place, and centre dashes.
  for (let i = 0; i < count; i++) {
    if (kinds[i] === "gap") continue
    const s0 = i * spacing
    const side = grown[i]!
    if (side !== 1) strip(s0, s0 + spacing, (s) => hwAt(s) - EDGE_LINE_INSET - LINE_WIDTH, (s) => hwAt(s) - EDGE_LINE_INSET, LINE, PAINT_LIFT)
    if (side !== -1) strip(s0, s0 + spacing, (s) => -hwAt(s) + EDGE_LINE_INSET, (s) => -hwAt(s) + EDGE_LINE_INSET + LINE_WIDTH, LINE, PAINT_LIFT)
  }
  // Dashes stop short of the sector lines rather than run across their checks.
  const nearLine = (s0: number, s1: number): boolean => track.checkpoints.slice(1).some((line) => line > s0 - 0.6 && line < s1 + 0.6)
  for (let s = 4; s + DASH < track.length - 4; s += DASH + DASH_GAP) {
    if (!surfaceAt(s) || !surfaceAt(s + DASH) || nearLine(s, s + DASH)) continue
    strip(s, s + DASH, -LINE_WIDTH / 2, LINE_WIDTH / 2, LINE, PAINT_LIFT)
  }

  // Start/finish and the sector lines: checkered bands two rows deep, centred on their
  // distance. The finish has big squares; a sector line is the same band at a third of the
  // size, so it reads as a timing line and not as a kerb or a wall across the road.
  const checkered = (centre: number, size: number): void => {
    const hw = hwAt(centre)
    const columns = Math.max(4, Math.round((2 * hw) / size))
    const square = (2 * hw) / columns
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < columns; column++) {
        const s0 = centre + (row - 1) * square
        const d0 = -hw + column * square
        strip(s0, s0 + square, d0, d0 + square, (row + column) % 2 === 0 ? LINE : INK, PAINT_LIFT * 1.5)
      }
    }
  }
  checkered(0, 0.65)
  for (const s of track.checkpoints.slice(1)) checkered(s, 0.24)
}
