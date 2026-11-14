/**
 * Turns a compact description of a track into `TrackData`.
 *
 * Two steps:
 *
 * 1. `planPath` lays the centreline out on the ground from pieces (straights and arcs)
 *    joined end to end. One arc may be marked `close` so the headings add up to whole
 *    turns, and two straights marked `flex` grow so the loop ends where it began. Labels on
 *    pieces give their centreline distances, so the rest of the description can say
 *    "4 m into the spiral" instead of a raw number.
 * 2. `buildTrack` samples the plan evenly, adds heights (a profile of grades joined by
 *    smooth vertical curves), bank, width, the jump gap and support, and places crates,
 *    pads and gates by centreline distance `s` and lateral offset `d`.
 */
import { Ops } from "@typeonce/ritmo"
import type { Bollard, BoostPad, PropKind, PropPlacement, SwingDoor, TrackData, TrackFeature, TrackSample } from "../types.ts"
import { pointAt } from "./query.ts"

const TAU = Math.PI * 2
const DEG = Math.PI / 180

/** A piece of centreline. Arc turns are in degrees, positive to the left. */
export type Piece =
  | { readonly kind: "straight"; readonly length: number; readonly label?: string; readonly flex?: boolean }
  | { readonly kind: "arc"; readonly radius: number; readonly turn: number; readonly label?: string; readonly close?: boolean }

export const straight = (length: number, label?: string, flex: boolean = false): Piece =>
  label === undefined ? { kind: "straight", length, flex } : { kind: "straight", length, label, flex }

export const arc = (radius: number, turn: number, label?: string, close: boolean = false): Piece =>
  label === undefined ? { kind: "arc", radius, turn, close } : { kind: "arc", radius, turn, label, close }

export interface Pose {
  readonly x: number
  readonly z: number
  readonly yaw: number
}

/** A piece with its length settled and its place on the lap. */
interface Laid {
  readonly kind: "straight" | "arc"
  readonly label: string | undefined
  readonly from: number
  readonly length: number
  readonly start: Pose
  /** Arc only: radius and side (+1 left, -1 right). */
  readonly radius: number
  readonly side: number
}

export interface Plan {
  readonly start: Pose
  readonly length: number
  readonly pieces: ReadonlyArray<Laid>
  /** Centreline distance of the start of the labelled piece, plus `offset`. Negative offsets reach back into the piece before. */
  readonly at: (label: string, offset?: number) => number
  /** Centreline distance of the end of the labelled piece, plus `offset`. */
  readonly end: (label: string, offset?: number) => number
  /** The ground position and heading at centreline distance `s`. */
  readonly pose: (s: number) => Pose
}

/** Left of heading `yaw`, on the ground. */
const leftOf = (yaw: number): { x: number; z: number } => ({ x: Ops.cos(yaw), z: -Ops.sin(yaw) })

const advance = (start: Pose, kind: "straight" | "arc", length: number, radius: number, side: number, u: number): Pose => {
  if (kind === "straight") return { x: start.x + Ops.sin(start.yaw) * u, z: start.z + Ops.cos(start.yaw) * u, yaw: start.yaw }
  const left0 = leftOf(start.yaw)
  const cx = start.x + side * radius * left0.x
  const cz = start.z + side * radius * left0.z
  const yaw = start.yaw + (side * u) / radius
  const left = leftOf(yaw)
  return { x: cx - side * radius * left.x, z: cz - side * radius * left.z, yaw }
}

const pieceLength = (piece: Piece, turn: number): number => (piece.kind === "straight" ? piece.length : (Math.abs(turn) * DEG * piece.radius))

/**
 * Lay the pieces out from `start`. The `close` arc's turn is changed to the nearest value
 * of the same sign that makes the headings add up to whole turns, then the two `flex`
 * straights are lengthened so the end meets the start. Throws if that needs a flex straight
 * to shrink below 1 m. Pass `close = false` while drafting to see where the pieces land
 * with the flex straights at their given lengths.
 */
