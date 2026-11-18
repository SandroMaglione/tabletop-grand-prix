/**
 * The player's standing on the board, as the car shows it: gold, silver and bronze for the
 * podium, the game's own red for the rest of the top five, a blue pearl for the rest of the top
 * ten, a dull grey below that, and the place itself printed on the roof while it has two
 * digits at most. A player with no place on the board (not yet, or offline) keeps the red.
 */

export const standings = ["first", "second", "third", "top-five", "top-ten", "field", "unplaced"] as const
export type Standing = (typeof standings)[number]

/** The standing of a place on the board (1 is the fastest), or of having none. */
export const standingOf = (rank: number | null): Standing =>
  rank === null || rank < 1
    ? "unplaced"
    : rank === 1
      ? "first"
      : rank === 2
        ? "second"
        : rank === 3
          ? "third"
          : rank <= 5
            ? "top-five"
            : rank <= 10
              ? "top-ten"
              : "field"

/** The place printed on the car: up to 99, none past it. */
export const shownRank = (rank: number | null): number | null => (rank !== null && rank >= 1 && rank <= 99 ? Math.floor(rank) : null)
