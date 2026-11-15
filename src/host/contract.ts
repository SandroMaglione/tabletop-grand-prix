/**
 * How the parts of the page fit together. Each part is one module with one `create`
 * function; `main.ts` wires them. Nothing here changes the simulation: every part reads
 * `RaceView` and `RaceEvent` and draws.
 *
 * | part    | module                  | function            |
 * | ------- | ----------------------- | ------------------- |
 * | stage   | `src/host/stage.ts`     | `createStage`       |
 * | world   | `src/host/world/index.ts`  | `createTrackScene` |
 * | actors  | `src/host/actors/index.ts` | `createActors`     |
 */
import type { Container3D, View3D } from "@pixi/3d"
import type { Application } from "pixi.js"
import type { RaceEvent, RaceView } from "../sim/index.ts"

/** The Pixi application, its one 3D view, and the fixed camera that shows the whole track. */
export interface Stage {
  readonly app: Application
  readonly view: View3D
  /** Parent of everything in the scene. Add to this, never to `view.root` (it holds the camera). */
  readonly world: Container3D
  /** For labs and scripts (the trailer): look at a point up close, or with null at the whole track again. */
  focusOn(focus: { readonly x: number; readonly y?: number; readonly z: number; readonly zoom: number } | null): void
  /**
   * A direction on screen (x to the right, y down) as a direction on the ground, for
   * screen-relative steering. The result is normalized; (0, 0) gives (0, 0).
   */
  groundDirection(screenX: number, screenY: number): { x: number; z: number }
}

/** The terrain, the road carved into it, walls, ramps, bridges, scenery, light. Static, except what it chooses to animate. */
export interface TrackScene {
  /** Once per drawn frame. */
  update(view: RaceView, seconds: number): void
}

/** Where the ghost car is this frame. */
export interface GhostPose {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yaw: number
  readonly pitch: number
  readonly roll: number
  /** How solid to draw it, 0 to 1 (`ghostFade`): faded near the car and once its lap is over. 1 when left out. */
  readonly fade?: number
}

/** Everything that moves: the car, the ghost, crates, boost pads, gates, particles, skid marks. */
export interface Actors {
  /** Each simulation event, in order, before the frame's `update`. */
  handle(event: RaceEvent, view: RaceView): void
  /** Once per drawn frame. `ghost` is null when there is no best lap to show. */
  update(view: RaceView, ghost: GhostPose | null, seconds: number): void
}
