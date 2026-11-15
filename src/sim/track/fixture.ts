/**
 * A plain oval with one jump, a crate stack, a boost pad and a gate.
 *
 * It exists so every part of the game can be built and tried before the real layout is
 * ready, and it stays as the track the tests drive. Travel is along +X on the near
 * straight (z = +18), then left around each end.
 */
import { Ops } from "@typeonce/ritmo"
import type { PropPlacement, SwingDoor, TrackData, TrackSample } from "../types.ts"
import { pointAt } from "./query.ts"

const STRAIGHT = 50
const RADIUS = 18
const HALF_WIDTH = 3.25
const WALL = 0.7
const LENGTH = 2 * STRAIGHT + 2 * Math.PI * RADIUS
const COUNT = Math.round(LENGTH / 0.5)
const SPACING = LENGTH / COUNT

/** The jump on the far straight, in metres from that straight's start. */
const RAMP_FROM = 8
const RAMP_TO = 22
const RAMP_HEIGHT = 2.6
const LAND_FROM = 31
const LAND_TO = 45
const LAND_HEIGHT = 1.6

const place = (s: number): { x: number; z: number; yaw: number; y: number; surface: boolean; support: TrackSample["support"] } => {
  const arc = Math.PI * RADIUS
  if (s < STRAIGHT) return { x: -STRAIGHT / 2 + s, z: RADIUS, yaw: Math.PI / 2, y: 0, surface: true, support: "ground" }
  if (s < STRAIGHT + arc) {
    const phi = (s - STRAIGHT) / RADIUS
    return { x: STRAIGHT / 2 + RADIUS * Ops.sin(phi), z: RADIUS * Ops.cos(phi), yaw: Math.PI / 2 + phi, y: 0, surface: true, support: "ground" }
  }
  if (s < 2 * STRAIGHT + arc) {
    const u = s - STRAIGHT - arc
    const base = { x: STRAIGHT / 2 - u, z: -RADIUS, yaw: (3 * Math.PI) / 2 }
    if (u < RAMP_FROM || u >= LAND_TO) return { ...base, y: 0, surface: true, support: "ground" }
    if (u < RAMP_TO) return { ...base, y: (RAMP_HEIGHT * (u - RAMP_FROM)) / (RAMP_TO - RAMP_FROM), surface: true, support: "solid" }
    if (u < LAND_FROM) return { ...base, y: RAMP_HEIGHT, surface: false, support: "none" }
    return { ...base, y: (LAND_HEIGHT * (LAND_TO - u)) / (LAND_TO - LAND_FROM), surface: true, support: "solid" }
  }
  const phi = (s - 2 * STRAIGHT - arc) / RADIUS
  return { x: -STRAIGHT / 2 - RADIUS * Ops.sin(phi), z: -RADIUS * Ops.cos(phi), yaw: (3 * Math.PI) / 2 + phi, y: 0, surface: true, support: "ground" }
}

const samples: ReadonlyArray<TrackSample> = Array.from({ length: COUNT }, (_, i) => {
  const s = i * SPACING
  const here = place(s)
  const next = place(((i + 1) % COUNT) * SPACING)
  return {
    s,
    x: here.x,
    y: here.y,
    z: here.z,
    yaw: here.yaw,
    pitch: here.surface && next.surface ? Ops.atan2(next.y - here.y, SPACING) : 0,
    bank: 0,
    halfWidth: HALF_WIDTH,
    surface: here.surface,
    wallLeft: here.surface,
    wallRight: here.surface,
    support: here.support
  }
})

const shell = {
  name: "Fixture oval",
  samples,
  spacing: SPACING,
  length: LENGTH,
  wallHeight: WALL
} as const

const at = (s: number, d: number = 0) => pointAt({ ...shell, checkpoints: [], start: { x: 0, y: 0, z: 0, yaw: 0 }, boosts: [], props: [], bollards: [], doors: [], bumps: [], surfaces: [], features: [], bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0, maxY: 0 }, medals: { bronze: 0, silver: 0, gold: 0 } }, s, d)

const CRATES_AT = 34
const crate = { radius: 0.6, height: 1.1 }
const props: ReadonlyArray<PropPlacement> = [-2.6, -1.4, -0.2].flatMap((d) =>
  [0, 1].map((level) => {
    const point = at(CRATES_AT, d)
    return { kind: "crate" as const, x: point.x, y: point.y + level * crate.height, z: point.z, yaw: point.yaw, ...crate }
  })
)

const arcLength = Math.PI * RADIUS
const BOOST_AT = STRAIGHT + arcLength + 3
const DOORS_AT = LENGTH - 20
const boost = at(BOOST_AT)
const doors: ReadonlyArray<SwingDoor> = [1, -1].map((side) => {
  const hinge = at(DOORS_AT, side * HALF_WIDTH)
  return { x: hinge.x, y: hinge.y, z: hinge.z, yaw: hinge.yaw - (side * Math.PI) / 2, length: HALF_WIDTH - 0.1, height: 1, thickness: 0.2, maxAngle: 1.4 }
})
const post = at(LENGTH - 34, 1.2)
const start = at(LENGTH - 3)

export const fixtureTrack: TrackData = {
  ...shell,
  checkpoints: [0, LENGTH / 3, (2 * LENGTH) / 3],
  start: { x: start.x, y: start.y, z: start.z, yaw: start.yaw },
  boosts: [{ x: boost.x, y: boost.y, z: boost.z, yaw: boost.yaw, pitch: 0, length: 4, width: 4, s: BOOST_AT }],
  props,
  bollards: [{ x: post.x, y: post.y, z: post.z, radius: 0.45, height: 1.3 }],
  doors,
  bumps: [],
  surfaces: [],
  features: [
    { kind: "crates", sFrom: CRATES_AT - 2, sTo: CRATES_AT + 2 },
    { kind: "boost", sFrom: BOOST_AT - 2, sTo: BOOST_AT + 2 },
    { kind: "jump", sFrom: STRAIGHT + arcLength + RAMP_FROM, sTo: STRAIGHT + arcLength + LAND_TO },
    { kind: "doors", sFrom: DOORS_AT - 1, sTo: DOORS_AT + 1 }
  ],
  bounds: {
    minX: -STRAIGHT / 2 - RADIUS - HALF_WIDTH - 1,
    maxX: STRAIGHT / 2 + RADIUS + HALF_WIDTH + 1,
    minZ: -RADIUS - HALF_WIDTH - 1,
    maxZ: RADIUS + HALF_WIDTH + 1,
    maxY: RAMP_HEIGHT + WALL
  },
  medals: { bronze: 30000, silver: 24000, gold: 20000 }
}
