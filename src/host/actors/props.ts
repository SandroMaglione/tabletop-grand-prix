/**
 * The loose props on the road: wooden crates, steel drums, traffic cones and heavy balls.
 *
 * The simulation gives each prop's base centre, its turn about the vertical and its velocity; it
 * treats every prop as an upright cylinder. Everything else here is for the picture and never
 * moves the prop's centre off where the simulation puts it:
 *
 * - A ball rolls by how far it moved (the turn is integrated, so it rolls exactly as far as it
 *   travels and never spins on a reset), and squashes for a moment when the car slams it.
 * - A crate tumbles while it flies or slides fast, then falls flat onto the nearest face. Its
 *   centre lifts while it stands on an edge, so it never sinks into the road.
 * - A drum or a cone rocks on its rim when hit: a light hit wobbles it back upright, a hard one
 *   tips it past its balance point and it falls on its side and stays there. A drum lying down
 *   rolls as it moves.
 *
 * On a restart every prop snaps back to its placement: no tumbling through the air to the start.
 * Each prop has its own copy of its kind's material, so a hit can flash just that one.
 */
import { Container3D, Material3D, Mesh3D, SphereGeometry } from "@pixi/3d"
import type { Geometry3D } from "@pixi/3d"
import type { PropKind, PropPlacement, PropView, RaceView } from "../../sim/index.ts"
import { palette } from "../palette.ts"
import { clamp, cubeReach, nearestCubeTurn, quat, quatAxisAngle, quatMultiply, quatNormalize, quatToward, random, turnBetween } from "./pose.ts"
import type { Quat } from "./pose.ts"
import { ballTexture, crateTexture, lathe, roundedBox } from "./shapes.ts"
import type { LatheRing } from "./shapes.ts"

const GRAVITY = 9.8
/** A crate tumbles above this sliding speed, m/s. */
const TUMBLE_SPEED = 4.5
/** Vertical speed that counts as flying or falling, m/s. */
const AIR_SPEED = 0.6
/** A move this long in one frame is a jump back to the start, not a roll. */
const TELEPORT = 3

/** How a tipping prop is built: radius of its foot and of its top, and how high its weight sits. */
interface Tipping {
  readonly foot: number
  readonly top: number
  readonly weight: number
  /** Where it comes to rest on its side: the angle from upright. */
  readonly rest: number
  /** Tip speed in rad/s per m/s of impact. */
  readonly kick: number
}

interface Prop {
  readonly kind: PropKind
  readonly place: PropPlacement
  /** At the base centre (or, tipped, wherever keeps the middle on the simulation's centre). */
  readonly root: Container3D
  /** Turns by the simulation's yaw. For a ball: the squash, which stays upright. */
  readonly turn: Container3D
  /** Crate: the tumble. Drum and cone: the side it tips toward. Ball: the roll. */
  readonly tumble: Container3D
  /** Drum and cone: the tip itself. */
  readonly tip: Container3D
  /** Drum and cone: its own turn about its axis (the roll when it lies down). */
  readonly spin: Container3D
  readonly material: Material3D
  readonly tipping: Tipping | null
  flash: number
  /** Crate tumble, or the ball's whole orientation, in the parent's frame. */
  readonly q: Quat
  /** Crate: angular velocity in the world, rad/s. */
  wx: number
  wy: number
  wz: number
  /** Drum and cone: angle from upright, its speed, the side it tips toward (in the yaw frame) and its roll about its axis. */
  theta: number
  omega: number
  side: number
  roll: number
  /** Ball: squash and its speed. */
  squash: number
  squashSpeed: number
  lastX: number
  lastZ: number
  lastYaw: number
}

interface KindLook {
  readonly geometry: Geometry3D
  readonly material: Material3D
  /** A second part that does not flash (the cone's rubber foot). */
  readonly extra?: { readonly geometry: Geometry3D; readonly material: Material3D; readonly y: number }
}

