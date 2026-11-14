/**
 * Draw the game's track and check it.
 *
 *   node scripts/track-preview.ts [out-prefix]
 *
 * Writes `<out-prefix>.svg` and `<out-prefix>.png` (default output/track/preview): a top
 * view (road coloured by height, features, start line, checkpoints, crates, pads, gate,
 * arrows), a rough view from the game's camera angle, and the elevation profile. Then runs
 * the layout checks, prints each result, and exits 1 when any fails.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { chromium } from "playwright-core"
import { angleDelta, locateBelow, locateNear, pointAt, track } from "../src/sim/track/index.ts"
import type { TrackData, TrackSample } from "../src/sim/types.ts"

const out = process.argv[2] ?? "output/track/preview"
const t: TrackData = track
const samples = t.samples
const count = samples.length
const at = (i: number): TrackSample => {
  const sample = samples[((i % count) + count) % count]
  if (sample === undefined) throw new Error("no samples")
  return sample
}
const left = (yaw: number) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) })
const DEG = 180 / Math.PI

// ---------------------------------------------------------------- checks

const results: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail: string): void => {
  results.push({ name, ok, detail })
}

/** Rules for the layout, in metres and degrees. */
const RULES = {
  minRadiusGround: 9,
  minRadiusSpiral: 11,
  separation: 2 * 3.25 + 5,
  crossing: 3.4,
  slope: 12.5,
  kicker: 16,
  gravity: 24
}

const featureOf = (kind: string) => t.features.find((feature) => feature.kind === kind)
const inFeature = (kind: string, s: number): boolean => t.features.some((feature) => feature.kind === kind && s >= feature.sFrom && s <= feature.sTo)
const gapSamples = samples.filter((sample) => !sample.surface)
const gapFrom = gapSamples[0]?.s ?? 0
const gapTo = (gapSamples[gapSamples.length - 1]?.s ?? 0) + t.spacing

