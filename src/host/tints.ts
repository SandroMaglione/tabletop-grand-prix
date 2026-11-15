/**
 * The colours of the extra ghosts (the field): each its own, hues a golden angle apart so
 * neighbours never match, starting away from the raced ghost's blue and the car's red.
 */

/** An HSL colour as 0xRRGGBB (hue in degrees, the rest 0 to 1). */
const hsl = (h: number, s: number, l: number): number => {
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return (channel(0) << 16) | (channel(8) << 8) | channel(4)
}

/** The tint of the field's `index`th ghost. */
export const fieldTint = (index: number): number => hsl((95 + index * 137.508) % 360, 0.7, 0.6)

/** As CSS. */
export const fieldTintCss = (index: number): string => `#${fieldTint(index).toString(16).padStart(6, "0")}`