export const planPath = (start: Pose, pieces: ReadonlyArray<Piece>, close: boolean = true): Plan => {
  const closing = pieces.findIndex((piece) => piece.kind === "arc" && piece.close === true)
  const turns = pieces.map((piece) => (piece.kind === "arc" ? piece.turn : 0))
  if (closing >= 0) {
    const others = turns.reduce((sum, turn, i) => (i === closing ? sum : sum + turn), 0)
    const own = turns[closing] ?? 0
    let best = own
    let bestError = Number.MAX_VALUE
    for (let k = -4; k <= 4; k++) {
      const candidate = 360 * k - others
      if (Math.sign(candidate) !== Math.sign(own)) continue
      const error = Math.abs(candidate - own)
      if (error < bestError) {
        bestError = error
        best = candidate
      }
    }
    turns[closing] = best
  }
  const total = turns.reduce((sum, turn) => sum + turn, 0)
  if (Math.abs(total / 360 - Math.round(total / 360)) > 1e-9) throw new Error(`Headings add up to ${total} degrees, not whole turns`)

  const lay = (lengths: ReadonlyArray<number>): { laid: Array<Laid>; end: Pose } => {
    const laid: Array<Laid> = []
    let pose = start
    let from = 0
    pieces.forEach((piece, i) => {
      const length = lengths[i] ?? 0
      const radius = piece.kind === "arc" ? piece.radius : Infinity
      const side = piece.kind === "arc" ? Math.sign(turns[i] ?? 0) : 0
      laid.push({ kind: piece.kind, label: piece.label, from, length, start: pose, radius, side })
      pose = advance(pose, piece.kind, length, radius, side, length)
      from += length
    })
    return { laid, end: pose }
  }

  const base = pieces.map((piece, i) => pieceLength(piece, turns[i] ?? 0))
  const flexes = pieces.flatMap((piece, i) => (piece.kind === "straight" && piece.flex === true ? [i] : []))
  const [fa, fb] = flexes
  if (flexes.length !== 2 || fa === undefined || fb === undefined) throw new Error("Mark exactly two straights as flex")
  const first = lay(base)
  const dirA = first.laid[fa]?.start.yaw ?? 0
  const dirB = first.laid[fb]?.start.yaw ?? 0
  // Solve a * dirA + b * dirB = start - end for the extra lengths a and b.
  const ax = Ops.sin(dirA)
  const az = Ops.cos(dirA)
  const bx = Ops.sin(dirB)
  const bz = Ops.cos(dirB)
  const ex = start.x - first.end.x
  const ez = start.z - first.end.z
  const det = ax * bz - az * bx
  if (Math.abs(det) < 1e-6) throw new Error("The two flex straights are parallel")
  const a = (ex * bz - ez * bx) / det
  const b = (ax * ez - az * ex) / det
  const lengths = base.slice()
  lengths[fa] = (lengths[fa] ?? 0) + (close ? a : 0)
  lengths[fb] = (lengths[fb] ?? 0) + (close ? b : 0)
  if (close && (lengths[fa] ?? 0) < 1 || (lengths[fb] ?? 0) < 1) {
    throw new Error(`The loop does not close with positive flex straights (${(lengths[fa] ?? 0).toFixed(2)}, ${(lengths[fb] ?? 0).toFixed(2)})`)
  }
  const { laid } = lay(lengths)
  const length = lengths.reduce((sum, value) => sum + value, 0)

  const find = (label: string): Laid => {
    const piece = laid.find((entry) => entry.label === label)
    if (piece === undefined) throw new Error(`No piece labelled ${label}`)
    return piece
  }
  const pieceAt = (s: number): Laid => {
    const wrapped = ((s % length) + length) % length
    let found = laid[0]
    for (const piece of laid) if (piece.from <= wrapped) found = piece
    if (found === undefined) throw new Error("The plan has no pieces")
    return found
  }
  return {
    start,
    length,
    pieces: laid,
    at: (label, offset = 0) => find(label).from + offset,
    end: (label, offset = 0) => {
      const piece = find(label)
      return piece.from + piece.length + offset
    },
    pose: (s) => {
      const wrapped = ((s % length) + length) % length
      const piece = pieceAt(wrapped)
      return advance(piece.start, piece.kind, piece.length, piece.radius, piece.side, wrapped - piece.from)
    }
  }
}

/** A height at a centreline distance. Grades between keys are joined by vertical curves unless the key is `sharp`. */
export interface HeightKey {
  readonly s: number
  readonly y: number
  readonly sharp?: boolean
}