/** A drum's profile: a rolled chime at each end, two hoops, a lid set a little down. */
const drumProfile = (r: number, h: number): ReadonlyArray<LatheRing> => {
  const body = palette.barrel
  const hoop = palette.barrelHoop
  const lid = palette.barrelLid
  const band = palette.coneBand
  const rings: Array<LatheRing> = [
    [0, 0.005, hoop],
    [r * 0.9, 0.005, hoop],
    [r * 0.985, 0.014, hoop],
    [r, 0.04, hoop],
    [r, 0.04, body]
  ]
  // Two rolling hoops, low ridges; a pale stencilled band between them.
  for (const at of [0.3, 0.7]) {
    const y = h * at
    rings.push([r, y - 0.025, body], [r, y - 0.025, hoop], [r + 0.01, y, hoop], [r, y + 0.025, hoop], [r, y + 0.025, body])
    if (at < 0.5) rings.push([r, h * 0.44, body], [r, h * 0.44, band], [r, h * 0.56, band], [r, h * 0.56, body])
  }
  rings.push([r, h - 0.04, body], [r, h - 0.04, hoop], [r * 0.985, h - 0.012, hoop], [r * 0.92, h - 0.004, hoop], [r * 0.88, h - 0.02, hoop], [r * 0.88, h - 0.02, lid], [0, h - 0.02, lid])
  return rings
}

/** A traffic cone's body over its foot: orange with two pale reflective bands and a rounded tip. */
const coneProfile = (r: number, h: number): ReadonlyArray<LatheRing> => {
  const foot = 0.055
  const bottom = r * 0.82
  const tip = r * 0.13
  const radiusAt = (y: number): number => bottom + ((tip - bottom) * (y - foot)) / (h - 0.03 - foot)
  const orange = palette.cone
  const pale = palette.coneBand
  const rings: Array<LatheRing> = [
    [0, foot, orange],
    [bottom, foot, orange]
  ]
  for (const [from, to] of [
    [0.36, 0.48],
    [0.6, 0.7]
  ] as const) {
    const a = h * from
    const b = h * to
    rings.push([radiusAt(a), a, orange], [radiusAt(a), a, pale], [radiusAt(b), b, pale], [radiusAt(b), b, orange])
  }
  rings.push([radiusAt(h - 0.03), h - 0.03, orange], [tip * 0.7, h - 0.008, orange], [0, h, orange])
  return rings
}

const looks = (): ((place: PropPlacement) => KindLook) => {
  const cache = new Map<string, KindLook>()
  const crateMaterial = new Material3D({ baseColorTexture: crateTexture(palette.crate, palette.crateDark), roughness: 0.82, emissive: { color: 0xffffff, strength: 0 }, passes: { outline: true } })
  const drumMaterial = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.62, metallic: 0.15, emissive: { color: 0xffffff, strength: 0 }, passes: { outline: true } })
  const coneMaterial = new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.55, emissive: { color: 0xffffff, strength: 0 }, passes: { outline: true } })
  const footMaterial = new Material3D({ baseColor: palette.coneFoot, roughness: 0.9, passes: { outline: true } })
  // The heavy ball is glossy: a clear lacquer over its paint picks up the sky and holds a sharp
  // highlight from the sun, which stays put while the stripes roll under it.
  const ballMaterial = new Material3D({
    baseColorTexture: ballTexture(palette.ballA, palette.ballB, palette.ballBand),
    roughness: 0.5,
    clearcoat: { factor: 1, roughness: 0.08 },
    emissive: { color: 0xffffff, strength: 0 },
    passes: { outline: true }
  })
  return (place) => {
    const key = `${place.kind}:${place.radius}:${place.height}`
    const known = cache.get(key)
    if (known !== undefined) return known
    let look: KindLook
    switch (place.kind) {
      case "crate": {
        const edge = place.height
        look = { geometry: roundedBox({ width: edge, height: edge, depth: edge, radius: edge * 0.045, segments: 2 }), material: crateMaterial }
        break
      }
      case "barrel":
        look = { geometry: lathe(drumProfile(place.radius, place.height), 28), material: drumMaterial }
        break
      case "cone": {
        const side = place.radius * 2
        look = {
          geometry: lathe(coneProfile(place.radius, place.height), 20),
          material: coneMaterial,
          extra: { geometry: roundedBox({ width: side, height: 0.055, depth: side, radius: 0.02, segments: 2 }), material: footMaterial, y: 0.0275 }
        }
        break
      }
      case "ball":
        look = { geometry: new SphereGeometry({ radius: place.radius, widthSegments: 36, heightSegments: 22 }), material: ballMaterial }
        break
    }
    cache.set(key, look)
    return look
  }
}

