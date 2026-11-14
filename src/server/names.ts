/**
 * What the server makes of a name, past its shape (`src/api/names.ts`): the folded form two
 * names are compared by, and whether the name is kept back or refused.
 */
import { nameShape, tidyName } from "../api/names.ts"
import { anywhere, innocent, reservedAnywhere, reservedWhole, whole } from "./blocklist.ts"

/** Letters that are not split into a letter and an accent, written as plain letters. */
const ligatures: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ð: "d", ł: "l", ı: "i", þ: "th", ħ: "h", ŧ: "t" }

/**
 * Characters that read as another letter. Digits are what people swap in ("s4ndr0"); `l`,
 * `1` and `i` are one letter because they are hard to tell apart in many fonts; the Cyrillic
 * and Greek letters that look like Latin ones read as those.
 */
const lookAlike: Record<string, string> = {
  "0": "o",
  "1": "i",
  l: "i",
  "2": "z",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "9": "g",
  // Cyrillic
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  // Greek
  α: "a",
  β: "b",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x"
}

/**
 * A name as it is compared: lowercase, without accents, with look-alike characters as the
 * letter they look like, and nothing but letters and digits. "Sandro", "s4ndr0" and
 * "S a n d r o" all fold to "sandro". `l`, `1` and `i` all fold to `i` ("Paolo" is "paoio"):
 * the folded form is for comparing, never for showing.
 */
export const foldName = (name: string): string => {
  let out = ""
  for (const character of name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()) {
    const plain = ligatures[character] ?? character
    for (const letter of plain) out += lookAlike[letter] ?? letter
  }
  return out.replace(/[^\p{L}\p{N}]/gu, "")
}

/** A word as a pattern on folded names: each letter may be repeated ("fuuuck"), a doubled letter at least twice. */
const pattern = (word: string): string => {
  const folded = foldName(word)
  let source = ""
  for (let at = 0; at < folded.length; ) {
    const letter = folded[at] ?? ""
    let run = 1
    while (folded[at + run] === letter) run++
    source += run === 1 ? `${letter}+` : `${letter}{${run},}`
    at += run
  }
  return source
}

const anyOf = (words: ReadonlyArray<string>): string => words.map(pattern).join("|")

const blockedAnywhere = new RegExp(anyOf(anywhere), "u")
/** A whole word, plural or not. */
const blockedWhole = new RegExp(`^(?:${anyOf(whole)})s*$`, "u")
const keptAnywhere = new RegExp(anyOf(reservedAnywhere), "u")
const keptWhole = new RegExp(`^(?:${anyOf(reservedWhole)})$`, "u")
const innocentWords = innocent.map(foldName).sort((a, b) => b.length - a.length)

/** The words of a name: split at spaces, dashes, underscores, dots, and where a capital follows a small letter. */
const wordsOf = (name: string): ReadonlyArray<string> => name.split(/[ ._-]+|(?<=\p{Ll})(?=\p{Lu})/u).filter((word) => word.length > 0)

/** A word with and without the digits after it ("dick69" is "dick"), folded. */
const forms = (word: string): ReadonlyArray<string> => {
  const bare = word.replace(/\p{N}+$/u, "")
  return bare.length > 0 && bare !== word ? [foldName(word), foldName(bare)] : [foldName(word)]
}

/** Whether a tidied name is one the server refuses to show. */
export const isBlocked = (name: string): boolean => {
  let folded = foldName(name)
  for (const word of innocentWords) folded = folded.split(word).join("|")
  if (blockedAnywhere.test(folded)) return true
  const candidates = [...forms(name.replace(/[ ._-]+/g, "")), ...wordsOf(name).flatMap(forms)]
  return candidates.some((candidate) => blockedWhole.test(candidate))
}

/** Whether a tidied name could pass for the game, its makers or the server. */
export const isReserved = (name: string): boolean => {
  const folded = foldName(name)
  if (keptAnywhere.test(folded)) return true
  return forms(name.replace(/[ ._-]+/g, "")).some((candidate) => keptWhole.test(candidate))
}

export type NameVerdict =
  | { readonly ok: true; readonly name: string; readonly folded: string }
  | { readonly ok: false; readonly reason: "length" | "characters" | "reserved" | "blocked" }

/** Everything the server decides about a name before it asks who has it. */
export const judgeName = (raw: string): NameVerdict => {
  const name = tidyName(raw)
  const shape = nameShape(name)
  if (shape !== "ok") return { ok: false, reason: shape }
  if (isBlocked(name)) return { ok: false, reason: "blocked" }
  if (isReserved(name)) return { ok: false, reason: "reserved" }
  return { ok: true, name, folded: foldName(name) }
}
