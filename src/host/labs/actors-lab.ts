/**
 * A page to judge the actors on their own: actors-lab.html.
 *
 * `?demo=` picks what runs:
 * - `drive`: the real session drives itself with a scripted input.
 * - `still`: the car stands with its wheels turned (add `&spin=1` to turn it on a turntable).
 * - `crates`, `balls`, `slalom`, `doors`: the car drives into the real track's obstacles and a toy
 *   physics in this file pushes the props, swings the doors and sends the events, so the actors
 *   can be judged before the real physics lands. Every 7 s the attempt restarts.
 * - `gallery`: one of every kind on the start straight, each scripted through its states
 *   (resting, wobbling, toppling, tumbling, rolling, swinging) and snapped back every 6 s.
 * - `stress`: 80 props round the lap, all moving at once, for the frame rate.
 * - `jump`, `skid`, `boost`, `ghost`, `bridge`: made-up views and events, so each effect shows
 *   without the real simulation.
 *
 * `?zoom=6` zooms the camera on the car (lab only) and turns the tilt-shift off unless `&sharp=0`.
 * `?focus=18` aims the zoomed camera at centreline distance 18 instead of the car.
 * `?rank=1` paints the car for that place on the board and prints the place on its roof.
 * `?t=3` starts the demo clock 3 s in; with `&freeze=1` it stays there, for pictures. `?brake=1` holds the brakes in `still`.
 */
import { PostEffect } from "@pixi/3d"
import { OutlinePass } from "@pixi/3d/extras"
import { createSession, idleInput, locateNear, pointAt, track } from "../../sim/index.ts"
import type { Bollard, CarView, DriveInput, LapView, PropKind, PropPlacement, PropView, RaceEvent, RaceView, SwingDoor, TrackData } from "../../sim/index.ts"
import type { GhostPose } from "../contract.ts"
import { createActors } from "../actors/index.ts"
import { palette } from "../palette.ts"
import { createStage } from "../stage.ts"
import { createTrackScene } from "../world/index.ts"

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const params = new URLSearchParams(location.search)
const demo = params.get("demo") ?? "drive"
const zoom = Number(params.get("zoom") ?? "1")
const startAt = Number(params.get("t") ?? "0")
const turntable = params.get("spin") === "1"
const focus = params.get("focus")
const frozen = params.get("freeze") === "1"

const stage = await createStage(track, document.body)
// The game's stage owns the outline; add one here only if the stage did not.
if (!stage.view.passes.some((pass) => pass instanceof OutlinePass)) {
  stage.view.passes = [...stage.view.passes, new OutlinePass({ width: 0.035, color: palette.ink })]
}
// Zoomed in, the game's tilt-shift (a screen effect) blurs the model; `?sharp=0` keeps it.
if (zoom > 1 && params.get("sharp") !== "0") {
  for (const pass of stage.view.passes) if (pass instanceof PostEffect) pass.enabled = false
}
const scene = createTrackScene(stage, track)

/** Prop sizes, as the simulation's `propShapes`. */
const SHAPES: Record<PropKind, { radius: number; height: number }> = {
  crate: { radius: 0.6, height: 1.1 },
  barrel: { radius: 0.42, height: 1 },
  cone: { radius: 0.3, height: 0.7 },
  ball: { radius: 0.9, height: 1.8 }
}

/** A prop at centreline distance `s`, offset `d`, standing on `level` others. */
const propAt = (kind: PropKind, s: number, d: number, level: number = 0, turn: number = 0): PropPlacement => {
  const p = pointAt(track, s, d)
  const shape = SHAPES[kind]
  return { kind, x: p.x, y: p.y + level * shape.height, z: p.z, yaw: p.yaw + turn, ...shape }
}

/** A swing door pair at `s`, as the simulation builds them. */
const doorPair = (s: number): Array<SwingDoor> => {
  const halfWidth = track.samples[Math.round(s / track.spacing) % track.samples.length]?.halfWidth ?? 3.25
  return [1, -1].map((side) => {
    const hinge = pointAt(track, s, side * halfWidth)
    return { x: hinge.x, y: hinge.y, z: hinge.z, yaw: hinge.yaw - (side * Math.PI) / 2, length: halfWidth - 0.1, height: 1, thickness: 0.2, maxAngle: 1.4 }
  })
}

