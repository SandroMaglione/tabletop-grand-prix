/**
 * Sizes of the scale model that the stage and the world both need: how far the slab
 * reaches past the track and how deep it is. The stage fits its camera to the slab, so
 * both read the box from here.
 */
import type { TrackData } from "../../sim/index.ts"

/** Grass beyond the track's bounds on every side, in metres. Room for trees and the grandstand. */
export const SLAB_MARGIN = 4.5
/** Packed earth below the lowest road, down to the table. */
export const SLAB_DEPTH_BELOW_ROAD = 2.2
/** Tallest thing the scenery puts on the slab, for fitting the camera. */
export const SCENERY_HEIGHT = 5

export interface SlabBox {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  /** Underside of the slab, where it stands on the table. */
  readonly bottom: number
  /** Highest point of the model (parapets or scenery). */
  readonly top: number
}

export const slabBox = (track: TrackData): SlabBox => {
  let lowest = 0
  for (const sample of track.samples) lowest = Math.min(lowest, sample.y)
  const { minX, maxX, minZ, maxZ, maxY } = track.bounds
  return {
    minX: minX - SLAB_MARGIN,
    maxX: maxX + SLAB_MARGIN,
    minZ: minZ - SLAB_MARGIN,
    maxZ: maxZ + SLAB_MARGIN,
    bottom: lowest - SLAB_DEPTH_BELOW_ROAD,
    top: Math.max(maxY, track.wallHeight + SCENERY_HEIGHT)
  }
}
