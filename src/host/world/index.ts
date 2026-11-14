/**
 * The static world: the table, the terrain slab with the road carved into it, ramps and
 * embankments, bridges, painted lines, scenery. Everything is generated from the track's
 * samples, so any `TrackData` works.
 *
 * The static part draws in four meshes: the table, the terrain and everything built along
 * the road (matte, vertex coloured), the paint (a little smoother), and the scenery (flat
 * shaded). Three pieces show more of what PixiJS 3D does, each checked under the game's
 * orthographic camera:
 * - a pond in the widest open infield (`pond.ts`): glossy water whose ripples are a shader
 *   bit, and reeds as one `BatchedMesh3D` swaying in a vertex bit with per-slot phases;
 * - wind turbines along the back (`turbines.ts`) whose rotors turn on `update`, so their
 *   shadows sweep the grass, with emissive warning lamps (they glow under the stage's
 *   optional bloom).
 */
import { Container3D, Material3D, Mesh3D, PlaneGeometry } from "@pixi/3d"
import type { TrackData } from "../../sim/index.ts"
import type { Stage, TrackScene } from "../contract.ts"
import { palette } from "../palette.ts"
import { CAMERA_ELEVATION_DEG, CAMERA_YAW_DEG, SUN_ELEVATION_DEG, SUN_YAW_DEG } from "../stage.ts"
import { MeshBuilder } from "./builder.ts"
import { slabBox } from "./dimensions.ts"
import { createField } from "./field.ts"
import { buildWater, placePond, withPond } from "./pond.ts"
import { buildRoad } from "./road.ts"
import { buildScenery } from "./scenery.ts"
import { buildTerrain } from "./terrain.ts"
import { buildTurbines } from "./turbines.ts"

export const createTrackScene = (stage: Stage, track: TrackData): TrackScene => {
  const slab = slabBox(track)
  const roadField = createField(track)
  const pond = placePond(roadField, slab)
  const field = withPond(roadField, pond)

  const ground = new MeshBuilder()
  buildTerrain(field, slab, ground, pond)
  const paint = new MeshBuilder()
  buildRoad(field, track, ground, paint)
  const scenery = new MeshBuilder()
  const yaw = (CAMERA_YAW_DEG * Math.PI) / 180
  const elevation = (CAMERA_ELEVATION_DEG * Math.PI) / 180
  const sunYaw = (SUN_YAW_DEG * Math.PI) / 180
  const sunElevation = (SUN_ELEVATION_DEG * Math.PI) / 180
  const turbines = buildTurbines(field, slab, {
    towardX: Math.sin(yaw),
    towardZ: Math.cos(yaw),
    reachPerHeight: 1 / Math.tan(elevation),
    shadowX: -Math.sin(sunYaw),
    shadowZ: -Math.cos(sunYaw),
    shadowPerHeight: 1 / Math.tan(sunElevation)
  })
  buildScenery(field, track, slab, { towardX: Math.sin(yaw), towardZ: Math.cos(yaw), reachPerHeight: 1 / Math.tan(elevation) }, scenery, turbines.spots)

  const root = new Container3D({ label: "world" })
  stage.world.addChild(root)

  // The pale table the model stands on, wide enough to fill the view on any window.
  const span = Math.max(slab.maxX - slab.minX, slab.maxZ - slab.minZ) * 12
  root.addChild(
    new Mesh3D({
      label: "table",
      geometry: new PlaneGeometry({ width: span, height: span }),
      material: new Material3D({ baseColor: palette.table, roughness: 1, metallic: 0 }),
      rotation: { x: -Math.PI / 2, y: 0, z: 0 },
      position: { x: (slab.minX + slab.maxX) / 2, y: slab.bottom, z: (slab.minZ + slab.maxZ) / 2 },
      castShadow: false
    })
  )
  root.addChild(
    new Mesh3D({
      label: "terrain and road",
      geometry: ground.geometry(),
      material: new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.96, metallic: 0 })
    })
  )
  root.addChild(
    new Mesh3D({
      label: "paint",
      geometry: paint.geometry(),
      material: new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.7, metallic: 0 }),
      castShadow: false
    })
  )
  root.addChild(
    new Mesh3D({
      label: "scenery",
      geometry: scenery.geometry(),
      material: new Material3D({ baseColor: 0xffffff, vertexColors: true, roughness: 0.9, metallic: 0, flatShading: true })
    })
  )

  if (pond !== null) root.addChild(buildWater(pond, field, track))
  root.addChild(turbines.root)

  return {
    update(_view, seconds) {
      turbines.update(seconds)
    }
  }
}