/** The gallery's own things on the start straight; the real ones stay where they are. */
const GALLERY = { s: 10 }
const galleryTrack = (): TrackData => {
  const s = GALLERY.s
  const bollard = pointAt(track, s + 11, 1.9)
  const post: Bollard = { x: bollard.x, y: bollard.y, z: bollard.z, radius: 0.45, height: 1.3 }
  return {
    ...track,
    props: [
      propAt("crate", s, -2.1),
      propAt("crate", s, -2.1, 1, 0.2),
      propAt("crate", s, -0.9),
      propAt("crate", s - 1.5, 1.9),
      propAt("barrel", s + 5, -2.2),
      propAt("barrel", s + 5, -0.8),
      propAt("cone", s + 5, 0.8),
      propAt("cone", s + 5, 2.2),
      propAt("ball", s + 11, -1.4)
    ],
    bollards: [post],
    doors: doorPair(s + 17)
  }
}
/** For `stress`: 80 props spread round the lap, all moving at once. */
const STRESS = 80
const stressTrack = (): TrackData => {
  const kinds: ReadonlyArray<PropKind> = ["crate", "barrel", "cone", "ball"]
  const props = Array.from({ length: STRESS }, (_, i) => propAt(kinds[i % 4] ?? "crate", 6 + (i * (track.length - 12)) / STRESS, ((i % 3) - 1) * 1.6))
  return { ...track, props }
}
const labTrack = demo === "gallery" ? galleryTrack() : demo === "stress" ? stressTrack() : track
const actors = createActors(stage, labTrack)
// `?rank=1` paints the car for that place on the board, with its plate.
actors.standing(params.has("rank") ? Number(params.get("rank")) || null : null)

// A made-up view the scripted demos write into.
const car: Mutable<CarView> = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vx: 0, vy: 0, vz: 0, speed: 0, steer: 0, slip: 0, throttle: 0, brake: 0, grounded: true, boosting: false, s: 0, surface: "road", drift: null }
const lap: Mutable<LapView> = { phase: "running", attempt: 1, timeMs: 0, splitsMs: [], nextCheckpoint: 1 }
const props: Array<Mutable<PropView>> = labTrack.props.map((p) => ({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, vx: 0, vy: 0, vz: 0 }))
const doors: Array<number> = labTrack.doors.map(() => 0)
const fake: Mutable<RaceView> = { tick: 0, car, lap, props, doors }
const events: Array<RaceEvent> = []
let ghost: GhostPose | null = null

/** Every prop back on its placement, every door closed. */
const restoreProps = (): void => {
  labTrack.props.forEach((p, i) => {
    const view = props[i]
    if (view === undefined) return
    view.x = p.x
    view.y = p.y
    view.z = p.z
    view.yaw = p.yaw
    view.vx = 0
    view.vy = 0
    view.vz = 0
  })
  doors.fill(0)
}

/** Puts the made-up car on the road at distance `s`, offset `d`, moving at `speed`. */
const place = (s: number, d: number, speed: number, yawOffset: number = 0): void => {
  const p = pointAt(track, s, d)
  car.x = p.x
  car.y = p.y
  car.z = p.z
  car.yaw = p.yaw + yawOffset
  car.pitch = p.pitch
  car.roll = p.bank
  car.s = s
  car.speed = speed
  // The velocity follows the road, not the nose, so a yaw offset reads as a slide.
  car.vx = Math.sin(p.yaw) * speed
  car.vz = Math.cos(p.yaw) * speed
  car.vy = 0
  car.grounded = true
}

/** Centreline distance and offset of the sample nearest a point. */
const nearest = (x: number, z: number): { s: number; d: number } => {
  let best = 0
  let bestDistance = Number.MAX_VALUE
  track.samples.forEach((sample, i) => {
    const distance = (sample.x - x) ** 2 + (sample.z - z) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  })
  const sample = track.samples[best]
  if (sample === undefined) return { s: 0, d: 0 }
  const d = (x - sample.x) * Math.cos(sample.yaw) - (z - sample.z) * Math.sin(sample.yaw)
  return { s: sample.s, d }
}

