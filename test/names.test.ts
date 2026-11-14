/**
 * Names on the server: the folded form two names are compared by, the names kept back, and
 * the words refused without catching the innocent words that contain them.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { foldName, judgeName } from "../src/server/names.ts"

const verdict = (name: string): string => {
  const judged = judgeName(name)
  return judged.ok ? "ok" : judged.reason
}

test("names that read the same fold the same", () => {
  for (const same of ["Sandro", "s4ndr0", "S a n d r o", "SANDRO", "Sándro", "s-a-n-d-r-o", "S.andro", "ѕаndrо"]) assert.equal(foldName(same), foldName("Sandro"), same)
  assert.equal(foldName("Ilaria"), foldName("1laria"))
  assert.equal(foldName("Ilaria"), foldName("llaria"))
  assert.equal(foldName("Straße"), foldName("Strasse"))
  assert.notEqual(foldName("Sandro"), foldName("Sandra"))
  assert.notEqual(foldName("Sandro"), foldName("Sandroo"))
})

test("the shape comes first, as the game checks it", () => {
  assert.equal(verdict("ab"), "length")
  assert.equal(verdict("a".repeat(17)), "length")
  assert.equal(verdict("no!pe"), "characters")
  assert.equal(verdict("  Lap   King  "), "ok")
  const tidied = judgeName("  Lap   King  ")
  assert.ok(tidied.ok && tidied.name === "Lap King")
})

test("names that could pass for the game or its makers are kept back", () => {
  for (const name of ["admin", "Admin42", "4dmin", "the_official", "Moderator", "PixiJS", "pixi", "ritmo", "TypeOnce", "Anonymous", "staff", "Player1", "null"]) {
    assert.equal(verdict(name), "reserved", name)
  }
  for (const name of ["Modena", "Staffordshire", "Pixie", "Ritmonia", "Playerone"]) assert.equal(verdict(name), "ok", name)
})

test("slurs and profanity are refused, however they are written", () => {
  for (const name of [
    "fuck",
    "FUCK",
    "f.u.c.k",
    "fuuuuck",
    "fvck",
    "MotherFucker",
    "shit",
    "5h1t",
    "bullshit",
    "nigger",
    "n1gg3r",
    "faggot",
    "cunt",
    "Big Dick",
    "BigDick",
    "dick69",
    "d1ck",
    "ass",
    "a55",
    "Tits",
    "cazzo",
    "c4zz0",
    "Vaffanculo",
    "stronzo",
    "porcodio",
    "Porco Dio",
    "minchia",
    "puttana",
    "coglione",
    "troia",
    "culo",
    "frocio",
    "Hitler",
    "nazi88"
  ]) {
    assert.equal(verdict(name), "blocked", name)
  }
})

test("innocent words that contain a refused one pass", () => {
  for (const name of [
    "Scunthorpe",
    "Montenegro",
    "Negroni",
    "Niger",
    "Snigger",
    "Shiitake",
    "Dickens",
    "Cocktail",
    "Peacock",
    "Hancock",
    "Therapist",
    "Grape",
    "Assassin",
    "Bassist",
    "Classic",
    "Cucumber",
    "Document",
    "Raccoon",
    "Sussex",
    "Essex",
    "Japan",
    "Analyst",
    "Shoemaker",
    "Pacifica",
    "Magnifica",
    "Verifica",
    "Figaro",
    "Calcolo",
    "Ridicolo",
    "Nazionale",
    "Speedo",
    "Torpedo",
    "Pedro",
    "Fukuoka",
    "Porco Rosso",
    "Sandro",
    "Giulia",
    "Ilaria"
  ]) {
    assert.equal(verdict(name), "ok", name)
  }
})
