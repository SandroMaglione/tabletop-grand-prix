/**
 * Random driving on the real schedule, checked against the invariants after every tick. The
 * fuzzer feeds the same input source the page and the replays use; a failure prints the
 * shrunk input. A second test lets the bot drive whole laps with a shaking hand, so the
 * invariants are also checked on the far side of the track that random driving never reaches.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { HostClock } from "@typeonce/ritmo"
import { Fuzz, Invariant, type Replay } from "@typeonce/ritmo-devtools"
import { botInput } from "../src/sim/bot.ts"
import { Car, CourseService, DriveSource, Game, Lap, Obstacles, ReadView, makeDebugRuntime, makeRuntime, update } from "../src/sim/game.ts"
import type { DriveIntent } from "../src/sim/game.ts"
import { STEERINGS } from "../src/sim/schema.ts"
import { fixtureTrack, tracks } from "../src/sim/track/index.ts"
import { broken } from "./invariants.ts"

const World = Game.Inspector(
  "Race/World",
  {
    resources: { car: Game.System.readResource(Car), lap: Game.System.readResource(Lap), obstacles: Game.System.readResource(Obstacles) },
    services: { course: Game.System.service(CourseService) }
  },
  ({ resources, services }) => ({ track: services.course.track, car: resources.car.get(), lap: resources.lap.get(), obstacles: resources.obstacles.get() })
)
const Holds = Invariant.fromInspector(
  Game.Inspector(
    "Race/Holds",
    {
      resources: { car: Game.System.readResource(Car), lap: Game.System.readResource(Lap), obstacles: Game.System.readResource(Obstacles) },
      services: { course: Game.System.service(CourseService) }
    },
    ({ resources, services }) => broken({ track: services.course.track, car: resources.car.get(), lap: resources.lap.get(), obstacles: resources.obstacles.get() })
  )
)

for (const steering of STEERINGS) {
  for (const track of [fixtureTrack, ...tracks.map((entry) => entry.data)]) {
    test(`fuzz: random driving keeps the race's invariants (${track.name}, ${steering} steering)`, () => {
      // A clumsy player: mostly on the throttle, the wheel held one way for a moment, a stab of brake, a restart now and then.
      let held = 0
      let until = 0
      const drivers = Fuzz.input(DriveSource, {
        generate: (random, frame): DriveIntent => {
          if (frame >= until) {
            held = random.integer(-1, 2)
            until = frame + random.integer(5, 90)
          }
          const angle = random.range(0, Math.PI * 2)
          return {
            input: {
              throttle: random.next() < 0.85 ? 1 : 0,
              brake: random.next() < 0.06 ? 1 : 0,
              steer: held,
              aim: random.next() < 0.9 ? { x: Math.sin(angle), z: Math.cos(angle) } : null,
              restart: random.next() < 0.0004
            },
            steering
          }
        },
        neutral: { input: { throttle: 0, brake: 0, steer: 0, aim: null, restart: false }, steering }
      })
      const make = (playback: Replay.Playback) => {
        const hostClock = HostClock.test()
        return { runtime: makeDebugRuntime(track, steering, playback.source(DriveSource), { hostClock }), schedules: { update }, hostClock }
      }
      const found = Fuzz.run(make, { schedule: "update", inputs: [drivers], invariants: [Holds], frames: 4000, runs: 3, seed: 11 })
      if (!found.ok) assert.fail(JSON.stringify(found.error._tag === "Found" ? { violation: found.error.violation, frame: found.error.frame, seed: found.error.seed } : found.error))
    })
  }
}

test("the bot with a shaking hand drives whole laps and the invariants hold on every tick", () => {
  for (const entry of tracks) {
    for (const steering of STEERINGS) {
      let asked: DriveIntent = { input: { throttle: 0, brake: 0, steer: 0, aim: null, restart: false }, steering }
      const runtime = makeRuntime(entry.data, steering, { snapshot: () => asked })
      let laps = 0
      let wasFinished = false
      for (let tick = 0; tick < 150 * 120; tick++) {
        const view = runtime.inspect(ReadView)
        const bot = botInput(view, entry.data)
        const shake = (((tick * 2654435761) >>> 0) / 4294967296 - 0.5) * 1.4
        const finished = view.lap.phase === "finished"
        if (finished && !wasFinished) laps += 1
        wasFinished = finished
        asked = { input: { ...bot, steer: Math.max(-1, Math.min(1, bot.steer + shake)), restart: finished }, steering }
        const ticked = runtime.tick(update)
        assert.ok(ticked.ok, JSON.stringify(ticked))
        const found = broken(runtime.inspect(World))
        assert.equal(found, undefined, `${entry.id}, ${steering} steering, tick ${tick}: ${found}`)
      }
      assert.ok(laps >= 2, `${entry.id}, ${steering} steering: only ${laps} laps in 150 s`)
    }
  }
})