const restart = (): void => {
  lap.attempt += 1
  restoreProps()
  toy.reset()
  events.push({ kind: "reset", reason: "manual", x: car.x, y: car.y, z: car.z })
}

/**
 * A toy physics for the made-up views: the car is a circle that shoves props, props slide with
 * friction, fall off whatever they stood on, push each other apart, bounce off the walls and
 * knock; bollards stop the car; doors swing out of its way. It only has to look plausible.
 */
const toy = (() => {
  const MASS: Record<PropKind, number> = { cone: 0.15, barrel: 0.6, crate: 0.8, ball: 2.2 }
  const FRICTION: Record<PropKind, number> = { cone: 2.2, barrel: 1.6, crate: 2.6, ball: 0.35 }
  const spinRate = labTrack.props.map(() => 0)
  const cooldown = labTrack.props.map(() => 0)
  const hints = labTrack.props.map((p) => Math.round(nearest(p.x, p.z).s / track.spacing))
  const postHit = labTrack.bollards.map(() => false)
  const doorHit = labTrack.doors.map(() => false)
  const CAR_RADIUS = 1
  return {
    reset() {
      spinRate.fill(0)
      cooldown.fill(0)
      postHit.fill(false)
      doorHit.fill(false)
    },
    /** Steps the props and doors; returns true when a bollard stopped the car. */
    step(dt: number): boolean {
      let blocked = false
      // The car's circle sits a little ahead of its centre, where the bumper does the pushing.
      const cx = car.x + Math.sin(car.yaw) * 0.6
      const cz = car.z + Math.cos(car.yaw) * 0.6
      labTrack.props.forEach((place, i) => {
        const p = props[i]
        if (p === undefined) return
        cooldown[i] = Math.max(0, (cooldown[i] ?? 0) - dt)
        const dx = p.x - cx
        const dz = p.z - cz
        const distance = Math.hypot(dx, dz)
        const reach = CAR_RADIUS + place.radius
        if (distance < reach && distance > 1e-6 && p.y < car.y + 1) {
          const nx = dx / distance
          const nz = dz / distance
          const closing = (car.vx - p.vx) * nx + (car.vz - p.vz) * nz
          if (closing > 0) {
            const share = 1.6 / (1 + MASS[place.kind])
            p.vx += nx * closing * share
            p.vz += nz * closing * share
            // A fast hit throws a light thing up; off-centre hits spin it.
            if (place.kind !== "ball" && closing > 7) p.vy = Math.max(p.vy, (closing - 6) * 0.45)
            const across = (car.vx * nz - car.vz * nx) / Math.max(1, Math.hypot(car.vx, car.vz))
            spinRate[i] = (spinRate[i] ?? 0) + across * closing * 0.6
            if ((cooldown[i] ?? 0) <= 0) {
              events.push({ kind: "prop", index: i, prop: place.kind, impact: closing, x: p.x - nx * place.radius, y: p.y, z: p.z - nz * place.radius })
              cooldown[i] = 0.3
            }
          }
          p.x = cx + nx * reach
          p.z = cz + nz * reach
        }
      })
      labTrack.props.forEach((place, i) => {
        const p = props[i]
        if (p === undefined) return
        const hit = locateNear(track, p.x, p.z, hints[i] ?? 0)
        hints[i] = hit.index
        // What it stands on: the road, or the top of another prop under it.
        let floor = hit.y
        labTrack.props.forEach((other, j) => {
          const q = props[j]
          if (j === i || q === undefined) return
          const top = q.y + other.height
          if (Math.hypot(q.x - p.x, q.z - p.z) < (other.radius + place.radius) * 0.7 && top <= p.y + 0.15 && top > floor) floor = top
        })
        if (p.y > floor + 0.001 || p.vy > 0) {
          p.vy -= 9.8 * dt
          p.y += p.vy * dt
          if (p.y <= floor) {
            if (p.vy < -2.5) events.push({ kind: "knock", index: i, prop: place.kind, impact: -p.vy, x: p.x, y: floor, z: p.z })
            p.y = floor
            p.vy = 0
          }
        } else {
          p.y = floor
          p.vy = 0
        }
        const keep = Math.exp(-FRICTION[place.kind] * (p.y > floor + 0.01 ? 0.1 : 1) * dt)
        p.vx *= keep
        p.vz *= keep
        if (Math.hypot(p.vx, p.vz) < 0.08) {
          p.vx = 0
          p.vz = 0
        }
        p.x += p.vx * dt
        p.z += p.vz * dt
        spinRate[i] = (spinRate[i] ?? 0) * Math.exp(-2.5 * dt)
        p.yaw += (spinRate[i] ?? 0) * dt
        // The walls: keep it on the road and bounce it back.
        const limit = hit.halfWidth - place.radius
        if (Math.abs(hit.d) > limit) {
          const lx = Math.cos(hit.yaw)
          const lz = -Math.sin(hit.yaw)
          const out = Math.sign(hit.d)
          const into = (p.vx * lx + p.vz * lz) * out
          p.x -= lx * (Math.abs(hit.d) - limit) * out
          p.z -= lz * (Math.abs(hit.d) - limit) * out
          if (into > 0) {
            p.vx -= lx * into * out * 1.4
            p.vz -= lz * into * out * 1.4
            if (into > 1.5) events.push({ kind: "knock", index: i, prop: place.kind, impact: into, x: p.x + lx * place.radius * out, y: p.y, z: p.z + lz * place.radius * out })
          }
        }
      })
      // Props push each other apart and trade speed along the line between them.
      for (let i = 0; i < props.length; i++) {
        for (let j = i + 1; j < props.length; j++) {
          const a = props[i]
          const b = props[j]
          const pa = labTrack.props[i]
          const pb = labTrack.props[j]
          if (a === undefined || b === undefined || pa === undefined || pb === undefined) continue
          if (Math.abs(a.y - b.y) > Math.min(pa.height, pb.height) * 0.8) continue
          const dx = b.x - a.x
          const dz = b.z - a.z
          const distance = Math.hypot(dx, dz)
          const reach = pa.radius + pb.radius
          if (distance >= reach || distance < 1e-6) continue
          const nx = dx / distance
          const nz = dz / distance
          const overlap = reach - distance
          const ma = MASS[pa.kind]
          const mb = MASS[pb.kind]
          a.x -= nx * overlap * (mb / (ma + mb))
          a.z -= nz * overlap * (mb / (ma + mb))
          b.x += nx * overlap * (ma / (ma + mb))
          b.z += nz * overlap * (ma / (ma + mb))
          const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz
          if (closing > 0) {
            const impulse = (1.6 * closing) / (1 / ma + 1 / mb)
            a.vx -= (impulse / ma) * nx
            a.vz -= (impulse / ma) * nz
            b.vx += (impulse / mb) * nx
            b.vz += (impulse / mb) * nz
            if (closing > 1.5) events.push({ kind: "knock", index: j, prop: pb.kind, impact: closing, x: a.x + nx * pa.radius, y: b.y, z: a.z + nz * pa.radius })
          }
        }
      }
      // Bollards stop the car dead.
      labTrack.bollards.forEach((post, i) => {
        if (Math.hypot(post.x - cx, post.z - cz) < CAR_RADIUS + post.radius) {
          blocked = true
          if (!postHit[i] && car.speed > 1) {
            postHit[i] = true
            events.push({ kind: "bollard", index: i, impact: car.speed, x: (post.x + cx) / 2, y: post.y, z: (post.z + cz) / 2 })
          }
        }
      })
      // A door leaf turns out of the way of the car's bumper, the way it is pushed, and stays.
      labTrack.doors.forEach((leaf, i) => {
        const dx = cx - leaf.x
        const dz = cz - leaf.z
        const angle = doors[i] ?? 0
        const heading = leaf.yaw + angle
        const along = dx * Math.sin(heading) + dz * Math.cos(heading)
        const across = dx * Math.cos(heading) - dz * Math.sin(heading)
        if (along > 0.2 && along < leaf.length + CAR_RADIUS * 0.5 && Math.abs(across) < CAR_RADIUS) {
          const push = Math.sign(car.vx * Math.cos(heading) - car.vz * Math.sin(heading)) || 1
          // Turn until the bumper is just past the board.
          const needed = Math.atan2(CAR_RADIUS - across * push, Math.max(0.5, along)) * push
          doors[i] = Math.max(-leaf.maxAngle, Math.min(leaf.maxAngle, angle + needed))
          if (!doorHit[i]) {
            doorHit[i] = true
            events.push({ kind: "door", index: i, impact: Math.abs(car.speed), x: leaf.x + Math.sin(heading) * along, y: leaf.y, z: leaf.z + Math.cos(heading) * along })
          }
        }
      })
      return blocked
    }
  }
})()

