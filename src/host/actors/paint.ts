/**
 * The car's livery for each standing (`standing.ts`): its body paint, its stripe, its wheel
 * hubs, and a glow it throws on the road.
 *
 * - The podium: gold, silver and bronze metal, a glossy dark stripe, hubs in the same metal and
 *   a glow of that metal on the road under the car.
 * - The rest of the top ten: a blue pearl that shifts colour with the angle.
 * - The rest of the top five, and a player with no place: the game's own red.
 * - Everyone else: a dull grey, flat and unpolished.
 *
 * The metals and the pearl carry `shineBit`: flakes in the paint that catch the light one by
 * one, a sky mirrored in the paint, and a rim of light round its edges. The flakes keep to the
 * car, so each such paint is told where the car is and which way it points every frame
 * (`placeShine`).
 */
import { Material3D } from "@pixi/3d"
import type { ShaderBit } from "@pixi/3d"
import type { Standing } from "../standing.ts"
import { palette } from "../palette.ts"
import type { CarLook } from "./car.ts"

/**
 * In the paint: the flakes, cells of the car's own frame (`along` is metres along it, nose
 * ahead), each a small round spark. One in five or so catches the light for a moment, each at
 * its own time.
 */
const paintGl = /* glsl */ `{
  vec3 rel = vPosition - material.shineCentre.xyz;
  vec3 fwd = material.shineAxis.xyz;
  vec3 side = vec3(fwd.z, 0.0, -fwd.x);
  float along = dot(rel, fwd);
  vec3 grain = vec3(dot(rel, side), rel.y, along) * 30.0;
  vec3 cell = floor(grain);
  float seed = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float spot = 1.0 - smoothstep(0.12, 0.32, length(fract(grain) - 0.5));
  float twinkle = spot * step(0.8, seed) * pow(max(0.0, sin(uTime * 2.3 + seed * 90.0)), 14.0);
  emissive += material.shineColour.rgb * twinkle * material.shineFlake;
}`
const paintGpu = /* wgsl */ `{
  let rel = input.vPosition - material.shineCentre.xyz;
  let fwd = material.shineAxis.xyz;
  let side = vec3<f32>(fwd.z, 0.0, -fwd.x);
  let along = dot(rel, fwd);
  let grain = vec3<f32>(dot(rel, side), rel.y, along) * 30.0;
  let cell = floor(grain);
  let seed = fract(sin(dot(cell, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
  let spot = 1.0 - smoothstep(0.12, 0.32, length(fract(grain) - 0.5));
  let twinkle = spot * step(0.8, seed) * pow(max(0.0, sin(global.uTime * 2.3 + seed * 90.0)), 14.0);
  emissive += material.shineColour.rgb * twinkle * material.shineFlake;
}`
/**
 * After the lights: a made-up sky in the paint's own colour, as polished metal would mirror it
 * (the scene has no picture of its surroundings to reflect): dark toward the ground, bright
 * toward the sky with a hot line at the horizon. Then the rim, brighter the more a surface
 * turns away from the camera.
 */
const afterGl = /* glsl */ `{
  vec3 r = reflect(-viewDir, normal);
  float sky = smoothstep(-0.3, 0.7, r.y);
  float horizon = exp(-pow((r.y - 0.12) / 0.1, 2.0));
  finalColor += material.shineTint.rgb * (0.08 + 0.9 * sky * sky + 0.9 * horizon) * material.shineMirror;
  finalColor += material.shineColour.rgb * pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0) * material.shineRim;
}`
const afterGpu = /* wgsl */ `{
  let r = reflect(-viewDir, normal);
  let sky = smoothstep(-0.3, 0.7, r.y);
  let horizon = exp(-pow((r.y - 0.12) / 0.1, 2.0));
  finalColor += material.shineTint.rgb * (0.08 + 0.9 * sky * sky + 0.9 * horizon) * material.shineMirror;
  finalColor += material.shineColour.rgb * pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0) * material.shineRim;
}`

export const shineBit: ShaderBit = {
  name: "tgpStandingShine",
  bindings: {
    material: {
      /** The car's middle in the world. */
      shineCentre: "vec4<f32>",
      /** The car's forward direction in the world. */
      shineAxis: "vec4<f32>",
      /** The light's colour, and the paint's own for the mirrored sky; linear light. */
      shineColour: "vec4<f32>",
      shineTint: "vec4<f32>",
      shineMirror: "f32",
      shineFlake: "f32",
      shineRim: "f32"
    }
  },
  gpu: { fragment: { material: paintGpu, lobePostLighting: afterGpu } },
  gl: { fragment: { material: paintGl, lobePostLighting: afterGl } }
}