/** A stretch where a value (bank in degrees, or half width) holds, easing in and out over `ease` metres at each end. */
export interface Stretch {
  readonly from: number
  readonly to: number
  readonly value: number
  readonly ease: number
}

/** The size of each kind of prop: the radius and height of the cylinder it collides as. */
export const propShapes: Record<PropKind, { readonly radius: number; readonly height: number }> = {
  /** A cube 1.1 m on a side; its circle is a little wider than the cube's half edge, so neighbours in a row just touch. */
  crate: { radius: 0.6, height: 1.1 },
  barrel: { radius: 0.42, height: 1 },
  cone: { radius: 0.3, height: 0.7 },
  ball: { radius: 0.9, height: 1.8 }
}

/** A prop by where it stands: centreline distance, lateral offset (positive left), and how many props it stands on. */
export interface PropSpec {
  readonly kind: PropKind
  readonly s: number
  readonly d: number
  /** 0 on the road, 1 on top of one prop of the same kind, and so on. */
  readonly level?: number
  /** Turn from the road's direction, radians. */
  readonly turn?: number
}

/** Props in columns across the road at one centreline distance, each column `levels` high. */
export const stack = (kind: PropKind, s: number, columns: ReadonlyArray<number>, levels: number = 1): ReadonlyArray<PropSpec> =>
  columns.flatMap((d) => Array.from({ length: levels }, (_, level) => ({ kind, s, d, level })))

export interface TrackSpec {
  readonly name: string
  readonly plan: Plan
  /** Target spacing; the real one is `length / count`, as close to this as a whole count allows. */
  readonly spacing: number
  readonly halfWidth: number
  readonly wallHeight: number
  /** Heights along the lap. The first must be at s = 0 and the last at s = length, both at the same height. */
  readonly heights: ReadonlyArray<HeightKey>
  /** Length of the vertical curve that rounds each non-sharp height key. */
  readonly blend: number
  readonly banks: ReadonlyArray<Stretch>
  readonly widths: ReadonlyArray<Stretch>
  /** The jump gap: no surface, no walls. `from` is the lip, `to` the start of the landing. */
  readonly gap: { readonly from: number; readonly to: number }
  /** Stretches that stay solid even with road below near them (a jump's ramp and landing end in cliffs, not decks). */
  readonly solidOnly: ReadonlyArray<{ readonly from: number; readonly to: number }>
  readonly props: ReadonlyArray<PropSpec>
  /** Fixed posts, by centreline distance and lateral offset. */
  readonly bollards: ReadonlyArray<{ readonly s: number; readonly d: number }>
  /** Swing doors: at each distance two leaves, hinged at the two walls, meet in the middle of the road. */
  readonly doors: ReadonlyArray<number>
  readonly boosts: ReadonlyArray<{ readonly s: number; readonly d: number; readonly length: number; readonly width: number }>
  readonly checkpoints: ReadonlyArray<number>
  readonly features: ReadonlyArray<TrackFeature>
  readonly medals: TrackData["medals"]
}

/** Height and grade of the profile at `s`. */
export const profile = (keys: ReadonlyArray<HeightKey>, blend: number, s: number): { y: number; grade: number } => {
  const count = keys.length
  let i = 0
  while (i < count - 2 && (keys[i + 1]?.s ?? Infinity) <= s) i++
  const a = keys[i]
  const b = keys[i + 1]
  if (a === undefined || b === undefined) throw new Error("A profile needs at least two keys")
  const gradeOf = (k: number): number => {
    const p = keys[k]
    const q = keys[k + 1]
    return p === undefined || q === undefined ? 0 : (q.y - p.y) / (q.s - p.s)
  }
  const curveAt = (k: number): number => {
    const key = keys[k]
    const prev = keys[k - 1]
    const next = keys[k + 1]
    if (key === undefined || prev === undefined || next === undefined || key.sharp === true) return 0
    return Math.min(blend, key.s - prev.s, next.s - key.s)
  }
  const grade = gradeOf(i)
  // Inside the vertical curve around key i + 1 (end of this segment)?
  const bEnd = curveAt(i + 1)
  if (bEnd > 0 && s > b.s - bEnd / 2) {
    const g2 = gradeOf(i + 1)
    const u = s - (b.s - bEnd / 2)
    return { y: b.y + grade * (s - b.s) + ((g2 - grade) * u * u) / (2 * bEnd), grade: grade + ((g2 - grade) * u) / bEnd }
  }
  // Inside the vertical curve around key i (start of this segment)?
  const bStart = curveAt(i)
  if (bStart > 0 && s < a.s + bStart / 2) {
    const g0 = gradeOf(i - 1)
    const u = s - (a.s - bStart / 2)
    return { y: a.y + g0 * (s - a.s) + ((grade - g0) * u * u) / (2 * bStart), grade: g0 + ((grade - g0) * u) / bStart }
  }
  return { y: a.y + grade * (s - a.s), grade }
}