/** The car drives a line into a feature of the real track and the toy physics answers. */
const zone = (kind: string, d: number, speed: number, before: number = 16): Script => {
  const f = feature(kind)
  const from = (f?.sFrom ?? 20) - before
  let cycle = -1
  let s = from
  let v = speed
  return (t, dt) => {
    const loop = Math.floor(t / 7)
    if (loop !== cycle) {
      cycle = loop
      s = from
      v = speed
      if (loop > 0) restart()
    }
    const local = t - loop * 7
    // Brake to a stop well after the feature, then wait for the restart.
    const stopAt = (f?.sTo ?? from + 20) + 8
    if (s > stopAt || local > 5.5) v = Math.max(0, v - 25 * dt)
    place(s, d, v)
    car.throttle = v > 0 ? 1 : 0
    car.brake = s > stopAt ? 1 : 0
    if (dt > 0 && toy.step(dt)) v = 0
    s += v * dt
  }
}

/** The gallery: each thing on its own script, all snapped back every 6 s. */
const gallery = (): Script => {
  let cycle = -1
  const fired = new Set<string>()
  /** Fires `make` once per loop when the local clock passes `at`. */
  const once = (key: string, local: number, at: number, make: () => RaceEvent): void => {
    if (local >= at && !fired.has(key)) {
      fired.add(key)
      events.push(make())
    }
  }
  const s0 = GALLERY.s
  const behind = (i: number, by: number) => {
    const p = labTrack.props[i]
    const at = p === undefined ? { x: 0, z: 0 } : pointAt(track, nearest(p.x, p.z).s - by, nearest(p.x, p.z).d)
    return { x: at.x, z: at.z }
  }
  /** Moves prop `i` along the road from its placement by `ds`, at speed `v`, lifted `lift`. */
  const slide = (i: number, ds: number, v: number, lift: number = 0, vy: number = 0): void => {
    const place = labTrack.props[i]
    const view = props[i]
    if (place === undefined || view === undefined) return
    const at = nearest(place.x, place.z)
    const p = pointAt(track, at.s + ds, at.d)
    view.x = p.x
    view.z = p.z
    view.y = p.y + lift
    view.vx = Math.sin(p.yaw) * v
    view.vz = Math.cos(p.yaw) * v
    view.vy = vy
  }
  return (t) => {
    const loop = Math.floor(t / 6)
    const local = t - loop * 6
    if (loop !== cycle) {
      cycle = loop
      fired.clear()
      if (loop > 0) restart()
    }
    place(s0 - 6, 0, 0)
    car.throttle = 0

    // 3: a crate kicked down the road: it slides fast, hops, lands, slows and settles flat.
    if (local >= 0.5) {
      const u = Math.min(local, 2.3) - 0.5
      const tail = Math.max(0, Math.min(local, 2.8) - 2.3)
      const ds = 7 * u + 7 * tail - 7 * tail * tail
      const v = local < 2.3 ? 7 : Math.max(0, 7 - 14 * tail)
      const hop = local - 0.6
      const air = hop > 0 && hop < 0.57
      slide(3, ds, v, air ? 2.8 * hop - 4.9 * hop * hop : 0, air ? 2.8 - 9.8 * hop : 0)
    }
    once("crate", local, 0.5, () => ({ kind: "prop", index: 3, prop: "crate", impact: 9, ...pointOf(behind(3, 0.6)) }))
    once("crate-land", local, 1.17, () => ({ kind: "knock", index: 3, prop: "crate", impact: 3.5, ...pointOf(props[3]) }))
    // 0 to 2: a little stack of crates, standing still; the top one is knocked late in the loop.
    once("stack", local, 3.5, () => ({ kind: "knock", index: 1, prop: "crate", impact: 2, ...pointOf(behind(1, 0.6)) }))
    // 4: a drum hit lightly: it rocks and stands back up.
    once("drum-light", local, 1, () => ({ kind: "prop", index: 4, prop: "barrel", impact: 3, ...pointOf(behind(4, 0.5)) }))
    // 5: a drum hit hard: it slides a little, tips over and lies there, rolling as it goes.
    if (local >= 1.5) slide(5, Math.min(local - 1.5, 0.6) * 2.4, local < 2.1 ? 2.4 : 0)
    once("drum-hard", local, 1.5, () => ({ kind: "prop", index: 5, prop: "barrel", impact: 9, ...pointOf(behind(5, 0.5)) }))
    // 6: a cone ticked: it wobbles. 7: a cone hit: it goes over.
    once("cone-light", local, 1, () => ({ kind: "prop", index: 6, prop: "cone", impact: 2, ...pointOf(behind(6, 0.4)) }))
    if (local >= 1.5) slide(7, Math.min(local - 1.5, 0.5) * 3, local < 2 ? 3 : 0)
    once("cone-hard", local, 1.5, () => ({ kind: "prop", index: 7, prop: "cone", impact: 6, ...pointOf(behind(7, 0.4)) }))
    // 8: the ball rolls up the road and back, and takes a slam halfway.
    {
      const ds = 3 * Math.sin(local * 1.1)
      slide(8, ds, 3.3 * Math.cos(local * 1.1))
      const view = props[8]
      if (view !== undefined) view.yaw = (labTrack.props[8]?.yaw ?? 0) + local * 0.3
    }
    once("ball", local, 2, () => ({ kind: "prop", index: 8, prop: "ball", impact: 8, ...pointOf(behind(8, 1)) }))
    // The bollard takes a hit; the doors are pushed open and stay open.
    once("bollard", local, 2.5, () => {
      const at = pointAt(track, s0 + 10, 1.9)
      return { kind: "bollard", index: 0, impact: 9, x: at.x, y: at.y, z: at.z }
    })
    const open = Math.max(0, Math.min(1, (local - 3) / 0.5))
    const eased = open * open * (3 - 2 * open)
    doors[0] = 1.15 * eased
    doors[1] = -1.15 * eased
    once("door", local, 3, () => {
      const at = pointAt(track, s0 + 17, 0)
      return { kind: "door", index: 0, impact: 7, x: at.x, y: at.y, z: at.z }
    })
    once("door2", local, 3, () => {
      const at = pointAt(track, s0 + 17, 0)
      return { kind: "door", index: 1, impact: 7, x: at.x, y: at.y, z: at.z }
    })
    // The doors' push comes from the car's direction: give the parked car a nominal forward speed.
    const forward = pointAt(track, s0, 0)
    car.vx = Math.sin(forward.yaw) * 0.01
    car.vz = Math.cos(forward.yaw) * 0.01
  }
}

