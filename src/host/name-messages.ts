/**
 * What the name field says while the player types, and after the board answers: a few
 * words for each refusal, and whether the name may be saved.
 */
import { nameMaxLength, nameMinLength, nameShape, tidyName } from "../api/names.ts"
import type { NameAnswer } from "./online.ts"

export interface NameStatus {
  readonly text: string
  readonly tone: "dim" | "good" | "bad"
  /** The name can be sent to be saved. */
  readonly canSave: boolean
}

/**
 * The answer the page can give at once, from the name's shape. Null when the shape is fine
 * and only the board can tell (taken, kept back).
 */
export const shapeStatus = (raw: string, current: string | null): NameStatus | null => {
  const name = tidyName(raw)
  if (name === "") return { text: `${nameMinLength} TO ${nameMaxLength} LETTERS OR DIGITS`, tone: "dim", canSave: false }
  if (current !== null && name === current) return { text: "THAT IS YOUR NAME NOW", tone: "dim", canSave: false }
  switch (nameShape(name)) {
    case "length":
      return Array.from(name).length < nameMinLength
        ? { text: `TOO SHORT: AT LEAST ${nameMinLength}`, tone: "bad", canSave: false }
        : { text: `TOO LONG: AT MOST ${nameMaxLength}`, tone: "bad", canSave: false }
    case "characters":
      return { text: "ONLY LETTERS, DIGITS AND ONE . - _ OR SPACE BETWEEN", tone: "bad", canSave: false }
    case "ok":
      return null
  }
}

export const checking: NameStatus = { text: "CHECKING…", tone: "dim", canSave: true }
export const saving: NameStatus = { text: "SAVING…", tone: "dim", canSave: false }

/** The board's answer. */
export const answerStatus = (answer: NameAnswer): NameStatus => {
  switch (answer.kind) {
    case "ok":
      return { text: "FREE", tone: "good", canSave: true }
    case "taken":
      return { text: "TAKEN: TRY ANOTHER", tone: "bad", canSave: false }
    case "refused":
      return answer.reason === "reserved"
        ? { text: "THAT NAME IS KEPT BACK", tone: "bad", canSave: false }
        : answer.reason === "blocked"
          ? { text: "THAT NAME IS NOT ALLOWED", tone: "bad", canSave: false }
          : answer.reason === "length"
            ? { text: `${nameMinLength} TO ${nameMaxLength} CHARACTERS`, tone: "bad", canSave: false }
            : { text: "ONLY LETTERS, DIGITS AND ONE . - _ OR SPACE BETWEEN", tone: "bad", canSave: false }
    case "limited":
      return { text: `TOO MANY TRIES: WAIT ${Math.max(1, answer.seconds)} S`, tone: "bad", canSave: false }
    case "unavailable":
      // The board may be back in a moment: saving is still worth a try.
      return { text: "CAN'T REACH THE BOARD: TRY LATER", tone: "bad", canSave: true }
  }
}
