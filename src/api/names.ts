/**
 * What a player's name may look like. The game uses this to answer while the player types;
 * the server uses the same rules and then its own (names already taken, names it refuses),
 * which the game learns by asking.
 */

export const nameMinLength = 3
export const nameMaxLength = 16

/** A name as it is kept: no space at either end, single spaces inside. */
export const tidyName = (name: string): string => name.trim().replace(/\s+/g, " ")

/** Letters, digits, and a space, dash, underscore or dot between them. */
const allowed = /^[\p{L}\p{N}]+(?:[ ._-][\p{L}\p{N}]+)*$/u

/**
 * Whether a tidied name has the right shape: `length` when it is too short or too long,
 * `characters` when it holds something other than letters and digits joined by single
 * spaces, dashes, underscores or dots.
 */
export const nameShape = (name: string): "ok" | "length" | "characters" => {
  const length = Array.from(name).length
  if (length < nameMinLength || length > nameMaxLength) return "length"
  return allowed.test(name) ? "ok" : "characters"
}