const pointOf = (at: { x: number; z: number; y?: number } | undefined): { x: number; y: number; z: number } => ({ x: at?.x ?? 0, y: at?.y ?? 0, z: at?.z ?? 0 })

const feature = (kind: string) => track.features.find((f) => f.kind === kind)

/** One step of a scripted demo: writes the made-up view and queues events. */
type Script = (t: number, dt: number) => void

const scripts: Record<string, Script> = {
  still: (t) => {
    place(track.length - 4, 0, 0, turntable ? t * 0.8 : 0)
    car.steer = turntable ? Math.sin(t * 1.3) : 0.8
    car.brake = params.get("brake") === "1" || Math.sin(t * 2) > 0 ? 1 : 0
    car.speed = params.get("brake") === "1" ? 1 : 0
  },

  crates: zone("crates", -1.6, 17),
  balls: zone("balls", 1.7, 13),
  slalom: zone("slalom", 1.6, 11),
  doors: zone("doors", 0.6, 13),
  gallery: gallery(),
  // Every prop circles its placement: crates fast enough to tumble, balls rolling, drums and cones knocked over.
  stress: (t) => {
    place(track.length - 4, 0, 0)
    labTrack.props.forEach((p, i) => {
      const view = props[i]
      if (view === undefined) return
      const rate = 1.2 + (i % 5) * 0.2
      const radius = p.kind === "crate" ? 4.5 : 1.5
      const a = t * rate + i
      view.x = p.x + Math.cos(a) * radius
      view.z = p.z + Math.sin(a) * radius
      view.vx = -Math.sin(a) * radius * rate
      view.vz = Math.cos(a) * radius * rate
      view.yaw = p.yaw + t * 0.7
      if (t > 0.5 && fake.tick === 40 && (p.kind === "cone" || p.kind === "barrel")) events.push({ kind: "prop", index: i, prop: p.kind, impact: 10, x: p.x, y: p.y, z: p.z })
    })
  },

  jump: (() => {
    const jump = feature("jump")
    const from = (jump?.sFrom ?? 150) - 25
    let air = false
    let vy = 0
    let y = 0
    let s = from
    let cycle = -1
    let speed = 22
    return (t, dt) => {
      const loop = Math.floor(t / 4.5)
      if (loop !== cycle) {
        cycle = loop
        s = from
        air = false
        // Every third run is too slow and falls into the gap.
        speed = loop % 3 === 2 ? 9 : 22
        if (loop > 0) restart()
      }
      s += speed * dt
      const p = pointAt(track, s, 0)
      const index = Math.floor(s / track.spacing) % track.samples.length
      const surface = track.samples[index]?.surface ?? true
      if (!air) {
        place(s, 0, speed)
        if (!surface) {
          air = true
          vy = speed * Math.sin(p.pitch) + 1.5
          y = car.y
          events.push({ kind: "takeoff", speed, x: car.x, y: car.y, z: car.z })
        }
      } else {
        vy -= 14 * dt
        y += vy * dt
        place(s, 0, speed)
        car.grounded = false
        car.y = y
        car.vy = vy
        car.pitch = Math.max(-0.4, Math.min(0.3, Math.atan2(vy, speed) * 0.5))
        if (surface && y <= p.y) {
          air = false
          events.push({ kind: "land", impact: Math.abs(vy), x: car.x, y: p.y, z: car.z })
          place(s, 0, speed)
        } else if (y < -1) {
          events.push({ kind: "reset", reason: "off-track", x: car.x, y: 0, z: car.z })
          lap.attempt += 1
          cycle = loop
          s = track.length - 4
          air = false
          speed = 0
        }
      }
      car.throttle = 1
    }
  })(),

  skid: (() => {
    let wallAt = 2
    return (t) => {
      const s0 = 6
      const s = s0 + ((t * 9) % 32)
      const d = 2 * Math.sin(t * 1.7)
      const drift = 0.55 * Math.cos(t * 1.7)
      place(s, d, 13, drift)
      car.steer = Math.cos(t * 1.7)
      car.slip = 0.55 + 0.45 * Math.abs(Math.cos(t * 1.7))
      car.brake = Math.sin(t * 0.9) > 0.6 ? 1 : 0
      car.throttle = car.brake > 0 ? 0 : 1
      if (t > wallAt) {
        wallAt = t + 2.5
        const side = d > 0 ? "left" : "right"
        events.push({ kind: "wall", side, impact: 8, x: car.x + Math.cos(car.yaw) * (d > 0 ? 0.7 : -0.7), y: car.y, z: car.z - Math.sin(car.yaw) * (d > 0 ? 0.7 : -0.7) })
      }
    }
  })(),

  boost: (() => {
    const pad = track.boosts[0]
    const at = pad === undefined ? 40 : pad.s
    let cycle = -1
    let boostUntil = -1
    return (t) => {
      const loop = Math.floor(t / 3.5)
      const local = t - loop * 3.5
      if (loop !== cycle) cycle = loop
      const s = at - 16 + local * 14 + Math.max(0, local - 1.15) * 10
      place(s, 0, 14)
      car.throttle = 1
      if (local >= 1.15 && t - (boostUntil - 1.2) > 2) {
        boostUntil = t + 1.2
        events.push({ kind: "boost", index: 0 })
      }
      car.boosting = t < boostUntil
    }
  })(),

  ghost: (t) => {
    const s = 10 + ((t * 16) % (track.length - 20))
    place(s, -1.2, 16)
    const g = pointAt(track, s - 5, 1.4)
    ghost = { x: g.x, y: g.y, z: g.z, yaw: g.yaw, pitch: g.pitch, roll: g.bank }
    car.throttle = 1
    car.steer = 0.2 * Math.sin(t)
  },

  bridge: (() => {
    // Stands the car on the ground under the highest stretch of road, so the deck test sees a road above it.
    let top = 0
    track.samples.forEach((sample) => {
      if (sample.surface && sample.y > (track.samples[top]?.y ?? 0)) top = track.samples.indexOf(sample)
    })
    const s0 = track.samples[top]?.s ?? 0
    return (t) => {
      const s = s0 - 4 + Math.sin(t) * 1.5
      place(s, 0, 3)
      car.y = 0
      car.pitch = 0
    }
  })()
}

