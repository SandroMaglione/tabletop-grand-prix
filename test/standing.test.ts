/** The player's standing as the car shows it: the paint for each place, and the number on the roof up to two digits. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { shownRank, standingOf } from "../src/host/standing.ts"

test("the podium, the top five, the top ten and everyone else each get their paint", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 10, 11, 99, 100].map(standingOf),
    ["first", "second", "third", "top-five", "top-five", "top-ten", "top-ten", "field", "field", "field"]
  )
  assert.equal(standingOf(null), "unplaced")
  assert.equal(standingOf(0), "unplaced")
})

test("the roof shows places up to 99, and none without a place", () => {
  assert.deepEqual([1, 9, 10, 99, 100, 2000].map(shownRank), [1, 9, 10, 99, null, null])
  assert.equal(shownRank(null), null)
  assert.equal(shownRank(0), null)
})