{
  let worst = 0
  for (let i = 0; i < count; i++) {
    const a = at(i)
    const b = at(i + 1)
    const flat = Math.hypot(b.x - a.x, b.z - a.z)
    worst = Math.max(worst, Math.abs(flat - t.spacing) / t.spacing)
  }
  const sOk = samples.every((sample, i) => Math.abs(sample.s - i * t.spacing) < 1e-9) && Math.abs(t.length / count - t.spacing) < 1e-12
  check("even spacing", worst < 0.02 && sOk, `${count} samples, spacing ${t.spacing.toFixed(4)} m, worst step error ${(worst * 100).toFixed(3)}% (ground distance, last to first included)`)
}
{
  let worst = 0
  for (let i = 0; i < count; i++) worst = Math.max(worst, Math.abs(angleDelta(at(i).yaw, at(i + 1).yaw)))
  check("yaw continuous", worst < 0.1, `largest yaw step ${worst.toFixed(4)} rad`)
}
{
  // Radius from three neighbours: the step between their headings over the spacing.
  let worstGround = Infinity
  let worstSpiral = Infinity
  let groundAt = 0
  let spiralAt = 0
  for (let i = 0; i < count; i++) {
    const turn = Math.abs(angleDelta(at(i - 1).yaw, at(i + 1).yaw))
    if (turn < 1e-9) continue
    const radius = (2 * t.spacing) / turn
    if (inFeature("spiral", at(i).s)) {
      if (radius < worstSpiral) {
        worstSpiral = radius
        spiralAt = at(i).s
      }
    } else if (radius < worstGround) {
      worstGround = radius
      groundAt = at(i).s
    }
  }
  check("minimum radius", worstGround >= RULES.minRadiusGround - 0.05 && worstSpiral >= RULES.minRadiusSpiral - 0.05, `tightest ${worstGround.toFixed(2)} m at s=${groundAt.toFixed(1)}, on the spiral ${worstSpiral.toFixed(2)} m at s=${spiralAt.toFixed(1)}`)
}
{
  // Pairs of samples far apart along the lap but close on the ground must be on different levels.
  let worstSame = Infinity
  let worstSameAt = ""
  let crossings: Array<{ a: number; b: number; clearance: number; distance: number }> = []
  const along = (a: number, b: number): number => {
    const d = Math.abs(a - b) % t.length
    return Math.min(d, t.length - d)
  }
  for (let i = 0; i < count; i += 1) {
    const a = at(i)
    for (let j = i + 1; j < count; j += 1) {
      const b = at(j)
      if (along(a.s, b.s) < 25) continue
      const distance = Math.hypot(a.x - b.x, a.z - b.z)
      if (distance >= RULES.separation) continue
      const clearance = Math.abs(a.y - b.y)
      if (clearance < RULES.crossing && distance < worstSame) {
        worstSame = distance
        worstSameAt = `s=${a.s.toFixed(1)} and s=${b.s.toFixed(1)}`
      }
      if (distance < a.halfWidth + b.halfWidth) crossings.push({ a: a.s, b: b.s, clearance, distance })
    }
  }
  check("same-level separation", worstSame === Infinity, worstSame === Infinity ? `no two stretches within ${RULES.separation} m on the same level` : `only ${worstSame.toFixed(2)} m apart at ${worstSameAt}`)
  // Group overlapping pairs into crossings and report the least clearance of each.
  crossings.sort((p, q) => p.a - q.a)
  const groups: Array<{ a: number; b: number; clearance: number }> = []
  for (const pair of crossings) {
    const group = groups.find((g) => (along(g.a, pair.a) < 30 && along(g.b, pair.b) < 30) || (along(g.a, pair.b) < 30 && along(g.b, pair.a) < 30))
    if (group === undefined) groups.push({ a: pair.a, b: pair.b, clearance: pair.clearance })
    else group.clearance = Math.min(group.clearance, pair.clearance)
  }
  const worstCrossing = groups.reduce((worst, g) => Math.min(worst, g.clearance), Infinity)
  check("crossing clearance", worstCrossing >= RULES.crossing, groups.map((g) => `s=${g.a.toFixed(0)} under/over s=${g.b.toFixed(0)}: ${g.clearance.toFixed(2)} m`).join("; ") || "no crossings")
}
{
  // Slopes and smoothness of the height profile.
  let worstSlope = 0
  let worstSlopeAt = 0
  let worstKicker = 0
  let worstKink = 0
  let worstKinkAt = 0
  let tightest = Infinity
  let tightestAt = 0
  for (let i = 0; i < count; i++) {
    const a = at(i)
    if (!a.surface) continue
    const slope = Math.abs(a.pitch) * DEG
    const kicker = a.s > gapFrom - 15 && a.s < gapFrom
    if (kicker) worstKicker = Math.max(worstKicker, slope)
    else if (slope > worstSlope) {
      worstSlope = slope
      worstSlopeAt = a.s
    }
    const b = at(i + 1)
    const lip = Math.abs(a.s - gapFrom) < 2 * t.spacing || Math.abs(b.s - gapTo) < 2 * t.spacing || Math.abs(a.s - gapTo) < 2 * t.spacing
    if (!b.surface || lip) continue
    const kink = Math.abs(b.pitch - a.pitch) * DEG
    if (kink > worstKink) {
      worstKink = kink
      worstKinkAt = a.s
    }
    const radius = t.spacing / Math.max(1e-9, Math.abs(b.pitch - a.pitch))
    if (radius < tightest) {
      tightest = radius
      tightestAt = a.s
    }
  }
  check("slopes", worstSlope <= RULES.slope && worstKicker <= RULES.kicker, `steepest ${worstSlope.toFixed(1)} deg at s=${worstSlopeAt.toFixed(1)}, kicker ${worstKicker.toFixed(1)} deg`)
  check("smooth heights", worstKink < 2, `largest pitch change between samples ${worstKink.toFixed(2)} deg at s=${worstKinkAt.toFixed(1)}, tightest vertical curve radius ${tightest.toFixed(0)} m at s=${tightestAt.toFixed(1)} (lip and landing edge excluded)`)
  const lowest = samples.reduce((m, sample) => Math.min(m, sample.y), Infinity)
  check("heights", lowest >= 0, `lowest ${lowest.toFixed(2)} m, highest road ${samples.reduce((m, sample) => Math.max(m, sample.y), 0).toFixed(2)} m`)
}
{
  const wallsOk = samples.every((sample) => (sample.surface ? sample.wallLeft && sample.wallRight : !sample.wallLeft && !sample.wallRight))
  const supportOk = samples.every((sample) => {
    if (!sample.surface) return sample.support === "none"
    if (sample.support === "ground") return Math.abs(sample.y) < 0.03
    return sample.support !== "none" && sample.y > 0
  })
  check("walls and support", wallsOk && supportOk, `walls on both edges except the ${gapSamples.length} gap samples; support ${["ground", "solid", "bridge", "none"].map((k) => `${k} ${samples.filter((s) => s.support === k).length}`).join(", ")}`)
}
{
  // Drive the centreline: each sample and each midpoint, hint from the previous answer.
  let hint = 0
  let worstD = 0
  let backwards = 0
  let previous = -1
  let laps = 0
  for (let i = 0; i <= count * 2; i++) {
    const a = at(Math.floor(i / 2))
    const b = at(Math.floor(i / 2) + 1)
    const x = i % 2 === 0 ? a.x : (a.x + b.x) / 2
    const z = i % 2 === 0 ? a.z : (a.z + b.z) / 2
    const hit = locateNear(t, x, z, hint)
    hint = hit.index
    worstD = Math.max(worstD, Math.abs(hit.d))
    const s = hit.s + laps * t.length
    if (previous >= 0 && s < previous - 1e-6) {
      if (previous - s > t.length / 2) {
        laps += 1
      } else backwards += 1
    }
    previous = hit.s + laps * t.length
  }
  check("locateNear walk", worstD < 0.02 && backwards === 0, `worst |d| ${worstD.toFixed(4)} m, ${backwards} steps backwards over one lap`)
  const land = pointAt(t, gapTo + 1)
  const below = locateBelow(t, land.x, land.y + 0.5, land.z)
  check("locateBelow at landing", below !== null && Math.abs(below.s - (gapTo + 1)) < 0.6, below === null ? "nothing found" : `found s=${below.s.toFixed(2)} (expected ${(gapTo + 1).toFixed(2)}), road y ${below.y.toFixed(2)}`)
}
{
  const onRoad = (x: number, z: number, hint: number, reach: number): boolean => {
    const hit = locateNear(t, x, z, hint, 200)
    return Math.abs(hit.d) + reach <= hit.halfWidth + 1e-6 && hit.surface
  }
  const near = (x: number, z: number, y: number): number => {
    let best = 0
    let bestD = Infinity
    samples.forEach((sample, i) => {
      const d = Math.hypot(sample.x - x, sample.z - z) + Math.abs(sample.y - y) * 4
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }
  const props = t.props.every((prop) => onRoad(prop.x, prop.z, near(prop.x, prop.z, prop.y), prop.radius))
  const pads = t.boosts.every((pad) => onRoad(pad.x, pad.z, near(pad.x, pad.z, pad.y), pad.width / 2))
  const posts = t.bollards.every((post) => onRoad(post.x, post.z, near(post.x, post.z, post.y), post.radius))
  check("objects on the road", props && pads && posts, `${t.props.length} props ${props ? "ok" : "OFF"}, ${t.boosts.length} pads ${pads ? "ok" : "OFF"}, ${t.bollards.length} posts ${posts ? "ok" : "OFF"}, ${t.doors.length} door leaves`)
}

// ---------------------------------------------------------------- jump

interface Flight {
  speed: number
  distance: number
  s: number | null
  y: number
  onLanding: boolean
  where: string
}
const flights: Array<Flight> = []
{
  const lip = pointAt(t, gapFrom)
  const lipSample = at(Math.round(gapFrom / t.spacing) - 1)
  const pitch = lipSample.pitch
  const landingEnd = featureOf("jump")?.sTo ?? gapTo + 30
  for (const speed of [16, 20, 24, 30, 36]) {
    let x = lip.x
    let y = lip.y
    let z = lip.z
    const vx0 = Math.sin(lip.yaw) * Math.cos(pitch) * speed
    const vz0 = Math.cos(lip.yaw) * Math.cos(pitch) * speed
    let vy = Math.sin(pitch) * speed
    const dt = 1 / 480
    let result: Flight = { speed, distance: 0, s: null, y: 0, onLanding: false, where: "nothing" }
    const landingTop = pointAt(t, gapTo).y
    let checkedEdge = false
    for (let step = 0; step < 4000; step++) {
      x += vx0 * dt
      z += vz0 * dt
      vy -= RULES.gravity * dt
      y += vy * dt
      const travelled = Math.hypot(x - lip.x, z - lip.z)
      if (!checkedEdge && travelled >= gapTo - gapFrom) {
        checkedEdge = true
        if (y < landingTop) {
          result = { speed, distance: travelled, s: null, y, onLanding: false, where: `falls short: reaches the landing edge ${(landingTop - y).toFixed(2)} m below its top and hits the face` }
          break
        }
      }
      const hit = locateBelow(t, x, y, z)
      if (hit !== null && y <= hit.y) {
        const onLanding = hit.s >= gapTo - 0.01 && hit.s <= landingEnd
        result = { speed, distance: travelled, s: hit.s, y: hit.y, onLanding, where: onLanding ? `on the landing, ${(hit.s - gapTo).toFixed(1)} m past its edge` : `on road at s=${hit.s.toFixed(1)}` }
        break
      }
      if (y < -1) {
        result = { speed, distance: travelled, s: null, y, onLanding: false, where: "off the road" }
        break
      }
    }
    flights.push(result)
  }
  const lipHeight = lip.y
  const landing = pointAt(t, gapTo)
  console.log(`jump: lip at s=${gapFrom.toFixed(1)} y=${lipHeight.toFixed(2)} m, kicker ${(pitch * DEG).toFixed(1)} deg, gap ${(gapTo - gapFrom).toFixed(2)} m, landing edge y=${landing.y.toFixed(2)} m (${(lipHeight - landing.y).toFixed(2)} below the lip), g=${RULES.gravity}`)
  for (const flight of flights) console.log(`  ${flight.speed} m/s off the lip: comes down ${flight.distance.toFixed(1)} m from the lip, ${flight.where}`)
  const byspeed = (v: number) => flights.find((f) => f.speed === v)
  const clear = [24, 30, 36].every((v) => byspeed(v)?.onLanding === true && (v !== 24 || (byspeed(v)?.distance ?? 0) > gapTo - gapFrom + 2))
  check("jump", clear && byspeed(16)?.onLanding === false, `clears from 24 m/s up${clear ? "" : " FAILS"}, 16 m/s ${byspeed(16)?.onLanding === false ? "falls short" : "clears (too easy)"}`)
}

// ---------------------------------------------------------------- picture

const b = t.bounds
const pad = 6
const scale = 9
const W = (b.maxX - b.minX + 2 * pad) * scale
const H = (b.maxZ - b.minZ + 2 * pad) * scale
const X = (x: number) => (x - b.minX + pad) * scale
const Z = (z: number) => (z - b.minZ + pad) * scale
const maxY = Math.max(...samples.map((sample) => sample.y), 1)
const heightColour = (y: number): string => {
  // Grey at ground, through blue and green to orange at the top.
  const u = Math.min(1, y / maxY)
  if (y < 0.03) return "#8f949a"
  const hue = 220 - 200 * u
  return `hsl(${hue.toFixed(0)} 60% ${(52 - 8 * u).toFixed(0)}%)`
}
const supportColour: Record<TrackSample["support"], string> = { ground: "#8f949a", solid: "#b07a3c", bridge: "#3c7ab0", none: "#d03030" }

const edges = (sample: TrackSample, extra: number = 0) => {
  const l = left(sample.yaw)
  const r = sample.halfWidth + extra
  return { lx: sample.x + l.x * r, lz: sample.z + l.z * r, rx: sample.x - l.x * r, rz: sample.z - l.z * r }
}

const top: Array<string> = []
// Road quads, lowest first so the upper level covers the lower.
const order = samples.map((_, i) => i).sort((i, j) => at(i).y - at(j).y)
for (const i of order) {
  const a = at(i)
  const c = at(i + 1)
  const ea = edges(a)
  const ec = edges(c)
  if (!a.surface) {
    top.push(`<polygon points="${X(ea.lx)},${Z(ea.lz)} ${X(ec.lx)},${Z(ec.lz)} ${X(ec.rx)},${Z(ec.rz)} ${X(ea.rx)},${Z(ea.rz)}" fill="none" stroke="#d03030" stroke-width="0.6" stroke-dasharray="3 3"/>`)
    continue
  }
  const wa = edges(a, 0.6)
  const wc = edges(c, 0.6)
  top.push(`<polygon points="${X(wa.lx)},${Z(wa.lz)} ${X(wc.lx)},${Z(wc.lz)} ${X(wc.rx)},${Z(wc.rz)} ${X(wa.rx)},${Z(wa.rz)}" fill="#2a2a2a"/>`)
  top.push(`<polygon points="${X(ea.lx)},${Z(ea.lz)} ${X(ec.lx)},${Z(ec.lz)} ${X(ec.rx)},${Z(ec.rz)} ${X(ea.rx)},${Z(ea.rz)}" fill="${heightColour(a.y)}" stroke="${heightColour(a.y)}" stroke-width="0.5"/>`)
}
const line = (s: number, colour: string, width: number, label: string): string => {
  const p = pointAt(t, s)
  const sample = at(Math.round(s / t.spacing))
  const l = left(p.yaw)
  const r = sample.halfWidth + 0.8
  return `<line x1="${X(p.x + l.x * r)}" y1="${Z(p.z + l.z * r)}" x2="${X(p.x - l.x * r)}" y2="${Z(p.z - l.z * r)}" stroke="${colour}" stroke-width="${width}"/>` + `<text x="${X(p.x - l.x * (r + 2.5))}" y="${Z(p.z - l.z * (r + 2.5))}" font-size="12" fill="${colour}" text-anchor="middle" dominant-baseline="middle">${label}</text>`
}
// Direction arrows every 30 m.
for (let s = 10; s < t.length; s += 30) {
  const p = pointAt(t, s)
  const f = { x: Math.sin(p.yaw), z: Math.cos(p.yaw) }
  const l = left(p.yaw)
  const tip = { x: p.x + f.x * 1.6, z: p.z + f.z * 1.6 }
  const back = { x: p.x - f.x * 1.2, z: p.z - f.z * 1.2 }
  top.push(`<polygon points="${X(tip.x)},${Z(tip.z)} ${X(back.x + l.x)},${Z(back.z + l.z)} ${X(back.x - l.x)},${Z(back.z - l.z)}" fill="#ffffff" opacity="0.85"/>`)
  top.push(`<text x="${X(p.x)}" y="${Z(p.z) - 10}" font-size="9" fill="#ffffff" text-anchor="middle">${s.toFixed(0)}</text>`)
}
t.checkpoints.forEach((s, i) => top.push(line(s, i === 0 ? "#ffffff" : "#ffd23c", i === 0 ? 4 : 3, i === 0 ? "START" : `CP${i}`)))
const propColour = { crate: "#c08a4a", barrel: "#3f7fbf", cone: "#ff7a1a", ball: "#e8483c" }
for (const prop of t.props) top.push(`<circle cx="${X(prop.x)}" cy="${Z(prop.z)}" r="${prop.radius * scale}" fill="${propColour[prop.kind]}" stroke="#2a1a0a" stroke-width="1"/>`)
for (const post of t.bollards) top.push(`<circle cx="${X(post.x)}" cy="${Z(post.z)}" r="${post.radius * scale}" fill="#d8d8d8" stroke="#202020" stroke-width="1.5"/>`)
for (const boost of t.boosts) {
  top.push(`<rect x="${X(boost.x) - (boost.width / 2) * scale}" y="${Z(boost.z) - (boost.length / 2) * scale}" width="${boost.width * scale}" height="${boost.length * scale}" transform="rotate(${-boost.yaw * DEG} ${X(boost.x)} ${Z(boost.z)})" fill="#30e0ff" opacity="0.8"/>`)
}
for (const door of t.doors) {
  top.push(`<line x1="${X(door.x)}" y1="${Z(door.z)}" x2="${X(door.x + Math.sin(door.yaw) * door.length)}" y2="${Z(door.z + Math.cos(door.yaw) * door.length)}" stroke="#ff3cc8" stroke-width="4"/>`)
}
// Feature labels, beside the middle of each stretch.
t.features.forEach((feature) => {
  const mid = (feature.sFrom + feature.sTo) / 2
  const p = pointAt(t, mid)
  const l = left(p.yaw)
  const r = 6.5
  top.push(`<text x="${X(p.x + l.x * r)}" y="${Z(p.z + l.z * r)}" font-size="13" font-weight="bold" fill="#1a1a1a" text-anchor="middle" dominant-baseline="middle">${feature.kind} ${feature.sFrom.toFixed(0)}–${feature.sTo.toFixed(0)}</text>`)
})
// Grid every 10 m and the 100 x 60 footprint.
const grid: Array<string> = []
for (let x = Math.ceil(b.minX / 10) * 10 - 10; x <= b.maxX + 10; x += 10) grid.push(`<line x1="${X(x)}" y1="0" x2="${X(x)}" y2="${H}" stroke="#ddd" stroke-width="1"/><text x="${X(x) + 2}" y="12" font-size="10" fill="#999">${x}</text>`)
for (let z = Math.ceil(b.minZ / 10) * 10 - 10; z <= b.maxZ + 10; z += 10) grid.push(`<line x1="0" y1="${Z(z)}" x2="${W}" y2="${Z(z)}" stroke="#ddd" stroke-width="1"/><text x="2" y="${Z(z) - 2}" font-size="10" fill="#999">${z}</text>`)
grid.push(`<rect x="${X(-50)}" y="${Z(-30)}" width="${100 * scale}" height="${60 * scale}" fill="none" stroke="#bbb" stroke-dasharray="6 4"/>`)

// Rough view from the camera: 55 degrees above the horizon, turned 20 degrees, orthographic.
const elevation = 55 / DEG
const azimuth = 20 / DEG
const project = (x: number, y: number, z: number) => {
  const cx = (b.minX + b.maxX) / 2
  const cz = (b.minZ + b.maxZ) / 2
  const rx = (x - cx) * Math.cos(azimuth) - (z - cz) * Math.sin(azimuth)
  const rz = (x - cx) * Math.sin(azimuth) + (z - cz) * Math.cos(azimuth)
  return { u: rx, v: rz * Math.sin(elevation) - y * Math.cos(elevation), depth: rz * Math.cos(elevation) + y * Math.sin(elevation) }
}
const view: Array<{ depth: number; svg: string }> = []
const VS = 8
const VW = W
const VH = 60 * VS + 120
const U = (u: number) => VW / 2 + u * VS
const V = (v: number) => VH / 2 + v * VS
for (let i = 0; i < count; i++) {
  const a = at(i)
  const c = at(i + 1)
  if (!a.surface) continue
  const ea = edges(a)
  const ec = edges(c)
  const quad = [
    project(ea.lx, a.y, ea.lz),
    project(ec.lx, c.y, ec.lz),
    project(ec.rx, c.y, ec.rz),
    project(ea.rx, a.y, ea.rz)
  ]
  const depth = quad.reduce((sum, p) => sum + p.depth, 0) / 4
  view.push({ depth, svg: `<polygon points="${quad.map((p) => `${U(p.u)},${V(p.v)}`).join(" ")}" fill="${heightColour(a.y)}" stroke="${heightColour(a.y)}" stroke-width="0.6"/>` })
  if (a.y > 0.03) {
    // The side faces of a raised road, down to the ground.
    for (const [ex, ez, fx, fz] of [[ea.lx, ea.lz, ec.lx, ec.lz], [ea.rx, ea.rz, ec.rx, ec.rz]] as const) {
      const face = [project(ex, a.y, ez), project(fx, c.y, fz), project(fx, 0, fz), project(ex, 0, ez)]
      const fd = face.reduce((sum, p) => sum + p.depth, 0) / 4
      view.push({ depth: fd - 0.01, svg: `<polygon points="${face.map((p) => `${U(p.u)},${V(p.v)}`).join(" ")}" fill="${a.support === "bridge" ? "#6a8aa8" : "#9a7a5a"}" opacity="0.9"/>` })
    }
  }
}
view.sort((p, q) => q.depth - p.depth)

// Elevation profile.
const PH = 260
const PW = W
const PX = (s: number) => 40 + (s / t.length) * (PW - 60)
const PY = (y: number) => PH - 30 - (y / 8) * (PH - 60)
const prof: Array<string> = []
for (let y = 0; y <= 8; y += 1) prof.push(`<line x1="40" y1="${PY(y)}" x2="${PW - 20}" y2="${PY(y)}" stroke="#ddd"/><text x="10" y="${PY(y) + 4}" font-size="10" fill="#777">${y}</text>`)
for (const feature of t.features) prof.push(`<rect x="${PX(feature.sFrom)}" y="20" width="${PX(feature.sTo) - PX(feature.sFrom)}" height="${PH - 50}" fill="#000" opacity="0.06"/><text x="${PX((feature.sFrom + feature.sTo) / 2)}" y="16" font-size="11" text-anchor="middle" fill="#444">${feature.kind}</text>`)
for (let i = 0; i < count; i++) {
  const a = at(i)
  const c = at(i + 1)
  if (i === count - 1) continue
  prof.push(`<line x1="${PX(a.s)}" y1="${PY(a.y)}" x2="${PX(c.s)}" y2="${PY(c.y)}" stroke="${supportColour[a.support]}" stroke-width="3"/>`)
}
for (let s = 0; s < t.length; s += 50) prof.push(`<text x="${PX(s)}" y="${PH - 10}" font-size="10" text-anchor="middle" fill="#777">${s}</text>`)
t.checkpoints.forEach((s, i) => prof.push(`<line x1="${PX(s)}" y1="20" x2="${PX(s)}" y2="${PH - 30}" stroke="#d0a000" stroke-dasharray="4 3"/><text x="${PX(s) + 3}" y="32" font-size="10" fill="#a07000">${i === 0 ? "start" : `CP${i}`}</text>`))
prof.push(`<text x="${PW - 20}" y="${PH - 34}" font-size="11" text-anchor="end" fill="#555">support: <tspan fill="${supportColour.ground}">ground</tspan> <tspan fill="${supportColour.solid}">solid</tspan> <tspan fill="${supportColour.bridge}">bridge</tspan> <tspan fill="${supportColour.none}">none</tspan></text>`)

const failed = results.filter((r) => !r.ok)
const summary = [
  `${t.name}: ${t.length.toFixed(1)} m, footprint ${(b.maxX - b.minX).toFixed(1)} x ${(b.maxZ - b.minZ).toFixed(1)} m, highest road ${maxY.toFixed(2)} m`,
  ...results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`)
]
const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Helvetica,Arial,sans-serif">
<div style="padding:10px 14px;font-size:14px"><b>${t.name}</b> · ${t.length.toFixed(1)} m · footprint ${(b.maxX - b.minX).toFixed(1)} × ${(b.maxZ - b.minZ).toFixed(1)} m · highest ${maxY.toFixed(2)} m · top view, +Z (camera side) at the bottom · ${failed.length === 0 ? "all checks pass" : `${failed.length} checks FAIL`}</div>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="display:block;background:#e9efe0">${grid.join("")}${top.join("")}</svg>
<div style="padding:6px 14px;font-size:13px">Rough camera view (55° up, turned 20°)</div>
<svg xmlns="http://www.w3.org/2000/svg" width="${VW}" height="${VH}" style="display:block;background:#e9efe0">${view.map((p) => p.svg).join("")}</svg>
<div style="padding:6px 14px;font-size:13px">Elevation profile (y in m against s in m)</div>
<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}" style="display:block;background:#fff">${prof.join("")}</svg>
<pre style="padding:6px 14px;font-size:12px;margin:0">${summary.join("\n")}</pre>
</body></html>`

mkdirSync(dirname(out), { recursive: true })
writeFileSync(`${out}.html`, html)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: Math.ceil(W), height: 800 }, deviceScaleFactor: 1 })
await page.setContent(html)
await page.screenshot({ path: `${out}.png`, fullPage: true })
await browser.close()

console.log(summary[0])
for (const line of summary.slice(1)) console.log(line)
console.log(`wrote ${out}.png and ${out}.html`)
process.exit(failed.length === 0 ? 0 : 1)