// The real session with a scripted driver.
const session = demo === "drive" ? createSession(track) : null
let ticks = 0
const input: Mutable<DriveInput> = { ...idleInput }

const camera = stage.view.camera
const baseZoom = camera.zoom
// Aim along the stage camera's own line of sight, so the lab keeps the game's angle.
const forward = { x: 0, y: 0, z: 0 }
{
  const ahead = camera.toGlobal({ x: 0, y: 0, z: -1 })
  const at = camera.getGlobalPosition()
  forward.x = ahead.x - at.x
  forward.y = ahead.y - at.y
  forward.z = ahead.z - at.z
}
// Keep the stage's distance to the ground, so a depth effect focused there (tilt-shift) stays sharp on the car.
const distance = forward.y < -0.01 ? camera.getGlobalPosition().y / -forward.y : 120

let time = startAt
// Run the demo clock forward to `?t=` so a picture can land on a moment.
const script = scripts[demo]
if (script !== undefined) {
  for (let t = 0; t < startAt; t += 1 / 60) {
    script(t, 1 / 60)
    for (const event of events) actors.handle(event, fake)
    events.length = 0
    actors.update(fake, ghost, 1 / 60)
  }
}

stage.app.ticker.add((ticker) => {
  const seconds = frozen ? 0 : Math.min(ticker.deltaMS / 1000, 0.05)
  time += seconds
  let view: RaceView = fake
  if (session !== null) {
    const due = Math.floor(time * session.hz) - ticks
    for (let i = 0; i < due; i++) {
      ticks++
      const t = ticks / session.hz
      input.throttle = t % 7 < 6 ? 1 : 0
      input.brake = t % 7 < 6 ? 0 : 1
      input.steer = Math.sin(t * 0.8) * 0.7
      input.aim = null
      input.restart = ticks % (session.hz * 30) === 0
      session.tick(input)
    }
    view = session.view()
    for (const event of session.drainEvents()) actors.handle(event, view)
  } else if (script !== undefined) {
    script(time, seconds)
    fake.tick += 1
    for (const event of events) actors.handle(event, fake)
    events.length = 0
  }
  scene.update(view, seconds)
  actors.update(view, ghost, seconds)
  if (zoom > 1) {
    camera.zoom = baseZoom * zoom
    const aim = focus === null ? null : pointAt(track, Number(focus), 0)
    const target = aim === null ? { x: view.car.x, y: view.car.y + 0.4, z: view.car.z } : { x: aim.x, y: aim.y + 0.4, z: aim.z }
    camera.position.set(target.x - forward.x * distance, target.y - forward.y * distance, target.z - forward.z * distance)
    camera.lookAt(target)
  }
})

// For pictures: `window.lab` lets a script read where things are.
Object.assign(window, { lab: { stage, fake, demo } })
