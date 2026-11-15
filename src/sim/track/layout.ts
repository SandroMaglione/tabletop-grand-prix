/**
 * Spindle Leap: the game's track.
 *
 * Seen from the camera (+Z at the bottom of the screen), one lap goes:
 *
 * 1. Start straight in the middle of the table, driving away from the camera, under the
 *    jump's gap and through the ford: a pool over the right of the road, a dry lane on the
 *    left. Left turn onto the far straight, which widens for the slalom: three rows of
 *    posts, each closing the right or the left of the road in turn.
 * 2. A wide left sweeper at the far left corner with long grass over its inside, down the
 *    left side toward the camera past three heavy balls, left onto the long near straight:
 *    a boost pad, then the crate wall (two high, a gap on the left, barrels behind it),
 *    then fast esses over rough stony ground with rocks jutting out of it: the car is
 *    thrown up by each one it rolls onto.
 * 3. Banked left hairpin in the near right corner, a right kink, and the approach climbs
 *    into the spiral: a right-hand loop of 300 degrees in the far right corner that comes
 *    back over its own approach on a bridge.
 * 4. The high road runs left along the middle at 4.8 m: boost pad, kicker, and the jump
 *    over the start straight. The landing runs on, descends through a left hairpin to
 *    the ground, through the swing doors and left onto the start straight.
 *
 * Tall things (the spiral, the high road, the jump) sit on the far half or in the middle;
 * the near half is all ground.
 *
 * The jump, for gravity 24 m/s^2, top speed 30 and about 36 on boost: the lip is at
 * 6.8 m and kicks up 14 degrees, the gap is 10.5 m and the landing's edge is 1.2 m below
 * the lip (5.6 m), 4.5 m wide each side and falling gently for 28 m. Simple projectile
 * math: 16 m/s reaches the landing edge 1.7 m below its top (short), 20 m/s just clears
 * (0.7 m past the edge), 24 m/s lands 4.8 m past, 30 m/s 12.8 m and 36 m/s 23.8 m past,
 * still on the landing straight. The clearing speed is about 19.5 m/s. A car that falls
 * short comes down on the start straight, so it can never cut the lap.
 */
import { arc, buildTrack, planPath, stack, straight } from "./build.ts"
import type { TrackData } from "../types.ts"

const HALF_WIDTH = 3.25
/** Half width where the road opens out for the slalom, the balls and the crate wall. */
const WIDE = 4.6
const PAD = { length: 4, width: 3 }

/**
 * The centreline. It starts on the start line, heading -Z. The start straight and the near
 * straight are the flex pieces that close the loop; the other numbers place the rows:
 * far straight at z = -25.75, high road at z = -1.85, middle row at z = 16.15, near
 * straight at z = 27.85 (11.7 m below the middle row).
 */
const plan = planPath({ x: 6, z: 3.15, yaw: Math.PI }, [
  straight(19.4, "start", true),
  arc(9.5, 90, "turnA"),
  straight(32, "far"),
  arc(20, 90, "sweeper"),
  straight(21.6, "left"),
  arc(12, 90, "turnE"),
  straight(32, "near", true),
  arc(36, 15, "esses"),
  arc(36, -30),
  arc(36, 15),
  straight(2, "brake"),
  arc(10, 180, "banked"),
  arc(9, -60, "kink"),
  straight(12.93, "approach"),
  arc(12, -300, "spiral"),
  straight(12.75, "high"),
  straight(8, "kicker"),
  straight(10.5, "gap"),
  straight(28.25, "landing"),
  arc(9, 180, "hairpin"),
  straight(24.5, "mid"),
  arc(9, 90, "turnJ", true),
  straight(4, "grid")
])

const L = plan.length
const lip = plan.at("gap")
const land = plan.end("gap")
const far = plan.at("far")
const left = plan.at("left")
const cratesAt = plan.at("near", 30)
const padNear = plan.at("near", 8)
const padHigh = plan.at("high", 9)
const doorsAt = plan.at("mid", 14)

/**
 * The ford: a pool over the right two thirds of the start straight, where the wide line into
 * the first corner runs. Water holds the car back; the dry lane on the left is the tight line
 * into the corner. Either way is a choice, never a toss of a coin.
 */
const ford = { kind: "water", shape: "oval", sFrom: 9.5, sTo: 18, dFrom: -HALF_WIDTH, dTo: 1.2 } as const

/**
 * The meadow: long grass over the inside three quarters of the sweeper. Through it is the
 * short way round and costs a little speed; a lane stays clear along the outside wall.
 */
const meadow = { kind: "grass", shape: "strip", sFrom: plan.at("sweeper", 2), sTo: plan.end("sweeper", -2), dFrom: -1.5, dTo: HALF_WIDTH } as const

/**
 * The stony ground through the esses: rough, and still road. The rocks that jut out of it
 * are low enough to drive over, and each one the car rolls onto at speed throws it up for
 * a moment. They stand here and there with room to weave between them; the last is well
 * before the braking for the hairpin, so the car is on its wheels when it must slow.
 */
