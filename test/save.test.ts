/**
 * A race saves and loads: a snapshot taken in the middle of a lap survives JSON, restores
 * into another runtime as the same race, and both then play on the same.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { botInput } from "../src/sim/bot.ts"
import { Car, Game, Input, Lap, Obstacles, ReadView, SteeringMode, makeRuntime, update } from "../src/sim/game.ts"
import type { DriveIntent } from "../src/sim/game.ts"
import { tracks } from "../src/sim/track/index.ts"

const Saved = Game.Inspector(
  "Race/Saved",
  {
    resources: {
      input: Game.System.readResource(Input),
      steering: Game.System.readResource(SteeringMode),
      car: Game.System.readResource(Car),
      lap: Game.System.readResource(Lap),
      obstacles: Game.System.readResource(Obstacles)
    }
  },
  ({ resources }) => ({ input: resources.input.get(), steering: resources.steering.get(), car: resources.car.get(), lap: resources.lap.get(), obstacles: resources.obstacles.get() })
)

test("a race saved mid-lap loads back the same, and plays on the same", () => {
  const entry = tracks[0]
  assert.ok(entry !== undefined)
  let asked: DriveIntent = { input: { throttle: 0, brake: 0, steer: 0, aim: null, restart: false }, steering: "screen" }
  const source = { snapshot: () => asked }
  const runtime = makeRuntime(entry.data, "screen", source)
  const drive = (target: ReturnType<typeof makeRuntime>, ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      asked = { input: botInput(target.inspect(ReadView), entry.data), steering: "screen" }
      assert.ok(target.tick(update).ok)
    }
  }
  // Straight off the line with the wheel held over until something has been shoved, then
  // on with the bot until a split is on the clock: a save with every kind of state in it.
  for (let i = 0; i < 3000 && runtime.inspect(Saved).obstacles.props.every((prop) => !prop.awake); i++) {
    asked = { input: { throttle: 1, brake: 0, steer: 0, aim: { x: -1, z: -0.4 }, restart: false }, steering: "screen" }
    assert.ok(runtime.tick(update).ok)
  }
  for (let i = 0; i < 4000 && runtime.inspect(Saved).lap._tag !== "running"; i++) drive(runtime, 1)
  for (let i = 0; i < 6000; i++) {
    const lap = runtime.inspect(Saved).lap
    if (lap._tag === "running" && lap.splitsMs.length >= 1) break
    drive(runtime, 1)
  }
  drive(runtime, 40)
  const before = runtime.inspect(Saved)
  assert.ok(before.lap._tag === "running" && before.lap.splitsMs.length >= 1, "no split yet")
  assert.ok(before.obstacles.props.some((prop, index) => prop.x !== entry.data.props[index]?.x), "no prop has moved")

  const saved = runtime.snapshot()
  assert.ok(saved.ok, JSON.stringify(saved))
  const text = JSON.stringify(saved.value)

  // A fresh runtime, steered the other way and standing on the line, becomes the saved race.
  const copy = makeRuntime(entry.data, "car", source)
  const restored = copy.restore(JSON.parse(text))
  assert.ok(restored.ok, JSON.stringify(restored))
  assert.deepEqual(copy.inspect(Saved), before)
  assert.deepEqual(copy.inspect(ReadView), runtime.inspect(ReadView))

  // The same input from here gives the same race in both: the bot reads one and both are ticked with it.
  for (let i = 0; i < 1500; i++) {
    asked = { input: botInput(runtime.inspect(ReadView), entry.data), steering: "screen" }
    assert.ok(runtime.tick(update).ok)
    assert.ok(copy.tick(update).ok)
  }
  assert.deepEqual(copy.inspect(Saved), runtime.inspect(Saved))
  assert.deepEqual(copy.inspect(ReadView), runtime.inspect(ReadView))
})
