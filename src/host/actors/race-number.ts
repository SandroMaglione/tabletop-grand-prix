/**
 * The player's place on the board painted on the car's roof: big digits straight on the paint
 * and the stripe, reading the right way up with the car's nose ahead. Up to 99 (`shownRank`);
 * no number past it, nor without a place.
 *
 * White digits with a dark edge: they read on every paint, and on the podium's dark stripe.
 *
 * The digits are in the HUD's label face (Chakra Petch, bold), drawn again once it has loaded
 * if it had not when they were first drawn. They are a canvas drawn again only when the place changes, on a see-through plane
 * laid on the roof's flat top, inside its edges, a hair over the stripe. It is in the body,
 * so it leans, squashes and stretches with it.
 */
import { Container3D, Material3D, Mesh3D, PlaneGeometry } from "@pixi/3d"
import { CanvasSource, Texture } from "pixi.js"
import { hudLabelFont } from "../hud.ts"
import { palette } from "../palette.ts"
import { shownRank } from "../standing.ts"

const css = (colour: number): string => `#${colour.toString(16).padStart(6, "0")}`

/** The digits' colour, and their edge's. */
const look = { fill: 0xffffff, edge: palette.hudBack } as const

/**
 * The print on the roof (metres) and its middle in the body: the roof's flat top, which is
 * 0.86 wide and 0.8 long less its rounded edges. Its stripe's top is at 0.975.
 */
const WIDTH = 0.82
const LENGTH = 0.74
const AT = { x: 0, y: 0.977, z: -0.38 } as const
/** The canvas, in the print's proportions. */
const PIXELS_X = 512
const PIXELS_Y = Math.round((PIXELS_X * LENGTH) / WIDTH)
/** How much of the print the digits may fill. */
const FILL = 0.96
/** The space between two digits, and the edge round them, as shares of the font's size. */
const SPACING = 0.14
const EDGE = 0.1

/** The generic families, which go unquoted. */
const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"])
/**
 * The HUD's label face as a canvas font. Pixi quotes the names in `hudLabelFont` in place once
 * a text has used it, so they are taken as they come, quoted or not.
 */
const font = (px: number): string =>
  `700 ${px}px ${hudLabelFont
    .map((name) => name.replace(/^["']|["']$/g, ""))
    .map((name) => (generic.has(name) ? name : `"${name}"`))
    .join(", ")}`

export const createRaceNumber = (body: Container3D) => {
  const element = document.createElement("canvas")
  element.width = PIXELS_X
  element.height = PIXELS_Y
  const context = element.getContext("2d")
  if (context === null) throw new Error("No 2D canvas")
  // Mipmapped: the roof is a few pixels across at the game's zoom, and the digits stay clean there.
  const texture = new Texture({ source: new CanvasSource({ resource: element, autoGenerateMipmaps: true }) })
  const material = new Material3D({ baseColorTexture: texture, alphaMode: "blend", roughness: 0.38 })
  // The plane lies in XY facing +Z; laid flat facing up, the digits' top points at the nose.
  const plane = new Mesh3D({
    geometry: new PlaneGeometry({ width: WIDTH, height: LENGTH }),
    material,
    position: AT,
    rotation: { x: -Math.PI / 2, y: 0, z: 0 },
    castShadow: false,
    receiveShadow: true,
    parent: body
  })
  plane.visible = false
  let drawn: number | null = null

  /** The digits' widths, the whole row's (spaced), and their height, at `px`. */
  const measure = (digits: ReadonlyArray<string>, px: number) => {
    context.font = font(px)
    const widths = digits.map((digit) => context.measureText(digit).width)
    const all = context.measureText(digits.join(""))
    const edge = EDGE * px
    return {
      widths,
      wide: widths.reduce((sum, width) => sum + width, 0) + SPACING * px * (digits.length - 1) + edge,
      tall: all.actualBoundingBoxAscent + all.actualBoundingBoxDescent + edge,
      ascent: all.actualBoundingBoxAscent,
      descent: all.actualBoundingBoxDescent
    }
  }

  const draw = (rank: number): void => {
    const digits = [...String(rank)]
    context.clearRect(0, 0, PIXELS_X, PIXELS_Y)
    context.textAlign = "left"
    context.textBaseline = "alphabetic"
    // As big as the print takes, by the digits' own measured size, spaced apart.
    const probe = measure(digits, 100)
    const px = Math.floor(100 * Math.min((PIXELS_X * FILL) / probe.wide, (PIXELS_Y * FILL) / probe.tall))
    const sized = measure(digits, px)
    const baseline = PIXELS_Y / 2 + (sized.ascent - sized.descent) / 2
    const edge = EDGE * px
    // Laid on the roof, the plane's left is the car's right (+X is the car's left): drawn mirrored, it reads true.
    context.save()
    context.setTransform(-1, 0, 0, 1, PIXELS_X, 0)
    const pass = (paint: (digit: string, x: number) => void): void => {
      let x = (PIXELS_X - (sized.wide - edge)) / 2
      digits.forEach((digit, i) => {
        paint(digit, x)
        x += (sized.widths[i] ?? 0) + SPACING * px
      })
    }
    context.lineJoin = "round"
    context.lineWidth = edge
    context.strokeStyle = css(look.edge)
    pass((digit, x) => context.strokeText(digit, x, baseline))
    context.fillStyle = css(look.fill)
    pass((digit, x) => context.fillText(digit, x, baseline))
    context.restore()
    texture.source.update()
    texture.source.updateMipmaps()
  }

  return {
    /** Paints the player's place on the roof, or takes it off. */
    show(rank: number | null): void {
      const shown = shownRank(rank)
      if (shown === drawn) return
      drawn = shown
      plane.visible = shown !== null
      if (shown === null) return
      draw(shown)
      // Drawn before the face had loaded, the digits were in a stand-in: drawn again once it is in.
      const face = font(100)
      if (!document.fonts.check(face, String(shown))) {
        void document.fonts.load(face, String(shown)).then(() => {
          if (drawn === shown) draw(shown)
        }, () => {})
      }
    }
  }
}