const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

/** The value a set of stretches gives at `s`, or `fallback` outside them. */
const stretchAt = (stretches: ReadonlyArray<Stretch>, s: number, fallback: number): number => {
  for (const stretch of stretches) {
    if (s < stretch.from - stretch.ease || s > stretch.to + stretch.ease) continue
    const t = s < stretch.from ? smooth((s - (stretch.from - stretch.ease)) / stretch.ease) : s > stretch.to ? smooth((stretch.to + stretch.ease - s) / stretch.ease) : 1
    return fallback + (stretch.value - fallback) * t
  }
  return fallback
}

const inside = (ranges: ReadonlyArray<{ readonly from: number; readonly to: number }>, s: number): boolean => ranges.some((range) => s >= range.from && s <= range.to)

/** How far the bridge marking reaches along the deck past the last point over lower road. */
const BRIDGE_REACH = 4
/** Lower road counts as under a deck when it is this much lower. */
const BRIDGE_DROP = 3
const BOLLARD = { radius: 0.45, height: 1.3 }
/** A door leaf; `seam` is the gap between the two leaves of a pair. It stops a little short of lying flat on the wall. */
const DOOR = { height: 1, thickness: 0.2, seam: 0.2, maxAngle: 1.4 }

/** Ground is y = 0 within this. */
const GROUND = 0.03