const tippingFor = (place: PropPlacement): Tipping | null => {
  if (place.kind === "barrel") return { foot: place.radius, top: place.radius, weight: place.height / 2, rest: Math.PI / 2, kick: 0.62 }
  if (place.kind === "cone") {
    const tip = place.radius * 0.13
    // On its side a cone lies on its foot's rim and its tip, so it rests past a quarter turn.
    return { foot: place.radius, top: tip, weight: place.height * 0.28, rest: Math.PI / 2 + Math.atan((place.radius - tip) / place.height), kick: 1.15 }
  }
  return null
}

export const createProps = (parent: Container3D, placements: ReadonlyArray<PropPlacement>) => {
  const layer = new Container3D({ label: "props", parent })
  const lookOf = looks()
  const rand = random(23)
  const step = quat()

  const props: Array<Prop> = placements.map((place) => {
    const look = lookOf(place)
    const material = look.material.clone()
    const root = new Container3D({ parent: layer, label: place.kind })
    const turn = new Container3D({ parent: root })
    const tumble = new Container3D({ parent: turn })
    const tip = new Container3D({ parent: tumble })
    const spin = new Container3D({ parent: tip })
    const holder = place.kind === "ball" ? tumble : place.kind === "crate" ? tumble : spin
    new Mesh3D({ geometry: look.geometry, material, castShadow: true, receiveShadow: true, parent: holder })
    if (look.extra !== undefined) new Mesh3D({ geometry: look.extra.geometry, material: look.extra.material, position: { x: 0, y: look.extra.y, z: 0 }, castShadow: true, receiveShadow: true, parent: holder })
    return {
      kind: place.kind,
      place,
      root,
      turn,
      tumble,
      tip,
      spin,
      material,
      tipping: tippingFor(place),
      flash: 0,
      q: quat(),
      wx: 0,
      wy: 0,
      wz: 0,
      theta: 0,
      omega: 0,
      side: 0,
      roll: 0,
      squash: 0,
      squashSpeed: 0,
      lastX: place.x,
      lastZ: place.z,
      lastYaw: place.yaw
    }
  })

  /** Back to how it stood before the attempt. */
  const settle = (prop: Prop, at: PropView | PropPlacement): void => {
    prop.flash = 0
    prop.wx = 0
    prop.wy = 0
    prop.wz = 0
    prop.theta = 0
    prop.omega = 0
    prop.side = 0
    prop.roll = 0
    prop.squash = 0
    prop.squashSpeed = 0
    prop.lastX = at.x
    prop.lastZ = at.z
    prop.lastYaw = at.yaw
    if (prop.kind === "ball") {
      // The ball's own start: its band tipped toward the camera so the stripes read from above.
      quatAxisAngle(1, 0, 0, 1.05, prop.q)
      quatMultiply(quatAxisAngle(0, 1, 0, prop.place.yaw + 0.6, step), prop.q, prop.q)
    } else {
      prop.q.x = 0
      prop.q.y = 0
      prop.q.z = 0
      prop.q.w = 1
    }
  }
  for (const prop of props) settle(prop, prop.place)
  let snap = true

  const zeroView: PropView = { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0 }

  /** Pushes a drum or cone over toward world direction `heading` (a yaw) by `speed` rad/s. */
  const tipToward = (prop: Prop, heading: number, yaw: number, speed: number): void => {
    const local = heading - yaw
    if (prop.theta < 0.12) {
      prop.side = local
      prop.omega = Math.max(prop.omega, 0) + speed
    } else {
      prop.omega += speed * Math.cos(turnBetween(prop.side, local))
    }
  }

  /** The direction a hit sends a prop: its new velocity, or else away from where it was hit. */
  const pushHeading = (prop: Prop, view: PropView, fromX: number, fromZ: number): number => {
    if (Math.hypot(view.vx, view.vz) > 0.4) return Math.atan2(view.vx, view.vz)
    return Math.atan2(view.x - fromX, view.z - fromZ)
  }

  const kick = (index: number, impact: number, fromX: number, fromZ: number, view: RaceView, hard: number): PropKind | null => {
    const prop = props[index]
    if (prop === undefined) return null
    const now = view.props[index] ?? prop.place
    const strength = clamp(impact / 10, 0, 1.5)
    prop.flash = Math.max(prop.flash, clamp(0.3 + strength * 0.7, 0, 1) * hard)
    const heading = pushHeading(prop, { ...zeroView, ...now }, fromX, fromZ)
    switch (prop.kind) {
      case "crate": {
        // Thrown over its leading bottom edge, with a little twist so no two tumbles match.
        const spin = (impact * 0.32 * hard) / (prop.place.height / 2)
        const hx = Math.sin(heading)
        const hz = Math.cos(heading)
        prop.wx += hz * spin + hx * (rand() - 0.5) * spin * 0.5
        prop.wz += -hx * spin + hz * (rand() - 0.5) * spin * 0.5
        prop.wy += (rand() - 0.5) * spin * 0.3
        break
      }
      case "barrel":
      case "cone":
        if (prop.tipping !== null) tipToward(prop, heading, now.yaw, impact * prop.tipping.kick * hard)
        break
      case "ball":
        prop.squashSpeed += Math.min(2.4, impact * 0.16 * hard)
        break
    }
    return prop.kind
  }

  return {
    kindOf: (index: number): PropKind | null => props[index]?.kind ?? null,
    /** The car hit prop `index` at (x, z). */
    hit(index: number, impact: number, x: number, z: number, view: RaceView): PropKind | null {
      return kick(index, impact, x, z, view, 1)
    },
    /** Prop `index` knocked into something. */
    knock(index: number, impact: number, x: number, z: number, view: RaceView): PropKind | null {
      return kick(index, impact, x, z, view, 0.45)
    },
    /** Snap every prop back to its placement on the next update. */
    reset() {
      for (const prop of props) settle(prop, prop.place)
      snap = true
    },
    update(view: RaceView, seconds: number) {
      const dt = clamp(seconds, 0, 0.05)
      for (let i = 0; i < props.length; i++) {
        const prop = props[i]
        if (prop === undefined) continue
        const now = view.props[i] ?? prop.place
        const vx = "vx" in now ? now.vx : 0
        const vy = "vy" in now ? now.vy : 0
        const vz = "vz" in now ? now.vz : 0
        const dx = now.x - prop.lastX
        const dz = now.z - prop.lastZ
        if (snap || Math.hypot(dx, dz) > TELEPORT) settle(prop, now)
        const moveX = snap ? 0 : now.x - prop.lastX
        const moveZ = snap ? 0 : now.z - prop.lastZ
        const turned = snap ? 0 : turnBetween(prop.lastYaw, now.yaw)
        prop.lastX = now.x
        prop.lastZ = now.z
        prop.lastYaw = now.yaw

        if (prop.flash > 0) {
          prop.flash = Math.max(0, prop.flash - dt * 6)
          if (prop.material.emissive !== undefined) prop.material.emissive.strength = prop.flash * prop.flash * 0.5
        }

        const { place } = prop
        switch (prop.kind) {
          case "ball": {
            // Roll exactly as far as it moved: the turn axis is up x motion, the angle distance / radius.
            const moved = Math.hypot(moveX, moveZ)
            if (moved > 1e-6) quatMultiply(quatAxisAngle(moveZ, 0, -moveX, moved / place.radius, step), prop.q, prop.q)
            if (turned !== 0) quatMultiply(quatAxisAngle(0, 1, 0, turned, step), prop.q, prop.q)
            quatNormalize(prop.q)
            prop.squashSpeed += (-prop.squash * 260 - prop.squashSpeed * 11) * dt
            prop.squash = clamp(prop.squash + prop.squashSpeed * dt, -0.12, 0.16)
            const flat = prop.squash
            prop.root.position.set(now.x, now.y + place.radius * (1 - flat), now.z)
            prop.turn.scale.set(1 + flat * 0.55, 1 - flat, 1 + flat * 0.55)
            prop.tumble.quaternion.set(prop.q.x, prop.q.y, prop.q.z, prop.q.w)
            break
          }
          case "crate": {
            const half = place.height / 2
            const speed = Math.hypot(vx, vz)
            const flying = Math.abs(vy) > AIR_SPEED
            if (flying) {
              // In the air it keeps its spin.
              const keep = Math.exp(-0.4 * dt)
              prop.wx *= keep
              prop.wy *= keep
              prop.wz *= keep
            } else if (speed > TUMBLE_SPEED) {
              // Sliding fast it trips over its leading edge, end over end.
              const k = 1 - Math.exp(-5 * dt)
              const rate = 0.42 / half
              prop.wx += (vz * rate - prop.wx) * k
              prop.wz += (-vx * rate - prop.wz) * k
              prop.wy *= 1 - k
            } else {
              const keep = Math.exp(-9 * dt)
              prop.wx *= keep
              prop.wy *= keep
              prop.wz *= keep
            }
            const rate = Math.hypot(prop.wx, prop.wy, prop.wz)
            if (rate > 1e-4) {
              // The tumble node sits under the yaw: turn the world spin into the yaw's frame.
              const c = Math.cos(now.yaw)
              const s = Math.sin(now.yaw)
              quatMultiply(quatAxisAngle(prop.wx * c - prop.wz * s, prop.wy, prop.wx * s + prop.wz * c, rate * dt, step), prop.q, prop.q)
              quatNormalize(prop.q)
            }
            // Whenever it is not thrown about, it falls flat onto whichever face is nearest.
            if (!flying && (speed <= TUMBLE_SPEED || rate < 2)) quatToward(prop.q, nearestCubeTurn(prop.q), 1 - Math.exp(-(rate < 3 ? 12 : 4) * dt))
            // Up on an edge or a corner it stands taller than flat: lift it so it never sinks into the road.
            const lift = (cubeReach(prop.q) - 1) * half
            prop.root.position.set(now.x, now.y + half + lift, now.z)
            prop.turn.rotation.y = now.yaw
            prop.tumble.quaternion.set(prop.q.x, prop.q.y, prop.q.z, prop.q.w)
            break
          }
          case "barrel":
          case "cone": {
            const t = prop.tipping
            if (t === null) break
            // Rocking on the rim: past the balance point the weight pulls it over, short of it back up.
            const inertia = t.weight * t.weight + t.foot * t.foot
            const pull = (GRAVITY * (t.weight * Math.sin(prop.theta) - t.foot * Math.cos(prop.theta))) / inertia
            if (prop.theta > 0 || prop.omega > 0) {
              prop.omega += pull * dt
              prop.theta += prop.omega * dt
            }
            if (prop.theta <= 0) {
              prop.theta = 0
              prop.omega = prop.omega < -0.5 ? -prop.omega * 0.3 : 0
            } else if (prop.theta >= t.rest) {
              prop.theta = t.rest
              prop.omega = prop.omega > 0.8 ? -prop.omega * 0.22 : Math.min(0, prop.omega)
            }
            const sin = Math.sin(prop.theta)
            const cos = Math.cos(prop.theta)
            const heading = now.yaw + prop.side
            const hx = Math.sin(heading)
            const hz = Math.cos(heading)
            // Lying down, it rolls about its own axis as it moves across it.
            if (sin > 0.5) prop.roll += ((moveZ * hx - moveX * hz) * sin) / ((t.foot + t.top) / 2)
            // Keep the middle of its body over the simulation's centre, and its lowest rim on the road.
            const reach = (place.height / 2) * sin
            const lift = Math.max(t.foot * sin, t.top * sin - place.height * cos, 0)
            prop.root.position.set(now.x - hx * reach, now.y + lift, now.z - hz * reach)
            prop.turn.rotation.y = now.yaw
            prop.tumble.rotation.y = prop.side
            prop.tip.rotation.x = prop.theta
            prop.spin.rotation.y = -prop.side + prop.roll
            break
          }
        }
      }
      snap = false
    }
  }
}

export type Props = ReturnType<typeof createProps>
