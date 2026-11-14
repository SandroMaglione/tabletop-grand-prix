# Tabletop Grand Prix

A solo time-attack racer made to show PixiJS 3D (`@pixi/3d`) with a game built on `@typeonce/ritmo`.

## The game

- The whole track is on screen, always. One fixed camera, from above and a little to the side.
- You drive one car. Every attempt starts standing just behind the start line; the clock starts when the car first moves and stops when it crosses the line after every checkpoint, in order.
- You cannot leave the road: both edges are walls. The car slides along a wall and loses speed; it never stops dead.
- Jumps are the one place without walls. Land on the jump's own landing and carry on; come down anywhere else, the road under the jump included, and the attempt starts again from the line. `R` restarts at once.
- The goal is the fastest lap. A ghost of your best lap drives with you, three sectors show where you gained or lost, and three medal times give targets.

## Driving

- Two ways to steer, switched with `V` (select on a gamepad) and named on screen:
  - **like a car**: up is gas, left and right turn the wheel, down or space brakes.
  - **point where to go**: hold the direction to drive toward; the car turns to it and goes. Space brakes. The arrow keys follow the track's grid (the roads run about 20 degrees off the screen's axes); a gamepad stick follows the screen exactly.
- The car forgives: a turn that is held slows the car by itself, so holding the throttle through a corner settles at a speed the corner can take instead of running wide into the wall. Lifting or braking before the corner and a clean line are still faster.
- The boost pad before the jump is strong enough that a car driven flat out through the spiral clears the gap; a wall hit on the way out of the spiral can still leave it short.

## The track's features

| feature | rule |
|---|---|
| Jump over a lower part of the track | A ramp, a gap with no road and no walls, a landing. Too slow and you fall short: reset. |
| Spiral climb | The road climbs around a full turn and passes over itself on a bridge deck. |
| Banked turn | The surface tilts into the corner; the car holds more speed. |
| Crate wall | Crates stacked two high block most of the road, with barrels behind. The car shoves them: they slide, spin and fall off each other, and stay where they stop. Ploughing through costs speed by how much it moves; there is a gap to thread. |
| Slalom | Three slanted fences of fixed posts, each closing one side of the road in turn. A post never moves; hitting one costs speed and turns the car round it. |
| Balls | Heavy balls standing in the road, with a lane between them. A ball that is hit rolls a long way, off walls and into whatever is ahead. |
| Swing doors | Two leaves hinged at the walls meet in the middle. The car pushes them open; near the free ends they cost little, near a hinge they are almost a wall. They stay open. |
| Boost pad | Pushes the car while it is on it. One sits before the jump. |

Nothing on the track runs on a timer: every obstacle is where the player left it, so a lap is only as good as the driving. Everything the car knocked about goes back when the attempt restarts.

## Scale

- Units are metres. The car is about 2.4 long and 1.3 wide. The road is about 6.5 wide.
- The track fits a footprint of about 100 by 60 so the car is roughly 2.5% of the screen's width.
- Top speed is about 30 m/s; a lap is 20 to 30 seconds.
- The simulation runs at 120 ticks per second. The finish time is exact to the line crossing inside the tick and shown to a thousandth.

## The look

A solid scale model on a pale table, not a flat map.

- The terrain is one thick slab with grass on top. The road is **carved into it**: a channel with real side faces of packed earth, so every edge of the track reads as depth. Those faces are the walls.
- Ramps, embankments and the spiral are **solid masses** that rise out of the slab, with the road's channel continuing on top. A jump's ramp ends in a cliff. A bridge is a deck on pillars with the lower road visible beneath.
- Real materials and daylight: matte asphalt with painted lines, red and white kerbs, concrete, wooden crates. A sun that casts soft shadows (the car's shadow in the air shows where it will land), ambient occlusion in the channels, a light tilt-shift.
- An ink outline on the car and on what can be hit, nothing else.
- The map is the picture: the camera turns a little (6 to 20 degrees) to whatever shows the board largest in the window. The HUD is a few small dark panels over the board's corners, white text and one yellow accent, like a race broadcast's timing screen: the timing panel top left, the speed bottom right, the controls as key caps bottom left (hidden while racing), messages and the result bottom centre.
- Colours are in `src/host/palette.ts`. Change them there.

## How the code is laid out

- `src/sim`: the simulation, headless, on ritmo. `types.ts` is the contract the page reads; `track/` is the track data and the queries on it; `tuning.ts` holds the handling variants.
- `src/host`: the page. `contract.ts` names its parts: `stage.ts` (Pixi app, view, camera), `world/` (terrain, road, scenery, light), `actors/` (car, ghost, crates, pads, gates, particles, skid marks), and `main.ts` with input, HUD, sound and the ghost.
- The page reads the simulation only through `src/sim/index.ts`.
- `PROTOTYPE.md` puts the game in prototype mode: see the `ritmo-prototype` skill.