const esses = plan.at("esses")
const stones = { kind: "stones", shape: "strip", sFrom: esses + 4, sTo: plan.at("brake", -1), dFrom: -HALF_WIDTH, dTo: HALF_WIDTH } as const
const rocks = [
  { s: esses + 7, d: -1.9, radius: 0.5 },
  { s: esses + 10.5, d: 1.5, radius: 0.6 },
  { s: esses + 14, d: -0.4, radius: 0.45 },
  { s: esses + 17.5, d: 2.2, radius: 0.5 },
  { s: esses + 20.5, d: -2.1, radius: 0.65 },
  { s: esses + 23.5, d: 0.6, radius: 0.5 },
  { s: esses + 26.5, d: -1.0, radius: 0.55 },
  { s: esses + 28.5, d: 2.3, radius: 0.45 }
]

/**
 * The slalom: each row is a fence of three posts that closes one side of the road. The
 * fence slants, from the wall back toward the middle, so a car that hits it glances off
 * toward the open side instead of stopping in it; the posts stand closer than the car is
 * wide. The rows alternate and the straight line down the middle clears each by a hand's
 * width. The first row closes the left, so a car that runs wide out of the first corner has
 * the road open; the last closes the left too, which sets the car up on the right for the
 * sweeper.
 */
const slalomRows = [
  { s: far + 8, side: 1 },
  { s: far + 18, side: -1 },
  { s: far + 28, side: 1 }
]
const fence = [
  { back: 3.2, d: 3.8 },
  { back: 1.6, d: 2.6 },
  { back: 0, d: 1.4 }
]
const posts = slalomRows.flatMap((row) => fence.map((post) => ({ s: row.s - post.back, d: row.side * post.d })))
/** Cones ahead of each fence show the closed side early. */
const cones = slalomRows.flatMap((row) => [3.6, 2.6].map((d) => ({ kind: "cone" as const, s: row.s - 5.5, d: row.side * d })))

export const layoutTrack: TrackData = buildTrack({
  name: "Spindle Leap",
  plan,
  spacing: 0.5,
  halfWidth: HALF_WIDTH,
  wallHeight: 1.1,
  heights: [
    { s: 0, y: 0 },
    // The approach stays on the ground until it has passed under the bridge, then climbs
    // through the spiral at about 3.7 degrees.
    { s: plan.end("approach", -4), y: 0 },
    { s: plan.at("high", 4), y: 4.8 },
    { s: plan.at("kicker"), y: 4.8 },
    { s: lip, y: 6.8, sharp: true },
    { s: land, y: 5.6, sharp: true },
    // The landing falls gently, then the hairpin takes it down to the ground.
    { s: plan.at("landing", 10), y: 5.2 },
    { s: plan.at("mid", 4), y: 0 },
    { s: L, y: 0 }
  ],
  blend: 8,
  banks: [{ from: plan.at("banked", 4), to: plan.end("banked", -4), value: -11, ease: 6 }],
  widths: [
    { from: far + 3, to: far + 30, value: WIDE, ease: 3 },
    { from: left + 3, to: left + 19, value: WIDE, ease: 3 },
    { from: cratesAt - 9, to: cratesAt + 8, value: WIDE, ease: 5 },
    { from: land, to: land + 6, value: 4.5, ease: 8 }
  ],
  gap: { from: lip, to: land },
  solidOnly: [{ from: lip - 15, to: land + 30 }],
  props: [
    ...cones,
    // Three heavy balls down the left side, with a lane 1.1 m wide down the middle between
    // them: thread it, or pay to push one.
    { kind: "ball", s: left + 5, d: 2.4 },
    { kind: "ball", s: left + 10.5, d: -2.4 },
    { kind: "ball", s: left + 16, d: 2 },
    // The crate wall: five columns two high, 1.2 m apart, from the right wall to d = 1.9.
    // The gap on the left is 2.7 m; barrels stand behind the wall.
    ...stack("crate", cratesAt, [-3.9, -2.7, -1.5, -0.3, 0.9], 2),
    { kind: "barrel", s: cratesAt + 2.2, d: -3.1 },
    { kind: "barrel", s: cratesAt + 2.2, d: -0.9 },
    { kind: "barrel", s: cratesAt + 3.4, d: -2 }
  ],
  bollards: posts,
  bumps: rocks,
  surfaces: [ford, meadow, stones],
  doors: [doorsAt],
  boosts: [
    { s: padNear, d: 0, ...PAD },
    { s: padHigh, d: 0, ...PAD }
  ],
  checkpoints: [0, Math.round(L / 3), Math.round((2 * L) / 3)],
  features: [
    { kind: "ford", sFrom: ford.sFrom, sTo: ford.sTo },
    { kind: "slalom", sFrom: far + 3, sTo: far + 30 },
    { kind: "meadow", sFrom: meadow.sFrom, sTo: meadow.sTo },
    { kind: "balls", sFrom: left + 3, sTo: left + 19 },
    { kind: "boost", sFrom: padNear - PAD.length / 2, sTo: padNear + PAD.length / 2 },
    { kind: "crates", sFrom: cratesAt - 1, sTo: cratesAt + 4.5 },
    { kind: "rocks", sFrom: stones.sFrom, sTo: stones.sTo },
    { kind: "banked", sFrom: plan.at("banked"), sTo: plan.end("banked") },
    { kind: "spiral", sFrom: plan.at("approach"), sTo: plan.at("high", 7) },
    { kind: "boost", sFrom: padHigh - PAD.length / 2, sTo: padHigh + PAD.length / 2 },
    { kind: "jump", sFrom: plan.at("kicker"), sTo: plan.end("landing") },
    { kind: "doors", sFrom: doorsAt - 1, sTo: doorsAt + 1 }
  ],
  medals: { bronze: 32500, silver: 28900, gold: 25900 }
})
