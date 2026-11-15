/**
 * The Pixi application, its one 3D view, the fixed camera and the daylight.
 *
 * The camera is orthographic, high above the model and turned a little around the
 * vertical, so the whole track shows like a scale model on a table. It is refitted on
 * every resize: the slab's box (with its height) is projected onto the screen and scaled
 * to fit, as large as the window allows: the HUD lies over the model's corners.
 */
import { Box, Container3D, DirectionalLight, PostEffect, View3D } from "@pixi/3d"
import type { EffectFragment, Pass3D } from "@pixi/3d"
import { BloomEffect, OutlinePass } from "@pixi/3d/extras"
import { Application, UniformGroup } from "pixi.js"
import type { TrackData } from "../sim/index.ts"
import type { Stage } from "./contract.ts"
import { palette } from "./palette.ts"
import { slabBox } from "./world/dimensions.ts"

/** How far above the horizon the camera looks down, in degrees. */
export const CAMERA_ELEVATION_DEG = 52
/**
 * How far the camera is turned around the vertical from looking straight down -Z, in
 * degrees. The stage picks the turn between the two limits that shows the model largest in
 * the window; `CAMERA_YAW_DEG` is the usual one (a 16:9 window), for whoever places things
 * by what the camera sees.
 */
export const CAMERA_YAW_DEG = 11
const CAMERA_YAW_MIN_DEG = 6
const CAMERA_YAW_MAX_DEG = 20
/** Screen pixels between the model and the window's edges. The HUD sits over the model's corners. */
export const FIT_MARGIN_PX = 8
/** Distance from the camera to the point it looks at. Orthographic, so it only sets the clip range. */
const CAMERA_DISTANCE = 220
/** The sun: where it shines from (a horizontal angle measured like yaw, and its height above the horizon). */
export const SUN_YAW_DEG = 215
export const SUN_ELEVATION_DEG = 58
/** Shadow map size and edge filter: soft enough for a scale model, sharp enough for the car's shadow in the air. */
const SHADOW_QUALITY = "ultra"
const SHADOW_FILTER = "pcf-high"
/** Most pixels per CSS pixel the page draws at, for sharp edges on high-DPI screens. */
const MAX_RESOLUTION = 2
/**
 * Most device pixels the canvas may have: past it the whole page draws at a lower pixel
 * density (still above 1 on a high-DPI laptop). Drawing only the 3D view at a lower
 * resolution costs more, because the view then renders to its own texture first.
 */
const MAX_CANVAS_PIXELS = 3_300_000
/** Linear brightness where bloom starts (eased in from half of it). */
const BLOOM_THRESHOLD = 1.7
/** Strongest tilt-shift blur, in CSS pixels, reached at the screen's top and bottom edges. */
const TILT_SHIFT_BLUR_PX = 2

/**
 * A light tilt-shift for the miniature feel, judged on the screen rather than on depth
 * (the library's TiltShiftEffect, like its SsaoEffect, reads depth as perspective and
 * blurs everything under an orthographic camera). Sharp in a horizontal band around the
 * model's middle, a soft disc blur growing toward the top and bottom.
 */
class ScreenTiltShift extends PostEffect {
  protected override readonly uniforms = new UniformGroup({
    // centre (uv y, top down), sharp half-height, full-blur half-height, blur in device pixels
    uBand: { value: new Float32Array([0.5, 0.4, 0.6, 2]), type: "vec4<f32>" }
  })
  protected override readonly fragment: EffectFragment = {
    gpu: `
fn effect(uv: vec2<f32>) -> vec4<f32> {
  let k = smoothstep(fx.uBand.y, fx.uBand.z, abs(uv.y - fx.uBand.x));
  let r = fx.uBand.w * k;
  var sum = sampleColor(uv);
  if (r < 0.3) { return sum; }
  for (var i = 0; i < 12; i = i + 1) {
    let fi = f32(i);
    let a = fi * 2.3999632;
    let d = sqrt((fi + 0.5) / 12.0) * r;
    sum += sampleColor(uv + vec2<f32>(cos(a), sin(a)) * d * texel());
  }
  return sum / 13.0;
}
`,
    gl: `
vec4 effect(vec2 uv) {
  float k = smoothstep(uBand.y, uBand.z, abs(uv.y - uBand.x));
  float r = uBand.w * k;
  vec4 sum = sampleColor(uv);
  if (r < 0.3) { return sum; }
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float a = fi * 2.3999632;
    float d = sqrt((fi + 0.5) / 12.0) * r;
    sum += sampleColor(uv + vec2(cos(a), sin(a)) * d * texel());
  }
  return sum / 13.0;
}
`
  }

  constructor() {
    super({ stage: "afterToneMapping" })
  }

  setBand(centre: number, sharp: number, full: number, blur: number): void {
    this.writeLane(this.uniforms, "uBand", 0, centre)
    this.writeLane(this.uniforms, "uBand", 1, sharp)
    this.writeLane(this.uniforms, "uBand", 2, full)
    this.writeLane(this.uniforms, "uBand", 3, blur)
  }
}

