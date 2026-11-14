# Prototype

## The question

Does driving one fast lap of a track you can see whole, with jumps you must hit at speed and walls that cost time, make the player press restart for another go?

Since round 4 the obstacles are part of the question: are things you can knock about, and that stay knocked about, more fun to drive through than things that only cost time?

## Variants (in `src/sim/tuning.ts`, switched in the game)

- Steering relative to the car, or relative to the screen.
- Grip: how much the car slides.

## Rounds

| round | what was tried | verdict (the human's words) |
|---|---|---|
| 1 | First playable: the Spindle Leap track, three handling variants (`car`, `car-loose`, `screen`), ghost, sectors, medals | "The bottom-right curve may be broken, it puts me off screen while I am still on (I cannot go beyond it)." Asked for gamepad support, acceleration a little slower, and more juice in the car on acceleration, curves, hits and speed up. |
| 2 | Banked hairpin fixed (a wall touch there launched the car and reset the lap) and its bank lowered; gamepad named on screen, analog triggers, rumble; slower acceleration; body lean, squash and stretch, launch dust, speed streaks, hit flashes. Screen shake on hits tried and removed ("too much"). | "My first impression is that commands are a little hard, and the car is hard to control" |
| 3 | Forgiving handling: the car turns much harder at speed and a held turn slows it by itself (a driver who never lifts went from 10 hard wall hits a lap to 1 in `scripts/novice.ts`); stronger boost before the jump. Steering named in plain words on screen; point-where-to-go steering fixed on the keyboard (down is a direction, space brakes, arrows follow the track's grid). | "This work better." Asked to show a little more of what PixiJS 3D can do; for the boxes to "stick in the map, not explode"; to drop the timed gate ("the stick that, when down, just blocks you (too much luck into that)") for other obstacles with collisions, with the track reconsidered around them; and reported broken rendering around the spiral and its bridge. |
| 4 | Nothing on a timer any more. Props the car shoves and that stay where they stop (a crate wall two high with barrels, cones, three heavy balls that roll on), a slalom of fixed posts in slanted fences, swing doors pushed open in place of the gate; the road widened around each. Render faults at the crossings fixed and some living scenery added. | "This works." Asked to clean up the visuals: make the map the focus (as large as the screen fits), a little less text, and a more appealing UI inspired by a racing-management game's dark timing panels. |
| 5 | Looks only. The camera picks the turn that shows the board largest and the HUD lies over its corners; one dark timing panel (clock, best, sectors with the current one lit, next medal), a speed bar, controls as key caps that hide while racing, messages and the result at the bottom. | |