/** A colour as linear light, for a shader value. */
const linear = (colour: number): Array<number> => {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return [channel((colour >> 16) & 255), channel((colour >> 8) & 255), channel(colour & 255), 1]
}

interface Shine {
  /** The light's colour: the flakes and the rim. */
  readonly colour: number
  /** The paint's colour, and how strongly it mirrors the made-up sky. */
  readonly tint: number
  readonly mirror: number
  readonly flake: number
  readonly rim: number
}

const shiny = (material: Material3D, shine: Shine): Material3D => {
  material.data["shineColour"] = linear(shine.colour)
  material.data["shineTint"] = linear(shine.tint)
  material.data["shineMirror"] = shine.mirror
  material.data["shineFlake"] = shine.flake
  material.data["shineRim"] = shine.rim
  material.data["shineCentre"] = [0, 0, 0, 0]
  material.data["shineAxis"] = [0, 0, 1, 0]
  return material
}

/** What the car wears for a standing. */
export interface Livery {
  readonly body: Material3D
  readonly stripe: Material3D
  readonly hub: Material3D
  /** The light the car throws on the road under it, or none. */
  readonly glow: number | null
}

const coat = { factor: 1, roughness: 0.05 }

/** A polished metal paint: clear-coated, mirroring the sky, swept, flaked and rimmed. */
const metal = (colour: number, shine: Omit<Shine, "tint">): Material3D =>
  shiny(new Material3D({ baseColor: colour, metallic: 0.55, roughness: 0.24, clearcoat: coat, passes: { outline: true }, extraBits: [shineBit] }), { ...shine, tint: colour })

/** Wheel hubs in a metal. */
const hubOf = (colour: number): Material3D => new Material3D({ baseColor: colour, metallic: 0.8, roughness: 0.22, emissive: { color: colour, strength: 0.25 } })

/** The livery of each standing; the usual one is `look`'s own. */
export const liveries = (look: CarLook): Record<Standing, Livery> => {
  const usual: Livery = { body: look.body, stripe: look.stripe, hub: look.hub, glow: null }
  // One glossy dark stripe for the podium: the metal round it reads brighter.
  const darkStripe = new Material3D({ baseColor: palette.podiumStripe, metallic: 0.2, roughness: 0.2, clearcoat: coat })
  return {
    first: {
      body: metal(palette.paintGold, { colour: 0xfff4c2, mirror: 0.55, flake: 2.4, rim: 0.4 }),
      stripe: darkStripe,
      hub: hubOf(palette.paintGold),
      glow: palette.paintGold
    },
    second: {
      body: metal(palette.paintSilver, { colour: 0xffffff, mirror: 0.42, flake: 2.0, rim: 0.36 }),
      stripe: darkStripe,
      hub: hubOf(palette.paintSilver),
      glow: 0xcfe3ff
    },
    third: {
      body: metal(palette.paintBronze, { colour: 0xffd9b3, mirror: 0.5, flake: 1.8, rim: 0.34 }),
      stripe: darkStripe,
      hub: hubOf(palette.paintBronze),
      glow: palette.paintBronze
    },
    "top-five": usual,
    "top-ten": {
      ...usual,
      body: shiny(
        new Material3D({
          baseColor: palette.paintPearl,
          metallic: 0.35,
          roughness: 0.28,
          clearcoat: coat,
          iridescence: { factor: 1, ior: 1.6, thicknessMaximum: 520 },
          passes: { outline: true },
          extraBits: [shineBit]
        }),
        { colour: 0xa8eeff, tint: 0x7a96ff, mirror: 0.25, flake: 1.2, rim: 0.45 }
      )
    },
    field: { ...usual, body: new Material3D({ baseColor: palette.paintDull, roughness: 0.85, metallic: 0, passes: { outline: true } }) },
    unplaced: usual
  }
}

/** Tells a paint with `shineBit` where the car is and which way it points. */
export const placeShine = (material: Material3D, x: number, y: number, z: number, yaw: number): void => {
  if (!("shineCentre" in material.data)) return
  material.data["shineCentre"] = [x, y + 0.6, z, 0]
  material.data["shineAxis"] = [Math.sin(yaw), 0, Math.cos(yaw), 0]
}