export interface StageOptions {
  /** Renderer to ask for. The page passes what `backend.ts` chose; WebGL when nothing is passed (the labs). */
  readonly preference?: "webgl" | "webgpu"
  readonly tiltShift?: boolean
  /**
   * A soft glow on light brighter than white (the turbines' lamps, the boost chevrons at
   * their pulse). Off by default: it moves the whole scene onto a float target, which cost
   * about 4.5 ms a frame at 1600x900 and 1.5x pixel density in the lab's bench.
   */
  readonly bloom?: boolean
  /** For labs and slow machines: shadow map size and edge filter. */
  readonly shadowQuality?: "low" | "medium" | "high" | "ultra"
  readonly shadowFilter?: "hard" | "pcf" | "pcf-high"
  /** For labs: cap on device pixels per CSS pixel. */
  readonly maxResolution?: number
  /** For labs: look at a point up close instead of the whole track. */
  readonly focus?: { readonly x: number; readonly y?: number; readonly z: number; readonly zoom: number }
}

const DEG = Math.PI / 180

export const createStage = async (track: TrackData, mount: HTMLElement, options: StageOptions = {}): Promise<Stage> => {
  /** Device pixels per CSS pixel for a canvas of this CSS size: sharp, within the pixel budget. */
  const density = (width: number, height: number): number => {
    const wanted = Math.min(window.devicePixelRatio || 1, options.maxResolution ?? MAX_RESOLUTION)
    const budget = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height))
    return Math.max(1, Math.min(wanted, budget))
  }
  const app = new Application()
  const resizeTarget: HTMLElement | Window = mount === document.body ? window : mount
  await app.init({
    resizeTo: resizeTarget,
    backgroundColor: palette.backdrop,
    antialias: true,
    resolution: density(window.innerWidth, window.innerHeight),
    autoDensity: true,
    preference: options.preference ?? "webgl"
  })
  mount.appendChild(app.canvas)

  const slab = slabBox(track)
  const passes: Array<Pass3D> = []
  const tiltShift = new ScreenTiltShift()
  // Bloom reads the scene as linear light before the tone curve. Its threshold sits well
  // above the brightest sunlit paint (about 1.1), so only emissive light glows: the boost
  // chevrons at the top of their pulse and the turbines' warning lamps. It works the same
  // under the orthographic camera.
  if (options.bloom === true) passes.push(new BloomEffect({ threshold: BLOOM_THRESHOLD, intensity: 1, radius: 0.5, levels: 3, resolution: 0.25 }))
  if (options.tiltShift !== false) passes.push(tiltShift)
  // Ink rims for materials that opt in with `passes: { outline: true }` (the car, crates).
  passes.push(new OutlinePass({ width: 0.035, color: palette.ink }))

  const view = new View3D({
    autoResize: true,
    shadowQuality: options.shadowQuality ?? SHADOW_QUALITY,
    shadowFilter: options.shadowFilter ?? SHADOW_FILTER,
    environment: { skyColor: 0xe4ecf2, groundColor: 0xb5a88f, intensity: 0.5 },
    toneMapping: "none",
    passes
  })
  app.stage.addChild(view)

  const world = new Container3D({ label: "scene" })
  view.root.addChild(world)

  // The sun: soft shadows over a fixed box around the whole slab, so the car's shadow in
  // the air always lands somewhere and the box never shimmers as things move.
  const centre = { x: (slab.minX + slab.maxX) / 2, y: (slab.bottom + slab.top) / 2, z: (slab.minZ + slab.maxZ) / 2 }
  const sun = new DirectionalLight({
    color: 0xfff4e4,
    intensity: 2.75,
    castShadow: true,
    shadow: {
      bounds: Box.fromCenterSize(centre, { x: slab.maxX - slab.minX + 2, y: slab.top - slab.bottom + 14, z: slab.maxZ - slab.minZ + 2 }),
      bias: 0.0006,
      normalBias: 0.02
    }
  })
  const sunYaw = SUN_YAW_DEG * DEG
  const sunElevation = SUN_ELEVATION_DEG * DEG
  sun.position.set(centre.x + Math.sin(sunYaw) * Math.cos(sunElevation) * 100, centre.y + Math.sin(sunElevation) * 100, centre.z + Math.cos(sunYaw) * Math.cos(sunElevation) * 100)
  sun.lookAt(centre)
  world.addChild(sun)

  // Camera axes. `toward` points from the scene to the camera; `right` and `up` span the screen.
  // The turn around the vertical is chosen on every fit (see `fit`), so these change with it.
  const elevation = CAMERA_ELEVATION_DEG * DEG
  let yaw = CAMERA_YAW_DEG * DEG
  type Axis = readonly [number, number, number]
  const axesAt = (turn: number): { toward: Axis; right: Axis; up: Axis } => {
    const toward = [Math.sin(turn) * Math.cos(elevation), Math.sin(elevation), Math.cos(turn) * Math.cos(elevation)] as const
    const right = [Math.cos(turn), 0, -Math.sin(turn)] as const
    const up = [toward[1] * right[2] - toward[2] * right[1], toward[2] * right[0] - toward[0] * right[2], toward[0] * right[1] - toward[1] * right[0]] as const
    return { toward, right, up }
  }
  const dot = (a: Axis, x: number, y: number, z: number): number => a[0] * x + a[1] * y + a[2] * z
  /** The slab's box on screen for a turn, in world units along `right` and `up`, and its depth range. */
  const boxAt = (turn: number) => {
    const { toward, right, up } = axesAt(turn)
    let minR = Infinity
    let maxR = -Infinity
    let minU = Infinity
    let maxU = -Infinity
    let minD = Infinity
    let maxD = -Infinity
    for (const x of [slab.minX, slab.maxX]) {
      for (const y of [slab.bottom, slab.top]) {
        for (const z of [slab.minZ, slab.maxZ]) {
          const r = dot(right, x, y, z)
          const u = dot(up, x, y, z)
          const d = dot(toward, x, y, z)
          minR = Math.min(minR, r)
          maxR = Math.max(maxR, r)
          minU = Math.min(minU, u)
          maxU = Math.max(maxU, u)
          minD = Math.min(minD, d)
          maxD = Math.max(maxD, d)
        }
      }
    }
    return { minR, maxR, minU, maxU, minD, maxD }
  }

  const camera = view.camera
  camera.mode = "orthographic"
  // A tight clip range keeps depth precise enough for the thin layers (paint, wall bands).
  camera.near = CAMERA_DISTANCE * 0.3
  camera.far = CAMERA_DISTANCE * 1.9

  let focus = options.focus
  const fit = (): void => {
    const width = app.screen.width
    const height = app.screen.height
    if (width <= 0 || height <= 0) return
    // The map is the picture: among the turns allowed, take the one that shows the slab
    // largest in this window. A wide window wants less turn, a tall one more.
    const usableW = Math.max(50, width - 2 * FIT_MARGIN_PX)
    const usableH = Math.max(50, height - 2 * FIT_MARGIN_PX)
    let pixelsPerMetre = 0
    for (let degrees = CAMERA_YAW_MIN_DEG; degrees <= CAMERA_YAW_MAX_DEG; degrees += 0.5) {
      const box = boxAt(degrees * DEG)
      const scale = Math.min(usableW / (box.maxR - box.minR), usableH / (box.maxU - box.minU))
      if (scale > pixelsPerMetre + 1e-9) {
        pixelsPerMetre = scale
        yaw = degrees * DEG
      }
    }
    const { toward, right, up } = axesAt(yaw)
    const { minR, maxR, minU, maxU, minD, maxD } = boxAt(yaw)
    let targetR = (minR + maxR) / 2
    let targetU = (minU + maxU) / 2
    let targetD = (minD + maxD) / 2
    if (focus !== undefined) {
      pixelsPerMetre *= focus.zoom
      const { x, z } = focus
      const y = focus.y ?? track.wallHeight
      targetR = dot(right, x, y, z)
      targetU = dot(up, x, y, z)
      targetD = dot(toward, x, y, z)
    }
    const target = {
      x: right[0] * targetR + up[0] * targetU + toward[0] * targetD,
      y: right[1] * targetR + up[1] * targetU + toward[1] * targetD,
      z: right[2] * targetR + up[2] * targetU + toward[2] * targetD
    }
    camera.orthographicSize = width / 2 / pixelsPerMetre
    camera.position.set(target.x + toward[0] * CAMERA_DISTANCE, target.y + toward[1] * CAMERA_DISTANCE, target.z + toward[2] * CAMERA_DISTANCE)
    camera.lookAt(target)
    // Tilt-shift: sharp over the band the slab fills, soft only toward the screen's top and bottom.
    const centreY = 0.5
    const halfSpan = ((maxU - minU) * pixelsPerMetre) / 2 / height
    tiltShift.setBand(centreY, halfSpan * 0.92, halfSpan * 1.35, TILT_SHIFT_BLUR_PX * app.renderer.resolution)
    // Keep the pixel density within budget for the new size (this resize comes back here once).
    const resolution = density(width, height)
    if (Math.abs(resolution - app.renderer.resolution) > 0.01) app.renderer.resize(width, height, resolution)
  }
  fit()
  app.renderer.on("resize", fit)

  return {
    app,
    view,
    world,
    focusOn(next) {
      focus = next ?? undefined
      fit()
    },
    groundDirection(screenX, screenY) {
      // Screen right is the camera's `right` on the ground. Screen down is toward the
      // camera, foreshortened by the elevation: a screen distance downward covers
      // 1 / sin(elevation) as much ground, so the car heads where the pointer shows.
      const down = screenY / Math.sin(elevation)
      const x = Math.cos(yaw) * screenX + Math.sin(yaw) * down
      const z = -Math.sin(yaw) * screenX + Math.cos(yaw) * down
      const length = Math.hypot(x, z)
      return length === 0 ? { x: 0, z: 0 } : { x: x / length, z: z / length }
    }
  }
}