export const buildTrack = (spec: TrackSpec): TrackData => {
  const { plan } = spec
  const length = plan.length
  const count = Math.round(length / spec.spacing)
  const spacing = length / count
  const first = spec.heights[0]
  const last = spec.heights[spec.heights.length - 1]
  if (first === undefined || last === undefined || first.s !== 0 || Math.abs(last.s - length) > 1e-6 || first.y !== last.y) {
    throw new Error("Height keys must run from s = 0 to s = length at the same height")
  }
  for (let k = 1; k < spec.heights.length; k++) {
    if ((spec.heights[k]?.s ?? 0) <= (spec.heights[k - 1]?.s ?? 0)) throw new Error(`Height key ${k} is not after the one before`)
  }
  const inGap = (s: number): boolean => s >= spec.gap.from && s < spec.gap.to

  const raw = Array.from({ length: count }, (_, i) => {
    const s = i * spacing
    const pose = plan.pose(s)
    const height = profile(spec.heights, spec.blend, s)
    const gap = inGap(s)
    return {
      s,
      x: pose.x,
      y: Math.max(0, height.y),
      z: pose.z,
      yaw: ((pose.yaw % TAU) + TAU) % TAU,
      pitch: Ops.atan(height.grade),
      bank: stretchAt(spec.banks, s, 0) * DEG,
      halfWidth: stretchAt(spec.widths, s, spec.halfWidth),
      surface: !gap,
      wallLeft: !gap,
      wallRight: !gap
    }
  })

  // A sample is a bridge deck when road at least BRIDGE_DROP lower passes within reach of its
  // deck; the marking then spreads BRIDGE_REACH metres along the deck both ways.
  const over = raw.map((a) => {
    if (a.y < BRIDGE_DROP || inside(spec.solidOnly, a.s) || inGap(a.s)) return false
    return raw.some((b) => {
      if (b.y > a.y - BRIDGE_DROP) return false
      const dx = a.x - b.x
      const dz = a.z - b.z
      const reach = a.halfWidth + b.halfWidth + 1
      return dx * dx + dz * dz < reach * reach
    })
  })
  const spread = Math.round(BRIDGE_REACH / spacing)
  const samples: ReadonlyArray<TrackSample> = raw.map((sample, i) => {
    let bridge = false
    for (let k = -spread; k <= spread && !bridge; k++) bridge = over[(((i + k) % count) + count) % count] === true
    const support: TrackSample["support"] = !sample.surface
      ? "none"
      : sample.y < GROUND
        ? "ground"
        : bridge && !inside(spec.solidOnly, sample.s)
          ? "bridge"
          : "solid"
    return { ...sample, y: sample.y < GROUND ? 0 : sample.y, support }
  })

  // Each run of bridge samples becomes a "bridge" feature; the list is kept in lap order.
  const bridges: Array<TrackFeature> = []
  samples.forEach((sample, i) => {
    if (sample.support !== "bridge") return
    const last = bridges[bridges.length - 1]
    const previous = samples[i - 1]
    if (last !== undefined && previous?.support === "bridge") bridges[bridges.length - 1] = { ...last, sTo: sample.s + spacing }
    else bridges.push({ kind: "bridge", sFrom: sample.s, sTo: sample.s + spacing })
  })
  const features = [...spec.features, ...bridges].sort((a, b) => a.sFrom - b.sFrom)

  const shell: TrackData = {
    name: spec.name,
    samples,
    spacing,
    length,
    wallHeight: spec.wallHeight,
    checkpoints: spec.checkpoints,
    start: { x: 0, y: 0, z: 0, yaw: 0 },
    boosts: [],
    props: [],
    bollards: [],
    doors: [],
    features,
    bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0, maxY: 0 },
    medals: spec.medals
  }

  const props: ReadonlyArray<PropPlacement> = spec.props.map((prop) => {
    const point = pointAt(shell, prop.s, prop.d)
    const shape = propShapes[prop.kind]
    return { kind: prop.kind, x: point.x, y: point.y + (prop.level ?? 0) * shape.height, z: point.z, yaw: point.yaw + (prop.turn ?? 0), ...shape }
  })
  const bollards: ReadonlyArray<Bollard> = spec.bollards.map((post) => {
    const point = pointAt(shell, post.s, post.d)
    return { x: point.x, y: point.y, z: point.z, radius: BOLLARD.radius, height: BOLLARD.height }
  })
  const doors: ReadonlyArray<SwingDoor> = spec.doors.flatMap((s) => {
    const halfWidth = samples[Math.round(s / spacing) % count]?.halfWidth ?? spec.halfWidth
    // The left leaf points right across the road, the right leaf points left.
    return [1, -1].map((side) => {
      const hinge = pointAt(shell, s, side * halfWidth)
      return { x: hinge.x, y: hinge.y, z: hinge.z, yaw: hinge.yaw - (side * Math.PI) / 2, length: halfWidth - DOOR.seam / 2, height: DOOR.height, thickness: DOOR.thickness, maxAngle: DOOR.maxAngle }
    })
  })
  const boosts: ReadonlyArray<BoostPad> = spec.boosts.map((pad) => {
    const point = pointAt(shell, pad.s, pad.d)
    return { x: point.x, y: point.y, z: point.z, yaw: point.yaw, pitch: point.pitch, length: pad.length, width: pad.width, s: pad.s }
  })
  const behind = pointAt(shell, length - 3)

  // The box holds both edges of every sample, one metre out for the wall tops.
  const origin = samples[0]
  if (origin === undefined) throw new Error("The track has no samples")
  let minX = origin.x
  let maxX = origin.x
  let minZ = origin.z
  let maxZ = origin.z
  let maxY = 0
  for (const sample of samples) {
    const left = leftOf(sample.yaw)
    const reach = sample.halfWidth + 1
    for (const side of [-1, 1]) {
      const x = sample.x + side * left.x * reach
      const z = sample.z + side * left.z * reach
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
    const edge = sample.y + sample.halfWidth * Math.abs(Ops.tan(sample.bank))
    maxY = Math.max(maxY, edge + spec.wallHeight)
  }

  return {
    ...shell,
    start: { x: behind.x, y: behind.y, z: behind.z, yaw: behind.yaw },
    boosts,
    props,
    bollards,
    doors,
    bounds: { minX, maxX, minZ, maxZ, maxY }
  }
}
